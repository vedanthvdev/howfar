/**
 * Client-side budget tracker — counts billable Google Maps calls per
 * calendar month and trips a soft circuit-breaker once estimated spend
 * crosses the user-configured cap.
 *
 * Ported from backend/src/utils/budget.ts but rebuilt around chrome.storage.local
 * (the SW has no filesystem). Reservation is still synchronous and atomic
 * with the trip check — Chrome runs SW message handlers single-threaded, so
 * a run of synchronous ops on `state` is effectively a critical section.
 *
 * The user is paying their own Google bill, so the cap is now a personal
 * speed-bump (not a service-side safeguard). Default cap is $180 — about 90%
 * of Google's $200/mo free credit, leaving headroom for the user's other
 * projects on the same key.
 */
(function (root) {
  const STORAGE_KEY = "wdfBudget";
  const DEFAULT_CAP_USD = 180;
  // Google's published list price for both Geocoding and Directions is
  // $5 / 1000 calls = $0.005 / call. Bake it in here rather than reading from
  // settings — it's a flat constant the user shouldn't have to configure.
  const PRICE_GEOCODE = 0.005;
  const PRICE_DIRECTIONS = 0.005;

  function currentMonth() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  function emptyState() {
    return {
      month: currentMonth(),
      counts: { geocode: 0, directions: 0 },
      tripped: false,
      trippedReason: null,
    };
  }

  class BudgetExceededError extends Error {
    constructor(message) {
      super(message);
      this.name = "BudgetExceededError";
      this.code = "quota_exhausted";
    }
  }

  class BudgetTracker {
    constructor(opts = {}) {
      this._state = emptyState();
      this._cap = Number.isFinite(opts.cap) && opts.cap > 0 ? opts.cap : DEFAULT_CAP_USD;
      this._writeQueue = Promise.resolve();
      this._lastPersistError = null;
      this._hydrated = false;
    }

    /**
     * Read prior state from chrome.storage. Idempotent — safe to call from
     * multiple SW entry points; the first call wins, subsequent ones are no-ops.
     * Callers should `await tracker.init()` once before any reserve/usage call.
     */
    async init() {
      if (this._hydrated) return;
      this._hydrated = true;
      try {
        const stored = await chrome.storage.local.get(STORAGE_KEY);
        const saved = stored?.[STORAGE_KEY];
        if (saved && typeof saved === "object" && this._isValid(saved)) {
          this._state = saved;
        }
        if (typeof saved?.cap === "number" && saved.cap > 0) {
          this._cap = saved.cap;
        }
      } catch {
        // Storage unavailable — start fresh.
      }
      this._rollIfMonthChanged();
    }

    /**
     * Update the cap. Persists immediately so reservations honour the new value.
     * If the new cap is below current spend the breaker trips immediately, so
     * the UI can't display "100%" while still happily reserving calls. If the
     * user raises the cap above current spend, the breaker untrips — they made
     * an explicit decision to allow more spend, no separate "reset" required.
     * The counters themselves are never touched here.
     */
    async setCap(usd) {
      if (!Number.isFinite(usd) || usd <= 0) return;
      this._cap = usd;
      const spend = this._estimateUsd();
      if (spend >= this._cap) {
        this._state.tripped = true;
        this._state.trippedReason = `Estimated monthly Google Maps spend reached the $${this._cap.toFixed(2)} cap.`;
      } else if (this._state.tripped) {
        this._state.tripped = false;
        this._state.trippedReason = null;
      }
      await this._save();
    }

    cap() {
      return this._cap;
    }

    usage() {
      this._rollIfMonthChanged();
      const estimatedUsd = this._estimateUsd();
      const percent =
        this._cap > 0 ? Math.min(100, (estimatedUsd / this._cap) * 100) : 0;
      return {
        month: this._state.month,
        counts: { ...this._state.counts },
        estimatedUsd,
        cap: this._cap,
        tripped: this._state.tripped,
        trippedReason: this._state.trippedReason,
        percent,
        persistError: this._lastPersistError,
      };
    }

    /** Pre-flight check. Throws BudgetExceededError if the breaker is tripped. */
    ensureAvailable() {
      this._rollIfMonthChanged();
      if (this._state.tripped) {
        throw new BudgetExceededError(
          this._state.trippedReason ?? "Monthly budget exhausted."
        );
      }
    }

    /**
     * Atomically reserve one billable call. Increments + trip-check + decision
     * happen synchronously, so concurrent reservers can't race past the cap.
     * Persists in the background — callers never await the disk write.
     */
    reserveCall(kind, count = 1) {
      this._rollIfMonthChanged();
      if (this._state.tripped) {
        throw new BudgetExceededError(
          this._state.trippedReason ?? "Monthly budget exhausted."
        );
      }
      this._state.counts[kind] = (this._state.counts[kind] ?? 0) + count;
      if (this._estimateUsd() >= this._cap) {
        this._state.tripped = true;
        this._state.trippedReason = `Estimated monthly Google Maps spend reached the $${this._cap.toFixed(2)} cap.`;
      }
      void this._save();
    }

    /** Refund a reservation only if you're sure the call never reached Google. */
    releaseCall(kind, count = 1) {
      const current = this._state.counts[kind] ?? 0;
      if (current > 0) {
        this._state.counts[kind] = Math.max(0, current - count);
        // Deliberately do NOT untrip — once flipped, only an explicit reset
        // should clear it. That's the safe direction.
        void this._save();
      }
    }

    /** Trip the breaker explicitly (e.g. Google returned OVER_QUERY_LIMIT). */
    async trip(reason) {
      if (this._state.tripped && this._state.trippedReason === reason) return;
      this._state.tripped = true;
      this._state.trippedReason = reason;
      await this._save();
    }

    /** Clear the breaker and zero the counter — use after raising the cap. */
    async reset() {
      this._state = emptyState();
      await this._save();
    }

    _estimateUsd() {
      const c = this._state.counts;
      return (c.geocode ?? 0) * PRICE_GEOCODE + (c.directions ?? 0) * PRICE_DIRECTIONS;
    }

    _rollIfMonthChanged() {
      const now = currentMonth();
      if (this._state.month !== now) {
        this._state = emptyState();
      }
    }

    _save() {
      const snapshot = {
        ...this._state,
        cap: this._cap,
      };
      this._writeQueue = this._writeQueue.then(async () => {
        try {
          await chrome.storage.local.set({ [STORAGE_KEY]: snapshot });
          this._lastPersistError = null;
        } catch (err) {
          this._lastPersistError = err?.message ?? String(err);
        }
      });
      return this._writeQueue;
    }

    _isValid(v) {
      if (!v || typeof v !== "object") return false;
      const counts = v.counts;
      return (
        typeof v.month === "string" &&
        counts &&
        typeof counts.geocode === "number" &&
        typeof counts.directions === "number" &&
        typeof v.tripped === "boolean"
      );
    }
  }

  root.WDFBudget = Object.freeze({
    BudgetTracker,
    BudgetExceededError,
    DEFAULT_CAP_USD,
    PRICE_GEOCODE,
    PRICE_DIRECTIONS,
  });
})(typeof self !== "undefined" ? self : globalThis);

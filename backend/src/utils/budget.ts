import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

/** The kinds of billable requests we make. Pricing is configured per kind. */
export type CallKind = "geocode" | "directions";

export interface BudgetConfig {
  /** Absolute path to the JSON file storing the counter. */
  filePath: string;
  /** Hard cap in USD. When estimated spend reaches this, requests stop. */
  monthlyUsdCap: number;
  /** Dollar cost Google bills per call, per kind. Used to estimate spend. */
  pricing: Record<CallKind, number>;
  /**
   * Optional admin token required by mutating budget endpoints. If
   * undefined, one is generated on first run and persisted alongside the
   * counter; callers can also read it back for display.
   */
  adminTokenFromEnv?: string;
}

export interface BudgetUsage {
  month: string;
  counts: Record<CallKind, number>;
  estimatedUsd: number;
  cap: number;
  tripped: boolean;
  trippedReason: string | null;
  percent: number;
  /** Non-null iff the last persist attempt failed. Surfaced to clients. */
  persistError: string | null;
}

interface BudgetState {
  month: string;
  counts: Record<CallKind, number>;
  tripped: boolean;
  trippedReason: string | null;
  /**
   * Self-generated admin token. Written on first init if no env token is
   * provided, so restarts remain authenticated. `null` when an env token is
   * explicitly configured.
   */
  autoAdminToken: string | null;
}

function emptyState(): BudgetState {
  return {
    month: currentMonth(),
    counts: { geocode: 0, directions: 0 },
    tripped: false,
    trippedReason: null,
    autoAdminToken: null,
  };
}

export class BudgetExceededError extends Error {
  readonly code = "quota_exhausted";
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

/**
 * Tracks estimated Google Maps spend per calendar month and short-circuits
 * requests when we approach the $200 free-tier ceiling (or a lower
 * user-configured cap).
 *
 * Reservation is **synchronous** and must happen before the fetch:
 * `reserveCall` increments the counter + flips the tripped flag atomically
 * (Node is single-threaded, so a run of synchronous operations on the same
 * state is effectively a critical section). Persistence is kicked off in the
 * background so we never await disk under a hot fetch path.
 *
 * If the network call never actually reaches Google (connection error, TLS
 * failure, DNS, etc.) the caller can `releaseCall` to refund the estimate.
 * Post-response failures are NOT refunded: Google may still bill for
 * partially-processed requests, and being conservative is the safer default.
 */
export class BudgetTracker {
  private state: BudgetState = emptyState();
  private writeQueue: Promise<void> = Promise.resolve();
  private lastPersistError: string | null = null;

  constructor(private readonly config: BudgetConfig) {}

  async init(): Promise<void> {
    try {
      const raw = await fs.readFile(this.config.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (isValidState(parsed)) this.state = parsed;
    } catch {
      // File missing or unreadable — start fresh.
    }
    this.rollIfMonthChanged();

    // Ensure we always have an admin token available. If the operator set
    // BUDGET_ADMIN_TOKEN, use that and don't persist it. Otherwise we
    // generate one and write it to .budget.json so restarts stay stable.
    if (!this.config.adminTokenFromEnv && !this.state.autoAdminToken) {
      this.state.autoAdminToken = randomBytes(24).toString("hex");
      void this.save();
    }
  }

  /** Token required on mutating budget endpoints. Prefers env. */
  adminToken(): string {
    return this.config.adminTokenFromEnv ?? this.state.autoAdminToken ?? "";
  }

  /** True if the operator passed BUDGET_ADMIN_TOKEN via env. */
  hasEnvAdminToken(): boolean {
    return Boolean(this.config.adminTokenFromEnv);
  }

  usage(): BudgetUsage {
    this.rollIfMonthChanged();
    const estimatedUsd = this.estimateUsd();
    const { month, counts, tripped, trippedReason } = this.state;
    const percent =
      this.config.monthlyUsdCap > 0
        ? Math.min(100, (estimatedUsd / this.config.monthlyUsdCap) * 100)
        : 0;
    return {
      month,
      counts: { ...counts },
      estimatedUsd,
      cap: this.config.monthlyUsdCap,
      tripped,
      trippedReason,
      percent,
      persistError: this.lastPersistError,
    };
  }

  /** Pre-flight check. Throws if the breaker is already tripped. */
  ensureAvailable(): void {
    this.rollIfMonthChanged();
    if (this.state.tripped) {
      throw new BudgetExceededError(
        this.state.trippedReason ?? "Monthly budget exhausted."
      );
    }
  }

  /**
   * Atomically reserve one billable call. Increments the counter *before* the
   * fetch goes out, and trips the breaker immediately if this call crosses
   * the cap. The increment + trip check + snapshot all run synchronously, so
   * concurrent reservations can't race past the cap.
   *
   * Throws `BudgetExceededError` if the breaker is already tripped — callers
   * should propagate this up so the route returns 429.
   */
  reserveCall(kind: CallKind, count = 1): void {
    this.rollIfMonthChanged();
    if (this.state.tripped) {
      throw new BudgetExceededError(
        this.state.trippedReason ?? "Monthly budget exhausted."
      );
    }
    this.state.counts[kind] += count;
    if (this.estimateUsd() >= this.config.monthlyUsdCap) {
      this.state.tripped = true;
      this.state.trippedReason = `Estimated monthly Google Maps spend reached the ${this.formatCap()} cap.`;
    }
    // Persist is kicked off async; callers never await.
    void this.save();
  }

  /**
   * Refund a previously-reserved call. Use this only for failures that we
   * are confident never reached Google (connection errors, DNS, TLS). Do
   * not use for HTTP errors or parse failures — Google may have billed us.
   */
  releaseCall(kind: CallKind, count = 1): void {
    if (this.state.counts[kind] > 0) {
      this.state.counts[kind] = Math.max(0, this.state.counts[kind] - count);
      // We deliberately do NOT untrip here — once the breaker's flipped,
      // only an explicit reset should clear it. That's the safe direction.
      void this.save();
    }
  }

  /** Trip the breaker for a known-bad reason (e.g. Google returned OVER_QUERY_LIMIT). */
  async trip(reason: string): Promise<void> {
    if (this.state.tripped && this.state.trippedReason === reason) return;
    this.state.tripped = true;
    this.state.trippedReason = reason;
    await this.save();
  }

  /**
   * Test-only: resolves when every persistence write queued **at call time**
   * has settled. Saves chained onto `writeQueue` *after* this returns are
   * not awaited — if a test needs to wait on those, call `flushWrites()`
   * again. Production callers never need this; persistence is fire-and-forget.
   */
  async flushWrites(): Promise<void> {
    await this.writeQueue;
  }

  /** Clear the breaker and zero the counter — use after raising your cap or rotating keys. */
  async reset(): Promise<void> {
    const preservedToken = this.state.autoAdminToken;
    this.state = emptyState();
    // Keep the admin token across resets — rotating it would invalidate the
    // extension's stored copy unexpectedly.
    this.state.autoAdminToken = preservedToken;
    await this.save();
  }

  private estimateUsd(): number {
    return (
      this.state.counts.geocode * this.config.pricing.geocode +
      this.state.counts.directions * this.config.pricing.directions
    );
  }

  private rollIfMonthChanged(): void {
    const now = currentMonth();
    if (this.state.month !== now) {
      const preservedToken = this.state.autoAdminToken;
      this.state = emptyState();
      this.state.autoAdminToken = preservedToken;
    }
  }

  private formatCap(): string {
    return `$${this.config.monthlyUsdCap.toFixed(2)}`;
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
    const filePath = this.config.filePath;
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, snapshot, "utf8");
        this.lastPersistError = null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.lastPersistError = message;
        // eslint-disable-next-line no-console
        console.warn("[budget] failed to persist:", message);
      }
    });
    return this.writeQueue;
  }
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function isValidState(v: unknown): v is BudgetState {
  if (!v || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  const counts = obj.counts as Record<string, unknown> | undefined;
  const baseOk =
    typeof obj.month === "string" &&
    !!counts &&
    typeof counts.geocode === "number" &&
    typeof counts.directions === "number" &&
    typeof obj.tripped === "boolean";
  if (!baseOk) return false;
  // Older files may not have autoAdminToken; default it in-place.
  if (!("autoAdminToken" in obj) || obj.autoAdminToken === undefined) {
    (obj as Record<string, unknown>).autoAdminToken = null;
  }
  return true;
}

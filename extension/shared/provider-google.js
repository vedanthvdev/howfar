/**
 * Google Maps provider — direct caller, no backend.
 *
 * Ported from backend/src/providers/google.ts so the SW talks to Google
 * itself using the user's own API key. Parity with the backend version is
 * deliberate; if you change one, mirror the other.
 *
 * Layered behaviour:
 *   resolveBaseAddress   — single geocode for the user's "home"
 *   resolveCandidates    — fan-out geocodes for page addresses
 *   getDistances         — fan-out directions per (destination, mode)
 *
 * Budget:
 *   Every fetch is reserved synchronously *before* the call. Network errors
 *   refund the reservation (we know Google didn't bill us). HTTP/parse
 *   errors don't — Google may have charged for the partial request, so we
 *   stay conservative.
 *
 * The user is paying their own bill, so quota/billing errors trip the
 * breaker locally and surface to the UI as a paused state. Cache hits keep
 * working through a pause; only fresh addresses get the paused marker.
 */
(function (root) {
  const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
  const DIRECTIONS_URL = "https://maps.googleapis.com/maps/api/directions/json";

  const QUOTA_STATUSES = new Set([
    "OVER_QUERY_LIMIT",
    "OVER_DAILY_LIMIT",
    "REQUEST_DENIED",
    "BILLING_NOT_ENABLED",
  ]);
  const QUOTA_HTTP_STATUS = new Set([403, 429]);

  const MODE_TO_GOOGLE = {
    walk: "walking",
    drive: "driving",
    cycle: "bicycling",
  };

  class ProviderError extends Error {
    constructor(kind, message) {
      super(message);
      this.name = "ProviderError";
      this.kind = kind;
    }
  }

  // Default request timeout — tuned for Google Maps APIs over residential
  // wifi. Long enough to absorb the worst-case TLS handshake on a slow
  // network, short enough that captive portals and dead networks fail loudly
  // instead of leaving the wizard or popup stuck on "Validating…".
  const FETCH_TIMEOUT_MS = 12000;

  function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { signal: controller.signal })
      .catch((err) => {
        // Surface a clearer message for the timeout case so callers don't
        // have to special-case AbortError everywhere.
        if (err && err.name === "AbortError") {
          throw new Error(
            `Google Maps did not respond within ${Math.round(timeoutMs / 1000)}s. Check your network connection.`
          );
        }
        throw err;
      })
      .finally(() => clearTimeout(timer));
  }

  function buildClient({ apiKey, budget, format }) {
    if (!apiKey) {
      throw new Error("provider-google: apiKey is required");
    }
    const { formatDistance, formatDuration } = format ?? root.WDFFormat ?? {};
    if (typeof formatDistance !== "function" || typeof formatDuration !== "function") {
      throw new Error("provider-google: format helpers missing");
    }
    const { BudgetExceededError } = root.WDFBudget ?? {};
    if (!BudgetExceededError) {
      throw new Error("provider-google: WDFBudget not loaded");
    }

    async function tripFromHttp(status, kind) {
      const reason = `Google HTTP ${status} on ${kind} — quota or billing limit.`;
      if (budget) {
        await budget.trip(reason);
        throw new BudgetExceededError(reason);
      }
      throw new Error(reason);
    }

    async function checkQuotaStatus(status, errorMessage) {
      if (!QUOTA_STATUSES.has(status)) return;
      const reason = errorMessage
        ? `Google quota/billing error (${status}): ${errorMessage}`
        : `Google quota/billing error (${status}).`;
      if (budget) {
        await budget.trip(reason);
        throw new BudgetExceededError(reason);
      }
      throw new Error(reason);
    }

    async function geocode(address) {
      budget?.reserveCall("geocode");
      const url = `${GEOCODE_URL}?address=${encodeURIComponent(address)}&key=${encodeURIComponent(apiKey)}`;
      let res;
      try {
        res = await fetchWithTimeout(url);
      } catch (err) {
        // Network never reached Google (DNS, TLS, timeout) — refund.
        budget?.releaseCall("geocode");
        throw err;
      }
      if (QUOTA_HTTP_STATUS.has(res.status)) await tripFromHttp(res.status, "geocode");
      if (!res.ok) throw new Error(`Geocoding HTTP ${res.status}`);
      const data = await res.json();
      await checkQuotaStatus(data.status, data.error_message);
      return data;
    }

    async function directions(base, dest, googleMode, units) {
      budget?.reserveCall("directions");
      const origin = `${base.lat},${base.lng}`;
      const destination = `${dest.lat},${dest.lng}`;
      const url =
        `${DIRECTIONS_URL}?origin=${origin}` +
        `&destination=${destination}` +
        `&mode=${googleMode}` +
        `&units=${units === "imperial" ? "imperial" : "metric"}` +
        `&key=${encodeURIComponent(apiKey)}`;
      let res;
      try {
        res = await fetchWithTimeout(url);
      } catch (err) {
        budget?.releaseCall("directions");
        throw err;
      }
      if (QUOTA_HTTP_STATUS.has(res.status)) await tripFromHttp(res.status, "directions");
      if (!res.ok) {
        return { status: "error", error: `Directions HTTP ${res.status}` };
      }
      const data = await res.json();
      await checkQuotaStatus(data.status, data.error_message);
      if (data.status === "ZERO_RESULTS") return { status: "no_route" };
      if (data.status !== "OK" || !Array.isArray(data.routes) || data.routes.length === 0) {
        return { status: "error", error: data.error_message ?? data.status };
      }
      const leg = data.routes[0]?.legs?.[0];
      if (!leg || !leg.distance || !leg.duration) {
        return { status: "error", error: "missing leg data" };
      }
      return {
        status: "ok",
        distanceMeters: leg.distance.value,
        durationSec: leg.duration.value,
        displayDistance: formatDistance(leg.distance.value, units),
        displayDuration: formatDuration(leg.duration.value),
      };
    }

    async function resolveBaseAddress(input) {
      budget?.ensureAvailable();
      const data = await geocode(input);
      if (data.status === "ZERO_RESULTS" || !data.results?.length) {
        throw new ProviderError("not_found", `No match for "${input}"`);
      }
      if (data.status !== "OK") {
        throw new ProviderError("error", data.error_message ?? data.status);
      }
      const r = data.results[0];
      return {
        formattedAddress: r.formatted_address,
        lat: r.geometry.location.lat,
        lng: r.geometry.location.lng,
        placeId: r.place_id,
      };
    }

    async function resolveCandidates(inputs) {
      budget?.ensureAvailable();
      return Promise.all(
        inputs.map(async (c) => {
          try {
            const data = await geocode(c.text);
            if (data.status === "ZERO_RESULTS" || !data.results?.length) {
              return { id: c.id, status: "not_found" };
            }
            if (data.status !== "OK") {
              return {
                id: c.id,
                status: "error",
                error: data.error_message ?? data.status,
              };
            }
            const first = data.results[0];
            const ambiguous = data.results.length > 1 || first.partial_match === true;
            return {
              id: c.id,
              status: ambiguous ? "ambiguous" : "ok",
              formattedAddress: first.formatted_address,
              lat: first.geometry.location.lat,
              lng: first.geometry.location.lng,
              placeId: first.place_id,
            };
          } catch (err) {
            // A breaker trip mid-batch should surface as a paused result so
            // the popup renders the correct "throttled, not broken" pill.
            if (err instanceof BudgetExceededError) {
              return {
                id: c.id,
                status: "paused",
                error: err.message,
              };
            }
            return {
              id: c.id,
              status: "error",
              error: err instanceof Error ? err.message : String(err),
            };
          }
        })
      );
    }

    async function getDistances(base, destinations, modes, units) {
      budget?.ensureAvailable();
      const results = destinations.map((d) => ({
        id: d.id,
        status: d.status,
        formattedAddress: d.formattedAddress,
        modes: {},
        error: d.error,
      }));

      const tasks = [];
      destinations.forEach((d, i) => {
        const routable =
          (d.status === "ok" || d.status === "ambiguous") &&
          typeof d.lat === "number" &&
          typeof d.lng === "number";
        if (!routable) return;
        for (const mode of modes) {
          const googleMode = MODE_TO_GOOGLE[mode];
          if (!googleMode) continue;
          tasks.push(
            directions(base, d, googleMode, units)
              .then((outcome) => {
                results[i].modes[mode] = outcome;
              })
              .catch((err) => {
                if (err instanceof BudgetExceededError) {
                  results[i].modes[mode] = {
                    status: "paused",
                    error: err.message,
                  };
                  return;
                }
                results[i].modes[mode] = {
                  status: "error",
                  error: err instanceof Error ? err.message : String(err),
                };
              })
          );
        }
      });
      await Promise.all(tasks);

      // Promote walking distance (or any successful mode's distance) to the
      // top-level fields so compact UIs can show one canonical number.
      for (const r of results) {
        const walk = r.modes.walk;
        if (walk?.status === "ok" && walk.distanceMeters !== undefined) {
          r.distanceMeters = walk.distanceMeters;
          r.displayDistance = walk.displayDistance;
        } else {
          for (const m of Object.values(r.modes)) {
            if (m?.status === "ok" && m.distanceMeters !== undefined) {
              r.distanceMeters = m.distanceMeters;
              r.displayDistance = m.displayDistance;
              break;
            }
          }
        }
      }

      // If every mode for a still-ok destination ended up paused (mid-batch
      // breaker trip), downgrade the destination so the popup renders the
      // throttled state instead of a "?" pill.
      for (const r of results) {
        if (r.status !== "ok" && r.status !== "ambiguous") continue;
        const modeEntries = Object.values(r.modes);
        if (modeEntries.length === 0) continue;
        if (modeEntries.every((m) => m?.status === "paused")) {
          r.status = "paused";
          r.error = modeEntries[0]?.error ?? "Monthly budget exhausted.";
        }
      }

      return results;
    }

    /**
     * Lightweight key check — does NOT consume the budget tracker. We hit
     * the geocoding endpoint with a known-good address and report what
     * Google says. Used by the wizard's validation step.
     */
    async function validateKey() {
      const url = `${GEOCODE_URL}?address=${encodeURIComponent("Buckingham Palace")}&key=${encodeURIComponent(apiKey)}`;
      const res = await fetchWithTimeout(url);
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          reason: `HTTP ${res.status}`,
        };
      }
      const data = await res.json();
      if (data.status === "OK") return { ok: true };
      return {
        ok: false,
        status: data.status,
        reason: data.error_message ?? data.status,
      };
    }

    return {
      resolveBaseAddress,
      resolveCandidates,
      getDistances,
      validateKey,
    };
  }

  root.WDFProviderGoogle = Object.freeze({ buildClient, ProviderError });
})(typeof self !== "undefined" ? self : globalThis);

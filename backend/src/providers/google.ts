import type {
  BaseLocation,
  Candidate,
  DistanceProvider,
  DistanceResult,
  ModeOutcome,
  ResolvedCandidate,
  TravelMode,
  Units,
} from "./types";
import { formatDistance, formatDuration } from "../utils/format";
import { BudgetExceededError, BudgetTracker } from "../utils/budget";

/** Google status values that indicate we've exhausted quota or been denied. */
const QUOTA_STATUSES = new Set([
  "OVER_QUERY_LIMIT",
  "OVER_DAILY_LIMIT",
  "REQUEST_DENIED",
  "BILLING_NOT_ENABLED",
]);

/** HTTP status codes from Google that should trip the breaker hard. */
const QUOTA_HTTP_STATUS = new Set([403, 429]);

interface GoogleGeocodeResponse {
  status: string;
  results: Array<{
    formatted_address: string;
    place_id: string;
    geometry: { location: { lat: number; lng: number } };
    partial_match?: boolean;
  }>;
  error_message?: string;
}

interface GoogleDirectionsResponse {
  status: string;
  routes: Array<{
    legs: Array<{
      distance: { value: number };
      duration: { value: number };
    }>;
  }>;
  error_message?: string;
}

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const DIRECTIONS_URL = "https://maps.googleapis.com/maps/api/directions/json";

const MODE_TO_GOOGLE: Record<TravelMode, "walking" | "driving" | "bicycling"> = {
  walk: "walking",
  drive: "driving",
  cycle: "bicycling",
};

export class GoogleDistanceProvider implements DistanceProvider {
  constructor(
    private readonly apiKey: string,
    private readonly budget?: BudgetTracker
  ) {
    if (!apiKey) throw new Error("GoogleDistanceProvider requires an API key");
  }

  async resolveBaseAddress(input: string): Promise<BaseLocation> {
    this.budget?.ensureAvailable();
    const data = await this.geocode(input);
    if (data.status === "ZERO_RESULTS" || data.results.length === 0) {
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

  async resolveCandidateAddresses(inputs: Candidate[]): Promise<ResolvedCandidate[]> {
    // Pre-flight: if the breaker is already tripped when we start, fail
    // fast and let the route mark everything as paused. If it trips *during*
    // the fan-out, individual candidates surface an error status and the
    // route checks tracker state after the batch to decide if this was a
    // partial-pause.
    this.budget?.ensureAvailable();
    return Promise.all(
      inputs.map(async (c): Promise<ResolvedCandidate> => {
        try {
          const data = await this.geocode(c.text);
          if (data.status === "ZERO_RESULTS" || data.results.length === 0) {
            return { id: c.id, status: "not_found" };
          }
          if (data.status !== "OK") {
            return { id: c.id, status: "error", error: data.error_message ?? data.status };
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
          return {
            id: c.id,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          };
        }
      })
    );
  }

  async getDistances(
    base: BaseLocation,
    destinations: ResolvedCandidate[],
    modes: TravelMode[],
    units: Units
  ): Promise<DistanceResult[]> {
    this.budget?.ensureAvailable();
    // Build a result skeleton for every destination first.
    const results: DistanceResult[] = destinations.map((d) => ({
      id: d.id,
      status: d.status,
      formattedAddress: d.formattedAddress,
      modes: {},
      error: d.error,
    }));

    // Fan out (destination, mode) requests in parallel. We catch each failure
    // inline — including budget-exhaustion from mid-flight trips — so a
    // single quota bounce can't poison the rest of the response. The route
    // layer inspects the tracker afterwards (`budget.usage().tripped`) to
    // decide whether to flag the response as paused.
    const tasks: Array<Promise<void>> = [];
    destinations.forEach((d, i) => {
      const routable =
        (d.status === "ok" || d.status === "ambiguous") &&
        typeof d.lat === "number" &&
        typeof d.lng === "number";
      if (!routable) return;

      for (const mode of modes) {
        tasks.push(
          this.directions(base, d, MODE_TO_GOOGLE[mode], units)
            .then((outcome) => {
              results[i].modes[mode] = outcome;
            })
            .catch((err: unknown) => {
              // Uniform per-leg handling — `paused` vs `error` is decided at
              // the route/UI layer based on tracker state, not per call.
              results[i].modes[mode] = {
                status: "error",
                error: err instanceof Error ? err.message : String(err),
              };
            })
        );
      }
    });
    await Promise.all(tasks);

    // Promote walking distance (or, failing that, any mode's distance) to the
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

    return results;
  }

  private async geocode(address: string): Promise<GoogleGeocodeResponse> {
    // Reserve the call *before* we fetch. Reservation is synchronous and
    // atomic with the trip check, so concurrent geocodes can't sneak past
    // the cap.
    this.budget?.reserveCall("geocode");
    const url = `${GEOCODE_URL}?address=${encodeURIComponent(address)}&key=${this.apiKey}`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      // Network-layer failure: the request never reached Google, refund the
      // estimate so a flaky connection doesn't consume the budget.
      this.budget?.releaseCall("geocode");
      throw err;
    }
    if (QUOTA_HTTP_STATUS.has(res.status)) {
      await this.tripFromHttp(res.status, "geocode");
    }
    if (!res.ok) throw new Error(`Geocoding HTTP ${res.status}`);
    const data = (await res.json()) as GoogleGeocodeResponse;
    await this.checkQuotaStatus(data.status, data.error_message);
    return data;
  }

  private async directions(
    base: BaseLocation,
    dest: ResolvedCandidate,
    googleMode: "walking" | "driving" | "bicycling",
    units: Units
  ): Promise<ModeOutcome> {
    // Same reserve-before-fetch pattern as `geocode`.
    this.budget?.reserveCall("directions");
    const origin = `${base.lat},${base.lng}`;
    const destination = `${dest.lat},${dest.lng}`;
    const url =
      `${DIRECTIONS_URL}?origin=${origin}` +
      `&destination=${destination}` +
      `&mode=${googleMode}&units=${units === "imperial" ? "imperial" : "metric"}` +
      `&key=${this.apiKey}`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      this.budget?.releaseCall("directions");
      throw err;
    }
    if (QUOTA_HTTP_STATUS.has(res.status)) {
      await this.tripFromHttp(res.status, "directions");
    }
    if (!res.ok) {
      return { status: "error", error: `Directions HTTP ${res.status}` };
    }
    const data = (await res.json()) as GoogleDirectionsResponse;
    await this.checkQuotaStatus(data.status, data.error_message);
    if (data.status === "ZERO_RESULTS") return { status: "no_route" };
    if (data.status !== "OK" || data.routes.length === 0) {
      return { status: "error", error: data.error_message ?? data.status };
    }
    const leg = data.routes[0].legs[0];
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

  /**
   * Google returned an HTTP status that looks like a quota/billing problem
   * (429, 403). Trip the breaker so we stop sending requests and throw a
   * budget error that callers can detect.
   */
  private async tripFromHttp(status: number, kind: string): Promise<void> {
    const reason = `Google HTTP ${status} on ${kind} — quota or billing limit.`;
    if (this.budget) {
      await this.budget.trip(reason);
      throw new BudgetExceededError(reason);
    }
    throw new Error(reason);
  }

  /** If Google tells us we're over quota or billing-denied, trip the breaker. */
  private async checkQuotaStatus(
    status: string,
    errorMessage?: string
  ): Promise<void> {
    if (!QUOTA_STATUSES.has(status)) return;
    const reason = errorMessage
      ? `Google quota/billing error (${status}): ${errorMessage}`
      : `Google quota/billing error (${status}).`;
    if (this.budget) {
      await this.budget.trip(reason);
      throw new BudgetExceededError(reason);
    }
    throw new Error(reason);
  }
}

export class ProviderError extends Error {
  constructor(public readonly kind: "not_found" | "error", message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

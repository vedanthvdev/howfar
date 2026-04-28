import type { Request, Response } from "express";
import type {
  BaseLocation,
  Candidate,
  DistanceProvider,
  DistanceResult,
  ResolvedCandidate,
  TravelMode,
  Units,
} from "../providers/types";
import { ALL_MODES } from "../providers/types";
import { TTLCache } from "../utils/cache";
import { normalizeAddress } from "../utils/normalize";
import { BudgetExceededError, BudgetTracker } from "../utils/budget";

interface RequestBody {
  base?: Partial<BaseLocation>;
  /** Legacy single-mode field. Still accepted for backwards compat. */
  mode?: string;
  modes?: string[];
  units?: Units;
  candidates?: Candidate[];
}

const VALID_MODES = new Set<TravelMode>(["walk", "drive", "cycle"]);

function parseModes(body: RequestBody): TravelMode[] | { error: string } {
  let raw: string[] = [];
  if (Array.isArray(body.modes) && body.modes.length > 0) {
    raw = body.modes;
  } else if (typeof body.mode === "string") {
    raw = [body.mode];
  } else {
    return [...ALL_MODES];
  }
  const out: TravelMode[] = [];
  for (const m of raw) {
    if (!VALID_MODES.has(m as TravelMode)) {
      return { error: `Unknown mode "${m}". Valid: walk, drive, cycle.` };
    }
    if (!out.includes(m as TravelMode)) out.push(m as TravelMode);
  }
  return out.length > 0 ? out : [...ALL_MODES];
}

/**
 * Build a placeholder for a candidate we never got to call Google for — the
 * breaker tripped partway through the request. Using the dedicated `paused`
 * status (vs `error`) lets the UI distinguish "skipped because budget, try
 * again after reset" from "Google call actually failed".
 */
function pausedResult(c: Candidate | undefined, reason: string, fallbackIdx: number): DistanceResult {
  return {
    id: c?.id ?? String(fallbackIdx),
    status: "paused",
    error: reason,
    modes: {},
  };
}

export function createResolveDistancesHandler(
  provider: DistanceProvider,
  cache: TTLCache<DistanceResult>,
  maxCandidates: number,
  budget?: BudgetTracker
) {
  return async function resolveDistances(
    req: Request,
    res: Response
  ): Promise<void> {
    const body = (req.body ?? {}) as RequestBody;
    const base = body.base;
    const units: Units = body.units === "metric" ? "metric" : "imperial";

    const modesOrErr = parseModes(body);
    if (!Array.isArray(modesOrErr)) {
      res.status(400).json({ error: modesOrErr.error });
      return;
    }
    const modes = modesOrErr;

    if (
      !base ||
      typeof base.lat !== "number" ||
      typeof base.lng !== "number" ||
      typeof base.placeId !== "string"
    ) {
      res.status(400).json({ error: "base { lat, lng, placeId } is required" });
      return;
    }

    const candidates = Array.isArray(body.candidates) ? body.candidates : [];
    if (candidates.length === 0) {
      res.json({ results: [], modes, paused: false });
      return;
    }
    if (candidates.length > maxCandidates) {
      res
        .status(400)
        .json({ error: `max ${maxCandidates} candidates per request` });
      return;
    }

    // If the breaker was already tripped before we even started, return a
    // full paused response straight away — no partial attempt.
    try {
      budget?.ensureAvailable();
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        res.status(429).json({
          error: err.message,
          code: err.code,
          results: candidates.map((c, i) => pausedResult(c, err.message, i)),
          paused: true,
          pauseReason: err.message,
          modes,
          ...(budget ? { budget: budget.usage() } : {}),
        });
        return;
      }
      throw err;
    }

    const baseFull: BaseLocation = {
      formattedAddress: base.formattedAddress ?? "",
      lat: base.lat,
      lng: base.lng,
      placeId: base.placeId,
    };

    const modeKey = [...modes].sort().join(",");
    const cacheKeyFor = (text: string): string =>
      `dist:${baseFull.placeId}:${normalizeAddress(text)}:${modeKey}:${units}`;

    const results: DistanceResult[] = new Array(candidates.length);
    const toFetch: Candidate[] = [];
    const toFetchIdx: number[] = [];

    candidates.forEach((c, i) => {
      if (!c || typeof c.id !== "string" || typeof c.text !== "string") {
        results[i] = {
          id: c?.id ?? String(i),
          status: "error",
          error: "invalid candidate",
          modes: {},
        };
        return;
      }
      const hit = cache.get(cacheKeyFor(c.text));
      if (hit) {
        results[i] = { ...hit, id: c.id };
      } else {
        toFetch.push(c);
        toFetchIdx.push(i);
      }
    });

    let pauseReason: string | null = null;

    if (toFetch.length > 0) {
      let resolved: ResolvedCandidate[] = [];
      try {
        resolved = await provider.resolveCandidateAddresses(toFetch);
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          pauseReason = err.message;
        } else {
          const message = err instanceof Error ? err.message : String(err);
          res.status(502).json({ error: message });
          return;
        }
      }

      if (resolved.length > 0) {
        let distances: DistanceResult[] = [];
        try {
          distances = await provider.getDistances(
            baseFull,
            resolved,
            modes,
            units
          );
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            pauseReason = err.message;
          } else {
            const message = err instanceof Error ? err.message : String(err);
            res.status(502).json({ error: message });
            return;
          }
        }

        distances.forEach((d, j) => {
          const i = toFetchIdx[j];
          const original = toFetch[j];
          results[i] = d;
          if (d.status === "ok" || d.status === "ambiguous") {
            cache.set(cacheKeyFor(original.text), d);
          }
        });
      }
    }

    // Post-batch trip check: if a parallel leg flipped the breaker partway
    // through the fan-out, the tracker knows — promote any unfilled slots
    // (and any slot with zero successfully-resolved modes) to `paused`.
    const trippedNow = budget?.usage().tripped === true;
    if (trippedNow && !pauseReason) {
      pauseReason =
        budget?.usage().trippedReason ?? "Monthly budget exhausted.";
    }

    if (pauseReason) {
      for (let i = 0; i < results.length; i++) {
        if (results[i] === undefined) {
          results[i] = pausedResult(candidates[i] as Candidate, pauseReason, i);
        }
      }
    } else {
      // No pause — just defend against holes.
      for (let i = 0; i < results.length; i++) {
        if (results[i] === undefined) {
          results[i] = {
            id: (candidates[i] as Candidate)?.id ?? String(i),
            status: "error",
            error: "no result",
            modes: {},
          };
        }
      }
    }

    res.json({
      results,
      modes,
      paused: Boolean(pauseReason),
      ...(pauseReason ? { pauseReason } : {}),
      ...(budget ? { budget: budget.usage() } : {}),
    });
  };
}

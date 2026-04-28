export type Units = "metric" | "imperial";
export type TravelMode = "walk" | "drive" | "cycle";

/**
 * Status describing whether the address itself was resolved.
 *
 * `paused` is emitted by the route layer (not the provider) when the monthly
 * budget breaker trips mid-request: already-fetched candidates keep their
 * real status, remaining candidates are filled in as `paused` so the client
 * can render a distinct "skipped, try again after reset" state instead of a
 * generic error.
 */
export type ResolveStatus =
  | "ok"
  | "ambiguous"
  | "not_found"
  | "error"
  | "paused";

/** Status describing one travel mode's outcome for a resolved address. */
export type ModeStatus = "ok" | "no_route" | "error";

export const ALL_MODES: TravelMode[] = ["walk", "drive", "cycle"];

export interface BaseLocation {
  formattedAddress: string;
  lat: number;
  lng: number;
  placeId: string;
}

export interface Candidate {
  id: string;
  text: string;
}

export interface ResolvedCandidate {
  id: string;
  status: ResolveStatus;
  formattedAddress?: string;
  lat?: number;
  lng?: number;
  placeId?: string;
  error?: string;
}

export interface ModeOutcome {
  status: ModeStatus;
  distanceMeters?: number;
  durationSec?: number;
  displayDistance?: string;
  displayDuration?: string;
  error?: string;
}

export interface DistanceResult {
  id: string;
  status: ResolveStatus;
  formattedAddress?: string;
  modes: Partial<Record<TravelMode, ModeOutcome>>;
  /** Walking distance promoted to top-level for compact UI. */
  distanceMeters?: number;
  displayDistance?: string;
  error?: string;
}

export interface DistanceProvider {
  resolveBaseAddress(input: string): Promise<BaseLocation>;
  resolveCandidateAddresses(inputs: Candidate[]): Promise<ResolvedCandidate[]>;
  getDistances(
    base: BaseLocation,
    destinations: ResolvedCandidate[],
    modes: TravelMode[],
    units: Units
  ): Promise<DistanceResult[]>;
}

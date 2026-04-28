import type { Units } from "../providers/types";

export function formatDistance(meters: number, units: Units): string {
  if (!Number.isFinite(meters) || meters < 0) return "";
  if (units === "imperial") {
    const miles = meters / 1609.344;
    if (miles < 0.1) {
      const feet = Math.round(meters * 3.28084);
      return `${feet} ft`;
    }
    return `${miles.toFixed(miles < 10 ? 1 : 0)} mi`;
  }
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return `${km.toFixed(km < 10 ? 1 : 0)} km`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hours} hr` : `${hours} hr ${rem} min`;
}

/** Short form, e.g. "32m" or "2h 5m" — for dense badges. */
export function formatDurationShort(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
}

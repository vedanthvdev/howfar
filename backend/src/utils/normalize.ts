/**
 * Canonicalize an address-like string for cache keying and dedup.
 * - lowercases
 * - collapses whitespace
 * - strips punctuation that doesn't carry semantic weight
 * - trims
 */
export function normalizeAddress(input: string): string {
  if (!input) return "";
  return input
    .toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D]/g, "")
    .replace(/[.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Stable JSON string for cache keying. Keys are sorted. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

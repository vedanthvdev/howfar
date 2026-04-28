/**
 * Address normalization shared by content scripts and the service worker.
 * Mirrors the backend's normalizer so local cache keys agree with server
 * cache keys.
 */
(function (root) {
  function normalizeAddress(input) {
    if (!input) return "";
    return String(input)
      .toLowerCase()
      .replace(/[\u2018\u2019\u201C\u201D]/g, "")
      .replace(/[.,;:]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Builds the cache key used by the service worker for a resolved distance.
   * Modes is an array; we sort it so the same set always produces the same key
   * regardless of caller order.
   */
  function distanceCacheKey(basePlaceId, rawText, modes, units) {
    const modeKey = Array.isArray(modes) ? [...modes].sort().join(",") : String(modes);
    return `${basePlaceId}|${normalizeAddress(rawText)}|${modeKey}|${units}`;
  }

  root.WDFNormalize = Object.freeze({
    normalizeAddress,
    distanceCacheKey,
  });
})(typeof self !== "undefined" ? self : globalThis);

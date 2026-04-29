/**
 * Distance/duration formatters — ported from backend/src/utils/format.ts so
 * the service worker can render the same display strings without a backend.
 *
 * Plain script so it loads both in content scripts (via manifest) and the
 * service worker (via importScripts).
 */
(function (root) {
  function formatDistance(meters, units) {
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

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    return rem === 0 ? `${hours} hr` : `${hours} hr ${rem} min`;
  }

  root.WDFFormat = Object.freeze({ formatDistance, formatDuration });
})(typeof self !== "undefined" ? self : globalThis);

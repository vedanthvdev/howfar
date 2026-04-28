/**
 * Runtime "type" helpers shared across extension code. JS is untyped at
 * runtime but these JSDoc blocks document the shapes so tooling can pick
 * them up.
 *
 * @typedef {"ok"|"ambiguous"|"not_found"|"error"|"paused"|"loading"} WDFStatus
 *
 * @typedef {Object} WDFBaseLocation
 * @property {string} formattedAddress
 * @property {number} lat
 * @property {number} lng
 * @property {string} placeId
 *
 * @typedef {Object} WDFCandidate
 * @property {string} id
 * @property {string} text
 *
 * @typedef {Object} WDFResult
 * @property {string} id
 * @property {WDFStatus} status
 * @property {string} [formattedAddress]
 * @property {number} [distanceMeters]
 * @property {number} [durationSec]
 * @property {string} [displayDistance]
 * @property {string} [displayDuration]
 * @property {string} [error]
 */
(function (root) {
  root.WDFStatuses = Object.freeze({
    OK: "ok",
    AMBIGUOUS: "ambiguous",
    NOT_FOUND: "not_found",
    /** Mode-level "no route" — only appears inside `result.modes[mode].status`. */
    NO_ROUTE: "no_route",
    ERROR: "error",
    /**
     * Distinct from ERROR: the request never reached Google because the
     * monthly budget tripped. UI should render it as "paused / try after
     * resume" rather than "unavailable".
     */
    PAUSED: "paused",
    LOADING: "loading",
  });
  root.WDFModes = Object.freeze({
    WALK: "walk",
    DRIVE: "drive",
    CYCLE: "cycle",
  });
  root.WDFModeOrder = Object.freeze(["walk", "drive", "cycle"]);
  root.WDFModeIcons = Object.freeze({
    walk: "🚶",
    drive: "🚗",
    cycle: "🚴",
  });
  root.WDFModeLabels = Object.freeze({
    walk: "Walk",
    drive: "Drive",
    cycle: "Cycle",
  });
})(typeof self !== "undefined" ? self : globalThis);

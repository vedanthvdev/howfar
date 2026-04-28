/**
 * Message types exchanged between content scripts, the popup, and the
 * service worker. Plain script so it loads both in content scripts (via
 * manifest) and the service worker (via importScripts).
 */
(function (root) {
  const WDFMessages = Object.freeze({
    // content -> worker
    RESOLVE_CANDIDATES: "WDF_RESOLVE_CANDIDATES",
    // popup -> content (in the active tab)
    RESCAN: "WDF_RESCAN",
    // popup -> worker
    GET_PAGE_RESULTS: "WDF_GET_PAGE_RESULTS",
    GET_BASE: "WDF_GET_BASE",
    SET_BASE: "WDF_SET_BASE",
    CLEAR_BASE: "WDF_CLEAR_BASE",
    GET_BUDGET: "WDF_GET_BUDGET",
    RESET_BUDGET: "WDF_RESET_BUDGET",
    // worker -> popup/options broadcasts
    PAGE_RESULTS_UPDATED: "WDF_PAGE_RESULTS_UPDATED",
    BUDGET_UPDATED: "WDF_BUDGET_UPDATED",
  });

  root.WDFMessages = WDFMessages;
})(typeof self !== "undefined" ? self : globalThis);

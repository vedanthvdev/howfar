/**
 * HowFar — service worker.
 *
 * Owns settings, the short-lived per-(base, address, modes, units) cache,
 * orchestration of /resolve-distances calls, AND the client-side kill switch:
 * when the backend reports that the monthly budget is exhausted (HTTP 429
 * with code "quota_exhausted", or status "paused" entries), we pause all
 * fresh scans to avoid accidentally driving charges past the free tier —
 * but we still serve cache hits so already-resolved addresses keep
 * rendering distances.
 */
importScripts(
  "shared/types.js",
  "shared/normalize.js",
  "shared/messages.js"
);

const MESSAGES = self.WDFMessages;
const STATUSES = self.WDFStatuses;
const MODE_ORDER = self.WDFModeOrder;
const { distanceCacheKey } = self.WDFNormalize;

const DEFAULT_BACKEND = "http://localhost:8787";
const DEFAULT_UNITS = "imperial";
const DEFAULT_MODES = [...MODE_ORDER];
const DEFAULT_ENABLED = true;
const CACHE_TTL_MS = 15 * 60 * 1000;
const BUDGET_POLL_ALARM = "wdf-budget-poll";
const BUDGET_POLL_INTERVAL_MIN = 5;
// First poll fires a little later so we don't race extension startup. 30s is
// enough for the user to land on a real page; earlier polls before anything
// interesting exists are wasted cycles.
const BUDGET_POLL_INITIAL_DELAY_MIN = 0.5;
const BUDGET_STATE_STORAGE_KEY = "wdfBudgetState";
const ADMIN_HEADER = "X-WDF-Admin-Token";

/** @type {Map<string, {value: any, expiresAt: number}>} */
const distCache = new Map();

/** @type {Map<number, {url: string, results: Array<any>}>} */
const pageResultsByTab = new Map();

/**
 * In-memory mirror of the last known budget state so UIs open instantly.
 * Hydrated from chrome.storage.local below so SW respawns (Chrome idles
 * SWs aggressively) don't drop the tripped flag between the last poll and
 * the next one.
 */
let budgetState = {
  tripped: false,
  trippedReason: null,
  estimatedUsd: 0,
  cap: 0,
  percent: 0,
  counts: { geocode: 0, directions: 0 },
  month: "",
  reachable: true,
  error: null,
  lastCheckedAt: 0,
  persistError: null,
};
let budgetStateHydrated = false;

async function hydrateBudgetState() {
  if (budgetStateHydrated) return;
  budgetStateHydrated = true;
  try {
    const stored = await chrome.storage.local.get(BUDGET_STATE_STORAGE_KEY);
    const saved = stored?.[BUDGET_STATE_STORAGE_KEY];
    if (saved && typeof saved === "object") {
      budgetState = { ...budgetState, ...saved };
    }
  } catch {
    // Storage is best-effort; keep defaults on failure.
  }
}

function persistBudgetState() {
  // Fire-and-forget — we never want to block a response on storage.
  chrome.storage.local
    .set({ [BUDGET_STATE_STORAGE_KEY]: budgetState })
    .catch((err) => {
      console.warn("[wdf] persist budget state failed:", err);
    });
}

// Kick off hydration immediately. It's async but callers always await it via
// the wrapper below, so no race.
const hydrationPromise = hydrateBudgetState();

function cacheGet(key) {
  const hit = distCache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    distCache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value) {
  distCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function sanitizeModes(input) {
  if (!Array.isArray(input)) return [...DEFAULT_MODES];
  const allowed = new Set(MODE_ORDER);
  const out = [];
  for (const m of input) {
    if (allowed.has(m) && !out.includes(m)) out.push(m);
  }
  return MODE_ORDER.filter((m) => out.includes(m));
}

async function getSettings() {
  const stored = await chrome.storage.local.get([
    "base",
    "units",
    "backendUrl",
    "modes",
    "adminToken",
    "enabled",
  ]);
  return {
    base: stored.base ?? null,
    units: stored.units ?? DEFAULT_UNITS,
    backendUrl: (stored.backendUrl ?? DEFAULT_BACKEND).replace(/\/$/, ""),
    modes: sanitizeModes(stored.modes),
    adminToken: stored.adminToken ?? "",
    // `enabled` is a master kill switch the user controls from the popup or
    // options page. When false: content scripts tear down badges and stop
    // observing, the SW refuses RESOLVE_CANDIDATES (no API spend), and the
    // budget poller pauses. Default true so first-run UX is unchanged.
    enabled: stored.enabled === undefined ? DEFAULT_ENABLED : Boolean(stored.enabled),
  };
}

async function setSettings(patch) {
  await chrome.storage.local.set(patch);
}

/**
 * Tell every UI surface (popup, options) AND every content script that the
 * enabled flag changed. We address content scripts via tabs.query because
 * runtime.sendMessage doesn't reach them — only same-context listeners.
 *
 * Both sends are best-effort: tabs without our content script (chrome://,
 * about:, restricted origins) reject the message and that's fine.
 */
function broadcastEnabled(enabled) {
  chrome.runtime
    .sendMessage({ type: MESSAGES.ENABLED_CHANGED, payload: { enabled } })
    .catch(() => {
      // No popup/options open — fine.
    });
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (typeof tab.id !== "number") continue;
      chrome.tabs
        .sendMessage(tab.id, {
          type: MESSAGES.ENABLED_CHANGED,
          payload: { enabled },
        })
        .catch(() => {
          // Tab has no content script (chrome://, web store, etc.) — fine.
        });
    }
  });
}

function broadcastBudget() {
  chrome.runtime
    .sendMessage({ type: MESSAGES.BUDGET_UPDATED, payload: budgetState })
    .catch(() => {
      // No receivers — safe to ignore.
    });
}

function applyBudgetUsage(usage) {
  budgetState = {
    ...budgetState,
    tripped: Boolean(usage.tripped),
    trippedReason: usage.trippedReason ?? null,
    estimatedUsd: Number(usage.estimatedUsd ?? 0),
    cap: Number(usage.cap ?? 0),
    percent: Number(usage.percent ?? 0),
    counts: {
      geocode: Number(usage.counts?.geocode ?? 0),
      directions: Number(usage.counts?.directions ?? 0),
    },
    month: usage.month ?? "",
    reachable: true,
    error: null,
    lastCheckedAt: Date.now(),
    persistError: usage.persistError ?? null,
  };
  persistBudgetState();
  broadcastBudget();
}

function markBudgetTripped(reason) {
  budgetState = {
    ...budgetState,
    tripped: true,
    trippedReason: reason ?? "Monthly budget exhausted.",
    reachable: true,
    error: null,
    lastCheckedAt: Date.now(),
  };
  persistBudgetState();
  broadcastBudget();
}

function markBudgetUnreachable(err) {
  budgetState = {
    ...budgetState,
    reachable: false,
    error: err?.message ?? String(err ?? "unreachable"),
    lastCheckedAt: Date.now(),
  };
  persistBudgetState();
  broadcastBudget();
}

async function pollBudget() {
  await hydrationPromise;
  const { backendUrl } = await getSettings();
  try {
    const res = await fetch(`${backendUrl}/budget`, { cache: "no-store" });
    if (!res.ok) {
      markBudgetUnreachable(new Error(`HTTP ${res.status}`));
      return budgetState;
    }
    const usage = await res.json();
    applyBudgetUsage(usage);
    return budgetState;
  } catch (err) {
    markBudgetUnreachable(err);
    return budgetState;
  }
}

async function resetBudget() {
  await hydrationPromise;
  const { backendUrl, adminToken } = await getSettings();
  const headers = { "Content-Type": "application/json" };
  if (adminToken) headers[ADMIN_HEADER] = adminToken;
  const res = await fetch(`${backendUrl}/budget/reset`, {
    method: "POST",
    headers,
    cache: "no-store",
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    let code = null;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
      if (body?.code) code = body.code;
    } catch {
      // ignore
    }
    const err = new Error(msg);
    err.code = code;
    err.httpStatus = res.status;
    throw err;
  }
  const usage = await res.json();
  applyBudgetUsage(usage);
  // Also flush the local dist cache — it may have stale results produced just
  // before the breaker tripped.
  distCache.clear();
  return budgetState;
}

/**
 * Parse a fetch Response as JSON. Attaches any server-provided `code` and
 * the raw HTTP status to thrown errors so callers can distinguish
 * `quota_exhausted` from e.g. `admin_token_required` without string-matching
 * error messages.
 */
async function readResponse(res) {
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // non-JSON body — leave null
    }
  }
  if (!res.ok) {
    const msg = body?.error ?? `HTTP ${res.status}`;
    const err = new Error(msg);
    err.code = body?.code ?? null;
    err.httpStatus = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function resolveBaseAddress(input) {
  const { backendUrl } = await getSettings();
  const res = await fetch(`${backendUrl}/resolve-base`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: input }),
  });
  return readResponse(res);
}

/**
 * Build a "paused" placeholder result for a candidate we aren't going to
 * send to the backend. Using the dedicated status lets the UI render it
 * distinctly from generic errors.
 */
function pausedResult(id, reason) {
  return {
    id,
    status: STATUSES.PAUSED,
    error: reason,
    modes: {},
  };
}

async function resolveDistances(tabId, candidates) {
  await hydrationPromise;
  const { base, units, backendUrl, modes, enabled } = await getSettings();

  // Master kill switch. Belt-and-braces: the content script also stops
  // scanning when disabled, but if anything slips through, refuse here.
  // Returning empty results (rather than throwing) lets callers no-op
  // cleanly without painting error badges.
  if (!enabled) {
    updatePageResults(tabId, candidates, []);
    return { results: [], disabled: true };
  }

  // Even when the breaker is tripped, we still serve cache hits. That
  // keeps already-seen addresses usable during a monthly pause — only
  // fresh addresses get marked as paused.
  if (budgetState.tripped) {
    const reason = budgetState.trippedReason ?? "Monthly budget exhausted.";
    const results = candidates.map((c) => {
      if (base) {
        const key = distanceCacheKey(base.placeId, c.text, modes, units);
        const hit = cacheGet(key);
        if (hit) return { ...hit, id: c.id };
      }
      return pausedResult(c.id, reason);
    });
    updatePageResults(tabId, candidates, results);
    return { results, paused: true, budget: budgetState };
  }

  if (!base) {
    const noBase = candidates.map((c) => ({
      id: c.id,
      status: STATUSES.ERROR,
      error: "No base address configured",
      modes: {},
    }));
    updatePageResults(tabId, candidates, noBase);
    return { results: noBase };
  }

  const results = new Array(candidates.length);
  const toFetch = [];
  const toFetchIdx = [];
  candidates.forEach((c, i) => {
    const key = distanceCacheKey(base.placeId, c.text, modes, units);
    const hit = cacheGet(key);
    if (hit) {
      results[i] = { ...hit, id: c.id };
    } else {
      toFetch.push(c);
      toFetchIdx.push(i);
    }
  });

  if (toFetch.length > 0) {
    let backendResults = [];
    let serverPaused = false;
    try {
      const res = await fetch(`${backendUrl}/resolve-distances`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base: {
            lat: base.lat,
            lng: base.lng,
            placeId: base.placeId,
            formattedAddress: base.formattedAddress,
          },
          modes,
          units,
          candidates: toFetch.map((c) => ({ id: c.id, text: c.text })),
        }),
      });
      const parsed = await readResponse(res);
      backendResults = Array.isArray(parsed?.results) ? parsed.results : [];
      serverPaused = Boolean(parsed?.paused);
      if (parsed?.budget) applyBudgetUsage(parsed.budget);
    } catch (err) {
      if (err?.code === "quota_exhausted") {
        markBudgetTripped(err.message);
        // The 429 payload carries `results` with paused markers — use those
        // directly if present, otherwise synthesize.
        const body = err.body;
        if (body && Array.isArray(body.results)) {
          backendResults = body.results;
          serverPaused = true;
        } else {
          backendResults = toFetch.map((c) => pausedResult(c.id, err.message));
        }
      } else {
        const message = err?.message ?? String(err);
        backendResults = toFetch.map((c) => ({
          id: c.id,
          status: STATUSES.ERROR,
          error: message,
          modes: {},
        }));
      }
    }

    // Align backend results to requests by `id`, not by position. The
    // backend is allowed to return them out of order.
    const byId = new Map();
    for (const r of backendResults) {
      if (r && typeof r.id === "string") byId.set(r.id, r);
    }
    for (let j = 0; j < toFetch.length; j++) {
      const idx = toFetchIdx[j];
      const c = toFetch[j];
      const r =
        byId.get(c.id) ??
        (serverPaused
          ? pausedResult(
              c.id,
              budgetState.trippedReason ?? "Monthly budget exhausted."
            )
          : {
              id: c.id,
              status: STATUSES.ERROR,
              error: "missing from backend response",
              modes: {},
            });
      results[idx] = r;
      // Only cache successful resolutions.
      if (r.status === STATUSES.OK || r.status === STATUSES.AMBIGUOUS) {
        const key = distanceCacheKey(base.placeId, c.text, modes, units);
        cacheSet(key, r);
      }
    }
  }

  updatePageResults(tabId, candidates, results);
  // Opportunistically refresh budget every time we hit the backend so the UI
  // can show live usage without waiting for the next poll tick.
  pollBudget().catch(() => {});
  return { results, modes, budget: budgetState };
}

function updatePageResults(tabId, candidates, results) {
  if (typeof tabId !== "number") return;
  const merged = candidates.map((c, i) => ({
    id: c.id,
    rawText: c.text,
    result: results[i],
  }));
  const entry = pageResultsByTab.get(tabId);
  const byIdx = new Map(entry?.results?.map((e) => [e.id, e]) ?? []);
  for (const m of merged) byIdx.set(m.id, m);
  pageResultsByTab.set(tabId, {
    url: entry?.url ?? "",
    results: Array.from(byIdx.values()),
  });
  chrome.runtime
    .sendMessage({
      type: MESSAGES.PAGE_RESULTS_UPDATED,
      payload: { tabId, results: Array.from(byIdx.values()) },
    })
    .catch(() => {
      // popup may not be open; safe to ignore
    });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  pageResultsByTab.delete(tabId);
});

/** Periodic poll via chrome.alarms — survives SW restarts. */
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(BUDGET_POLL_ALARM, {
    delayInMinutes: BUDGET_POLL_INITIAL_DELAY_MIN,
    periodInMinutes: BUDGET_POLL_INTERVAL_MIN,
  });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(BUDGET_POLL_ALARM, {
    delayInMinutes: BUDGET_POLL_INITIAL_DELAY_MIN,
    periodInMinutes: BUDGET_POLL_INTERVAL_MIN,
  });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BUDGET_POLL_ALARM) pollBudget().catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === MESSAGES.RESOLVE_CANDIDATES) {
    const tabId = sender.tab?.id;
    const payload = msg.payload ?? {};
    if (tabId && typeof payload.url === "string") {
      pageResultsByTab.set(tabId, {
        url: payload.url,
        results: pageResultsByTab.get(tabId)?.results ?? [],
      });
    }
    resolveDistances(tabId, payload.candidates ?? [])
      .then((r) => sendResponse(r))
      .catch((err) =>
        sendResponse({
          error: err?.message ?? String(err),
          results: (payload.candidates ?? []).map((c) => ({
            id: c.id,
            status: STATUSES.ERROR,
            error: err?.message ?? String(err),
            modes: {},
          })),
        })
      );
    return true;
  }

  if (msg.type === MESSAGES.GET_BASE) {
    (async () => {
      await hydrationPromise;
      const s = await getSettings();
      sendResponse({ ...s, budget: budgetState });
    })().catch((err) => sendResponse({ error: err?.message ?? String(err) }));
    return true;
  }

  if (msg.type === MESSAGES.SET_BASE) {
    (async () => {
      try {
        await hydrationPromise;
        const addr = String(msg.payload?.address ?? "").trim();
        const units = msg.payload?.units;
        const backendUrl = msg.payload?.backendUrl;
        const modes = msg.payload?.modes;
        const adminToken = msg.payload?.adminToken;
        if (backendUrl !== undefined) await setSettings({ backendUrl });
        if (units === "metric" || units === "imperial") await setSettings({ units });
        if (typeof adminToken === "string") {
          await setSettings({ adminToken: adminToken.trim() });
        }
        if (Array.isArray(modes)) {
          await setSettings({ modes: sanitizeModes(modes) });
          distCache.clear();
        }
        if (addr) {
          const base = await resolveBaseAddress(addr);
          await setSettings({ base });
          distCache.clear();
          sendResponse({ ok: true, base });
          return;
        }
        sendResponse({ ok: true });
      } catch (err) {
        if (err?.code === "quota_exhausted") markBudgetTripped(err.message);
        sendResponse({
          ok: false,
          error: err?.message ?? String(err),
          code: err?.code,
        });
      }
    })();
    return true;
  }

  if (msg.type === MESSAGES.CLEAR_BASE) {
    (async () => {
      await chrome.storage.local.remove("base");
      distCache.clear();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === MESSAGES.SET_ENABLED) {
    (async () => {
      try {
        await hydrationPromise;
        const enabled = Boolean(msg.payload?.enabled);
        await setSettings({ enabled });
        // Cache survives toggles — distances haven't changed. But broadcast
        // immediately so the active tab can tear down or paint badges.
        broadcastEnabled(enabled);
        sendResponse({ ok: true, enabled });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message ?? String(err) });
      }
    })();
    return true;
  }

  if (msg.type === MESSAGES.GET_PAGE_RESULTS) {
    (async () => {
      await hydrationPromise;
      const tabId = msg.payload?.tabId ?? sender.tab?.id;
      if (typeof tabId !== "number") {
        sendResponse({ results: [], budget: budgetState });
        return;
      }
      const entry = pageResultsByTab.get(tabId);
      sendResponse({
        url: entry?.url ?? "",
        results: entry?.results ?? [],
        budget: budgetState,
      });
    })();
    return true;
  }

  if (msg.type === MESSAGES.GET_BUDGET) {
    (async () => {
      await hydrationPromise;
      const fresh = msg.payload?.force
        ? await pollBudget()
        : budgetState.lastCheckedAt
        ? budgetState
        : await pollBudget();
      sendResponse(fresh);
    })();
    return true;
  }

  if (msg.type === MESSAGES.RESET_BUDGET) {
    (async () => {
      try {
        const fresh = await resetBudget();
        sendResponse({ ok: true, budget: fresh });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err?.message ?? String(err),
          code: err?.code,
          httpStatus: err?.httpStatus,
        });
      }
    })();
    return true;
  }

  return false;
});

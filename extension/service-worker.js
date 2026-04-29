/**
 * HowFar — service worker.
 *
 * Owns settings, the short-lived per-(base, address, modes, units) cache,
 * and direct calls to Google Maps APIs using the user's own key. No backend
 * is required at runtime.
 *
 * Master kill switches, in priority order:
 *   1. `enabled` — user toggled HowFar off; nothing scans, nothing is fetched.
 *   2. No `apiKey` — user hasn't completed setup; we surface a "needs setup"
 *      status to the UI and don't try to call Google.
 *   3. Budget tripped — the user's monthly cap was reached. Cache hits keep
 *      working; fresh addresses get a `paused` marker.
 */
importScripts(
  "shared/types.js",
  "shared/normalize.js",
  "shared/messages.js",
  "shared/format.js",
  "shared/budget-tracker.js",
  "shared/provider-google.js"
);

const MESSAGES = self.WDFMessages;
const STATUSES = self.WDFStatuses;
const MODE_ORDER = self.WDFModeOrder;
const { distanceCacheKey } = self.WDFNormalize;
const { BudgetTracker, BudgetExceededError, DEFAULT_CAP_USD } = self.WDFBudget;
const { buildClient, ProviderError } = self.WDFProviderGoogle;

const DEFAULT_UNITS = "imperial";
const DEFAULT_MODES = [...MODE_ORDER];
const DEFAULT_ENABLED = true;
const CACHE_TTL_MS = 15 * 60 * 1000;

/** @type {Map<string, {value: any, expiresAt: number}>} */
const distCache = new Map();

/** @type {Map<number, {url: string, results: Array<any>}>} */
const pageResultsByTab = new Map();

const budget = new BudgetTracker({ cap: DEFAULT_CAP_USD });
const initPromise = budget.init();

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
    "modes",
    "apiKey",
    "enabled",
  ]);
  return {
    base: stored.base ?? null,
    units: stored.units ?? DEFAULT_UNITS,
    modes: sanitizeModes(stored.modes),
    apiKey: typeof stored.apiKey === "string" ? stored.apiKey : "",
    enabled: stored.enabled === undefined ? DEFAULT_ENABLED : Boolean(stored.enabled),
  };
}

async function setSettings(patch) {
  await chrome.storage.local.set(patch);
}

/**
 * True when the message originated from an extension UI page (popup, options),
 * not from a content script. Content scripts always carry a `sender.tab`;
 * extension pages don't. We use this to (a) refuse privileged writes from
 * content scripts and (b) redact the apiKey from broadcast settings reads.
 */
function isExtensionUiSender(sender) {
  return !sender?.tab && sender?.id === chrome.runtime.id;
}

/** Strip secrets from a settings object before sending it to a content script. */
function redactForContentScript(settings) {
  return {
    base: settings.base,
    units: settings.units,
    modes: settings.modes,
    enabled: settings.enabled,
    hasApiKey: Boolean(settings.apiKey),
  };
}

/**
 * Build a provider client for the current API key. We construct a fresh
 * client per request so a key change in options takes effect without
 * needing to reload anything.
 */
function clientFor(apiKey) {
  return buildClient({
    apiKey,
    budget,
    format: self.WDFFormat,
  });
}

/**
 * Tell every UI surface (popup, options) AND every content script that the
 * enabled flag changed. Both sends are best-effort: tabs without our content
 * script (chrome://, restricted origins) reject and that's fine.
 */
function broadcastEnabled(enabled) {
  chrome.runtime
    .sendMessage({ type: MESSAGES.ENABLED_CHANGED, payload: { enabled } })
    .catch(() => {});
  (async () => {
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (typeof tab.id !== "number") continue;
        chrome.tabs
          .sendMessage(tab.id, {
            type: MESSAGES.ENABLED_CHANGED,
            payload: { enabled },
          })
          .catch(() => {});
      }
    } catch {
      // tabs.query failed — best-effort broadcast, swallow.
    }
  })();
}

function broadcastBudget() {
  chrome.runtime
    .sendMessage({ type: MESSAGES.BUDGET_UPDATED, payload: budget.usage() })
    .catch(() => {});
}

/** Build a "paused" placeholder for a candidate we aren't going to send. */
function pausedResult(id, reason) {
  return {
    id,
    status: STATUSES.PAUSED,
    error: reason,
    modes: {},
  };
}

/**
 * Build a "setup needed" placeholder for when the user hasn't pasted an
 * API key yet. Distinct from `error` so the popup can render an actionable
 * "Open setup" button instead of a generic failure.
 */
function setupNeededResult(id) {
  return {
    id,
    status: STATUSES.ERROR,
    error: "Setup needed: paste your Google Maps API key in HowFar's options.",
    needsSetup: true,
    modes: {},
  };
}

async function resolveDistances(tabId, candidates) {
  await initPromise;
  const { base, units, modes, enabled, apiKey } = await getSettings();

  // 1. Master kill switch — user has HowFar off.
  if (!enabled) {
    updatePageResults(tabId, candidates, []);
    return { results: [], disabled: true };
  }

  // 2. Setup not done — surface a dedicated status the popup can act on.
  if (!apiKey) {
    const stub = candidates.map((c) => setupNeededResult(c.id));
    updatePageResults(tabId, candidates, stub);
    return { results: stub, needsSetup: true };
  }

  // 3. Budget tripped — serve cache hits, mark fresh addresses as paused.
  const usage = budget.usage();
  if (usage.tripped) {
    const reason = usage.trippedReason ?? "Monthly budget exhausted.";
    const results = candidates.map((c) => {
      if (base) {
        const key = distanceCacheKey(base.placeId, c.text, modes, units);
        const hit = cacheGet(key);
        if (hit) return { ...hit, id: c.id };
      }
      return pausedResult(c.id, reason);
    });
    updatePageResults(tabId, candidates, results);
    return { results, paused: true, budget: budget.usage() };
  }

  // 4. No base configured yet — bail with a clear error per candidate.
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
    const provider = clientFor(apiKey);
    let pauseReason = null;
    let resolved = [];
    try {
      resolved = await provider.resolveCandidates(toFetch);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        pauseReason = err.message;
      } else {
        const message = err?.message ?? String(err);
        for (let j = 0; j < toFetch.length; j++) {
          const idx = toFetchIdx[j];
          results[idx] = {
            id: toFetch[j].id,
            status: STATUSES.ERROR,
            error: message,
            modes: {},
          };
        }
        resolved = [];
      }
    }

    if (resolved.length > 0 && !pauseReason) {
      let distances = [];
      try {
        distances = await provider.getDistances(base, resolved, modes, units);
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          pauseReason = err.message;
        } else {
          const message = err?.message ?? String(err);
          for (let j = 0; j < toFetch.length; j++) {
            const idx = toFetchIdx[j];
            results[idx] = {
              id: toFetch[j].id,
              status: STATUSES.ERROR,
              error: message,
              modes: {},
            };
          }
        }
      }

      // Align by id; the provider preserves it but be defensive.
      const byId = new Map();
      for (const d of distances) {
        if (d && typeof d.id === "string") byId.set(d.id, d);
      }
      for (let j = 0; j < toFetch.length; j++) {
        const idx = toFetchIdx[j];
        const c = toFetch[j];
        const r =
          byId.get(c.id) ??
          (pauseReason
            ? pausedResult(c.id, pauseReason)
            : {
                id: c.id,
                status: STATUSES.ERROR,
                error: "no result",
                modes: {},
              });
        results[idx] = r;
        if (r.status === STATUSES.OK || r.status === STATUSES.AMBIGUOUS) {
          const key = distanceCacheKey(base.placeId, c.text, modes, units);
          cacheSet(key, r);
        }
      }
    }

    // Post-batch trip check: if a parallel leg flipped the breaker partway
    // through, fill any unfilled slots with paused.
    const trippedNow = budget.usage().tripped;
    if (trippedNow && !pauseReason) {
      pauseReason = budget.usage().trippedReason ?? "Monthly budget exhausted.";
    }
    if (pauseReason) {
      for (let j = 0; j < toFetch.length; j++) {
        const idx = toFetchIdx[j];
        if (results[idx] === undefined) {
          results[idx] = pausedResult(toFetch[j].id, pauseReason);
        }
      }
    }

    // Defend against holes (shouldn't happen, but the UI dies on undefined).
    for (let i = 0; i < results.length; i++) {
      if (results[i] === undefined) {
        results[i] = {
          id: candidates[i].id,
          status: STATUSES.ERROR,
          error: "no result",
          modes: {},
        };
      }
    }
  }

  updatePageResults(tabId, candidates, results);
  // Push budget update so the popup's progress bar stays live.
  broadcastBudget();
  return { results, modes, budget: budget.usage() };
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
    .catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => {
  pageResultsByTab.delete(tabId);
});

/**
 * One-time migration: drop storage keys from previous architectures
 * (v1 used a backend; an earlier budget tracker used `wdfBudgetState`).
 * Cheap to run on every install/update and removes dead keys that would
 * otherwise mislead future maintainers grepping chrome.storage.
 */
async function migrateStorage() {
  try {
    await chrome.storage.local.remove(["backendUrl", "adminToken", "wdfBudgetState"]);
  } catch {
    // Storage failures aren't worth surfacing — the dead keys are harmless.
  }
}

/**
 * Open the options page on first install so the user lands directly in the
 * setup wizard. We deliberately don't open it on `update` events — that
 * would be obnoxious for existing users on every minor release.
 */
chrome.runtime.onInstalled.addListener((details) => {
  void migrateStorage();
  if (details.reason !== "install") return;
  // Best-effort: if openOptionsPage rejects (Chrome quirk), fall back to
  // opening the URL directly.
  const fallback = () => {
    const url = chrome.runtime.getURL("ui/options.html");
    chrome.tabs.create({ url }).catch(() => {});
  };
  try {
    const p = chrome.runtime.openOptionsPage();
    if (p && typeof p.catch === "function") p.catch(fallback);
  } catch {
    fallback();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === MESSAGES.RESOLVE_CANDIDATES) {
    const tabId = sender.tab?.id;
    const payload = msg.payload ?? {};
    if (tabId && typeof payload.url === "string") {
      // SPA navigations reuse the same tabId but switch URL. Drop stale
      // results so the popup shows only the current page's addresses.
      const existing = pageResultsByTab.get(tabId);
      const sameUrl = existing?.url === payload.url;
      pageResultsByTab.set(tabId, {
        url: payload.url,
        results: sameUrl ? existing.results : [],
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
      await initPromise;
      const s = await getSettings();
      // Content scripts don't get the actual key — they only need to know
      // whether setup is complete. Extension UI pages (popup, options) get
      // the full settings so the form can pre-fill is unchanged.
      const safe = isExtensionUiSender(sender)
        ? { ...s, hasApiKey: Boolean(s.apiKey) }
        : redactForContentScript(s);
      sendResponse({ ...safe, budget: budget.usage() });
    })().catch((err) => sendResponse({ error: err?.message ?? String(err) }));
    return true;
  }

  if (msg.type === MESSAGES.GET_API_KEY) {
    // Content scripts have no business reading the key.
    if (!isExtensionUiSender(sender)) {
      sendResponse({ ok: false, error: "forbidden" });
      return true;
    }
    (async () => {
      try {
        await initPromise;
        const { apiKey } = await getSettings();
        sendResponse({ ok: true, apiKey: apiKey ?? "" });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message ?? String(err) });
      }
    })();
    return true;
  }

  if (msg.type === MESSAGES.SET_BASE) {
    if (!isExtensionUiSender(sender)) {
      sendResponse({ ok: false, error: "forbidden" });
      return true;
    }
    (async () => {
      try {
        await initPromise;
        const addr = String(msg.payload?.address ?? "").trim();
        const units = msg.payload?.units;
        const modes = msg.payload?.modes;
        if (units === "metric" || units === "imperial") {
          await setSettings({ units });
        }
        if (Array.isArray(modes)) {
          await setSettings({ modes: sanitizeModes(modes) });
          distCache.clear();
        }
        if (addr) {
          const { apiKey } = await getSettings();
          if (!apiKey) {
            sendResponse({
              ok: false,
              error:
                "Paste your Google Maps API key first so we can geocode the base address.",
              code: "needs_setup",
            });
            return;
          }
          const provider = clientFor(apiKey);
          const base = await provider.resolveBaseAddress(addr);
          await setSettings({ base });
          distCache.clear();
          sendResponse({ ok: true, base });
          return;
        }
        sendResponse({ ok: true });
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          broadcastBudget();
        }
        sendResponse({
          ok: false,
          error: err?.message ?? String(err),
          code: err?.code ?? (err instanceof ProviderError ? err.kind : null),
        });
      }
    })();
    return true;
  }

  if (msg.type === MESSAGES.CLEAR_BASE) {
    if (!isExtensionUiSender(sender)) {
      sendResponse({ ok: false, error: "forbidden" });
      return true;
    }
    (async () => {
      try {
        await chrome.storage.local.remove("base");
        distCache.clear();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message ?? String(err) });
      }
    })();
    return true;
  }

  if (msg.type === MESSAGES.SET_API_KEY) {
    if (!isExtensionUiSender(sender)) {
      sendResponse({ ok: false, error: "forbidden" });
      return true;
    }
    (async () => {
      try {
        await initPromise;
        const apiKey = String(msg.payload?.apiKey ?? "").trim();
        await setSettings({ apiKey });
        // The new key invalidates anything we resolved with the old one.
        distCache.clear();
        // Tell any open extension pages (popup, options) that setup state
        // changed so they can flip out of / into the "Setup needed" view
        // without waiting for the user to reopen them.
        chrome.runtime
          .sendMessage({
            type: MESSAGES.API_KEY_CHANGED,
            payload: { hasApiKey: Boolean(apiKey) },
          })
          .catch(() => {});
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message ?? String(err) });
      }
    })();
    return true;
  }

  if (msg.type === MESSAGES.VALIDATE_KEY) {
    (async () => {
      try {
        const apiKey = String(msg.payload?.apiKey ?? "").trim();
        if (!apiKey) {
          sendResponse({ ok: false, reason: "Key is empty." });
          return;
        }
        // Build a budget-less client so the validation call doesn't count
        // against the user's tracker.
        const probe = buildClient({
          apiKey,
          budget: undefined,
          format: self.WDFFormat,
        });
        const result = await probe.validateKey();
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, reason: err?.message ?? String(err) });
      }
    })();
    return true;
  }

  if (msg.type === MESSAGES.SET_ENABLED) {
    if (!isExtensionUiSender(sender)) {
      sendResponse({ ok: false, error: "forbidden" });
      return true;
    }
    (async () => {
      try {
        await initPromise;
        const enabled = Boolean(msg.payload?.enabled);
        await setSettings({ enabled });
        broadcastEnabled(enabled);
        sendResponse({ ok: true, enabled });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message ?? String(err) });
      }
    })();
    return true;
  }

  if (msg.type === MESSAGES.SET_BUDGET_CAP) {
    if (!isExtensionUiSender(sender)) {
      sendResponse({ ok: false, error: "forbidden" });
      return true;
    }
    (async () => {
      try {
        await initPromise;
        const cap = Number(msg.payload?.cap);
        if (!Number.isFinite(cap) || cap <= 0) {
          sendResponse({ ok: false, error: "Cap must be a positive number." });
          return;
        }
        await budget.setCap(cap);
        broadcastBudget();
        sendResponse({ ok: true, budget: budget.usage() });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message ?? String(err) });
      }
    })();
    return true;
  }

  if (msg.type === MESSAGES.GET_PAGE_RESULTS) {
    (async () => {
      try {
        await initPromise;
        const tabId = msg.payload?.tabId ?? sender.tab?.id;
        if (typeof tabId !== "number") {
          sendResponse({ results: [], budget: budget.usage() });
          return;
        }
        const entry = pageResultsByTab.get(tabId);
        sendResponse({
          url: entry?.url ?? "",
          results: entry?.results ?? [],
          budget: budget.usage(),
        });
      } catch (err) {
        sendResponse({ error: err?.message ?? String(err), results: [] });
      }
    })();
    return true;
  }

  if (msg.type === MESSAGES.GET_BUDGET) {
    (async () => {
      try {
        await initPromise;
        sendResponse(budget.usage());
      } catch (err) {
        sendResponse({ error: err?.message ?? String(err) });
      }
    })();
    return true;
  }

  if (msg.type === MESSAGES.RESET_BUDGET) {
    if (!isExtensionUiSender(sender)) {
      sendResponse({ ok: false, error: "forbidden" });
      return true;
    }
    (async () => {
      try {
        await initPromise;
        await budget.reset();
        // A reset typically follows a tripped breaker; clear the dist cache
        // too so any "paused" results we cached during the pause don't
        // continue to render.
        distCache.clear();
        broadcastBudget();
        sendResponse({ ok: true, budget: budget.usage() });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message ?? String(err) });
      }
    })();
    return true;
  }

  return false;
});

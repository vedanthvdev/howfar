/**
 * Page scanner. Runs extractors, dedupes, batches the candidates off to the
 * service worker, and pushes results back into the annotator.
 *
 * Exposes no globals beyond a tiny WDFScanner handle (mostly for rescans
 * triggered from the popup).
 */
(function () {
  const MAX_CANDIDATES = 20;
  const SCAN_DEBOUNCE_MS = 600;
  // Hard floor on how often scans can actually run, to cap damage on pages
  // that churn the DOM continuously (feeds, carousels, live-updating ads).
  const SCAN_MIN_INTERVAL_MS = 2000;
  const { normalizeAddress } = self.WDFNormalize;
  const MESSAGES = self.WDFMessages;
  const STATUSES = self.WDFStatuses;
  const BADGE_CLASS = self.WDFAnnotator.BADGE_CLASS;
  const BADGE_SELECTOR = `.${BADGE_CLASS}`;

  /** @type {Map<string, {candidate: any, badge: HTMLElement|null, result: any}>} */
  const byId = new Map();
  /** @type {Set<string>} */
  const seenKeys = new Set();
  let scanSeq = 0;
  let rescanTimer = null;
  let lastScanAt = 0;
  let observer = null;

  function nextId() {
    scanSeq += 1;
    return `c${scanSeq}`;
  }

  /**
   * Return true iff `inner` appears inside `outer` as a contiguous run of
   * whole tokens (i.e. word-boundary containment). Prevents e.g. the
   * key "park lane" from being dropped because it's a substring of
   * "regents park lane" — it isn't; but also prevents "park" from being
   * dropped because it's a substring of "regents park lane regents park".
   *
   * Both inputs are assumed to be pre-normalized (lowercased,
   * whitespace-collapsed, punctuation stripped) by `normalizeAddress`.
   * That normalizer collapses whitespace runs to a single space and
   * strips punctuation, so `split(" ")` yields well-formed tokens with no
   * stray empties — no need for extra whitespace hardening here.
   */
  function containsTokenRun(outer, inner) {
    if (outer === inner) return true;
    if (inner.length >= outer.length) return false;
    const outerTokens = outer.split(" ");
    const innerTokens = inner.split(" ");
    if (innerTokens.length === 0 || innerTokens.length > outerTokens.length) {
      return false;
    }
    const last = outerTokens.length - innerTokens.length;
    scan: for (let i = 0; i <= last; i++) {
      for (let j = 0; j < innerTokens.length; j++) {
        if (outerTokens[i + j] !== innerTokens[j]) continue scan;
      }
      return true;
    }
    return false;
  }

  /**
   * Dedupe candidates within this scan *and* against prior scans, with a
   * prefix/substring rule: a shorter candidate that is fully contained in a
   * longer candidate's normalized text is dropped. That handles pages that
   * split an address across siblings, where one extractor produces the full
   * string ("9 annfield court macmerry east lothian eh33 1pn") and another
   * produces a truncated one ("9 annfield court") that would otherwise
   * geocode to a completely different place.
   */
  function dedupeCandidates(candidates) {
    const out = [];
    const acceptedKeys = [];
    for (const c of candidates) {
      const key = normalizeAddress(c.text);
      if (!key || key.length < 6) continue;

      // If any already-accepted key contains this key as a whole-token run,
      // this is a shorter duplicate — skip it.
      if (acceptedKeys.some((k) => containsTokenRun(k, key))) continue;

      // If this key *supersedes* any already-accepted shorter key, evict the
      // shorter one before adding.
      for (let i = acceptedKeys.length - 1; i >= 0; i--) {
        if (containsTokenRun(key, acceptedKeys[i])) {
          seenKeys.delete(acceptedKeys[i]);
          out.splice(i, 1);
          acceptedKeys.splice(i, 1);
        }
      }

      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      acceptedKeys.push(key);
      out.push({ ...c, key });
      if (out.length >= MAX_CANDIDATES) break;
    }
    return out;
  }

  function gatherAll() {
    const structured = self.WDFStructuredExtractor;
    const text = self.WDFTextExtractor;
    // Purge the per-element text memo; the DOM may have mutated since the
    // last scan and the old values would be stale.
    text.resetElementTextCache?.();
    const ordered = [
      ...structured.extractFromAddressTags(),
      ...structured.extractFromJsonLd(),
      ...structured.extractFromMicrodata(),
      ...structured.extractFromMapLinks(),
      ...text.extractByPostcodeInBlocks(document.body),
      ...text.extractByPostcodeClimb(document.body),
      ...text.extractByPostcode(document.body),
      ...text.extractFromText(document.body),
    ];
    return dedupeCandidates(ordered);
  }

  function paintLoading(candidate) {
    const badge = candidate.anchor
      ? self.WDFAnnotator.ensureBadge(candidate.anchor, candidate.id)
      : null;
    self.WDFAnnotator.setBadgeState(badge, { status: STATUSES.LOADING });
    byId.set(candidate.id, { candidate, badge, result: { status: STATUSES.LOADING } });
  }

  function paintResult(id, result) {
    const entry = byId.get(id);
    if (!entry) return;
    entry.result = result;
    self.WDFAnnotator.setBadgeState(entry.badge, result);
  }

  async function sendToWorker(candidates) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGES.RESOLVE_CANDIDATES,
        payload: {
          url: location.href,
          candidates: candidates.map((c) => ({ id: c.id, text: c.text })),
        },
      });
      if (!response || !Array.isArray(response.results)) return;
      for (const r of response.results) paintResult(r.id, r);
    } catch (err) {
      for (const c of candidates) {
        paintResult(c.id, {
          id: c.id,
          status: STATUSES.ERROR,
          error: err?.message ?? String(err),
        });
      }
    }
  }

  async function scan() {
    if (!document.body) return;
    lastScanAt = Date.now();
    const raw = gatherAll();
    if (raw.length === 0) return;
    const candidates = raw.map((c) => ({ ...c, id: nextId() }));
    for (const c of candidates) paintLoading(c);
    await sendToWorker(candidates);
  }

  /**
   * Schedule a rescan, debounced and throttled. The throttle is the backstop
   * for pages that never stop mutating: no matter how many times we're
   * poked, we never actually scan more than once per SCAN_MIN_INTERVAL_MS.
   */
  function requestRescan(_reason) {
    if (rescanTimer) clearTimeout(rescanTimer);
    const elapsed = Date.now() - lastScanAt;
    const delay = Math.max(
      SCAN_DEBOUNCE_MS,
      SCAN_MIN_INTERVAL_MS - elapsed
    );
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      scan();
    }, delay);
  }

  function forceRescan() {
    if (rescanTimer) clearTimeout(rescanTimer);
    rescanTimer = null;
    byId.clear();
    seenKeys.clear();
    self.WDFAnnotator.removeAllBadges();
    scan();
  }

  /**
   * A mutation is "ours" if it exists entirely inside a badge (text changes,
   * attribute flips during state transitions) or if it only adds/removes
   * badge elements on a parent. Without this filter, every badge insert
   * fires the observer, which schedules a rescan, which inserts more badges
   * — a self-sustaining loop on any moderately dynamic page.
   */
  function isBadgeRelated(node) {
    if (!node) return false;
    const el = node.nodeType === 1 ? node : node.parentElement;
    return !!(el && el.closest && el.closest(BADGE_SELECTOR));
  }

  function isBadgeOnlyMutation(mutation) {
    if (isBadgeRelated(mutation.target)) return true;
    if (mutation.type !== "childList") return false;
    const added = mutation.addedNodes;
    const removed = mutation.removedNodes;
    if (added.length + removed.length === 0) return false;
    for (const n of added) if (!isBadgeRelated(n)) return false;
    for (const n of removed) if (!isBadgeRelated(n)) return false;
    return true;
  }

  function observeMutations() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (!isBadgeOnlyMutation(m)) {
          requestRescan("mutation");
          return;
        }
      }
    });
    // Deliberately no `characterData: true` — text-content flips (ticking
    // clocks, live counters, typing indicators) are a huge source of noise
    // and almost never useful signal for finding addresses.
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  /**
   * Tear down everything the scanner is doing on the page. Called when the
   * user disables the extension. We stop observing mutations (so we don't
   * needlessly run isBadgeOnlyMutation on every DOM change), cancel any
   * pending debounced scan, and remove all badges.
   */
  function teardown() {
    if (rescanTimer) clearTimeout(rescanTimer);
    rescanTimer = null;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    byId.clear();
    seenKeys.clear();
    self.WDFAnnotator.removeAllBadges();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === MESSAGES.RESCAN) {
      forceRescan();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === MESSAGES.ENABLED_CHANGED) {
      const enabled = !!msg.payload?.enabled;
      if (enabled) {
        observeMutations();
        forceRescan();
      } else {
        teardown();
      }
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === MESSAGES.GET_PAGE_RESULTS) {
      const results = [];
      for (const [, entry] of byId) {
        results.push({
          id: entry.candidate.id,
          rawText: entry.candidate.text,
          source: entry.candidate.source,
          result: entry.result,
        });
      }
      sendResponse({ url: location.href, results });
      return true;
    }
    return false;
  });

  async function boot() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
      return;
    }
    // Ask the SW for current settings before doing anything. If the user
    // has disabled the extension we stay completely idle until ENABLED_CHANGED
    // flips us back on. Default to enabled if the query fails (SW asleep,
    // first install, etc.) so first-run UX is unchanged.
    let enabled = true;
    try {
      const s = await chrome.runtime.sendMessage({ type: MESSAGES.GET_BASE });
      if (s && typeof s === "object" && s.enabled === false) enabled = false;
    } catch {
      // ignore; treat as enabled
    }
    if (!enabled) return;
    observeMutations();
    requestRescan("boot");
  }

  self.WDFScanner = { rescan: forceRescan };

  boot();
})();

(function () {
  const MESSAGES = self.WDFMessages;
  const STATUSES = self.WDFStatuses;
  const MODE_ORDER = self.WDFModeOrder;
  const MODE_ICONS = self.WDFModeIcons;
  const MODE_LABELS = self.WDFModeLabels;

  const baseSection = document.getElementById("base");
  const baseAddressEl = document.getElementById("base-address");
  const emptySection = document.getElementById("empty");
  const listSection = document.getElementById("list");
  const resultsEl = document.getElementById("results");
  const rescanBtn = document.getElementById("rescan");
  const statusEl = document.getElementById("status");
  const pausedSection = document.getElementById("paused");
  const pausedMsg = document.getElementById("paused-msg");
  const pausedOptionsBtn = document.getElementById("paused-options");
  const budgetSummary = document.getElementById("budget-summary");
  const enabledInput = document.getElementById("enabled");
  const toggleLabel = document.getElementById("toggle-label");
  const disabledSection = document.getElementById("disabled");

  // Tracks the current `enabled` flag in this popup. Affects which UI
  // sections render and whether the rescan button is interactive (disabled
  // state outranks the budget-paused state — there's nothing to rescan if
  // we aren't scanning).
  let enabledState = true;

  function renderEnabled(enabled) {
    enabledState = !!enabled;
    enabledInput.checked = enabledState;
    toggleLabel.textContent = enabledState ? "On" : "Off";
    disabledSection.hidden = enabledState;
    if (!enabledState) {
      // Hide everything that depends on scanning when we're off — the user
      // doesn't need to see stale results or the empty-state nag.
      listSection.hidden = true;
      pausedSection.hidden = true;
      rescanBtn.disabled = true;
    } else {
      rescanBtn.disabled = false;
    }
  }

  function fmtUsd(n) {
    const v = Number.isFinite(n) ? n : 0;
    return `$${v.toFixed(2)}`;
  }

  function renderBudget(budget) {
    // When the user has disabled the extension, suppress the budget-paused
    // chrome entirely — "off" is the dominant state and we don't want to
    // confuse users by also flashing a free-tier banner. The footer summary
    // is still informative (it shows current spend) so we keep it.
    if (!budget) {
      if (enabledState) pausedSection.hidden = true;
      budgetSummary.hidden = true;
      if (enabledState) rescanBtn.disabled = false;
      return;
    }
    if (budget.tripped && enabledState) {
      pausedSection.hidden = false;
      pausedMsg.textContent =
        budget.trippedReason ||
        "Scanning paused to keep you under your monthly Google Maps budget.";
      rescanBtn.disabled = true;
    } else if (enabledState) {
      pausedSection.hidden = true;
      rescanBtn.disabled = false;
    }
    if (budget.cap > 0 && budget.lastCheckedAt) {
      budgetSummary.hidden = false;
      budgetSummary.textContent = `${fmtUsd(budget.estimatedUsd)} / ${fmtUsd(budget.cap)} this month`;
      budgetSummary.className = "ftr__budget";
      if (budget.tripped) budgetSummary.classList.add("ftr__budget--err");
      else if (budget.percent >= 80) budgetSummary.classList.add("ftr__budget--warn");
    } else {
      budgetSummary.hidden = true;
    }
  }

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return tab ?? null;
  }

  function pillClassFor(result) {
    const s = result?.status;
    if (s === STATUSES.LOADING) return "pill pill--loading";
    if (s === STATUSES.PAUSED) return "pill pill--paused";
    if (s === STATUSES.NOT_FOUND || s === STATUSES.ERROR) return "pill pill--err";
    if (s === STATUSES.AMBIGUOUS) return "pill pill--warn";
    if (s === STATUSES.OK) {
      const modes = result.modes ?? {};
      const entries = Object.values(modes);
      if (entries.length > 0 && entries.every((o) => o && o.status === "no_route")) {
        return "pill pill--warn";
      }
      return "pill";
    }
    return "pill";
  }

  function topPillLabel(result) {
    const s = result?.status;
    if (s === STATUSES.LOADING) return "loading…";
    if (s === STATUSES.PAUSED) return "paused";
    if (s === STATUSES.NOT_FOUND) return "not found";
    if (s === STATUSES.ERROR) return "unavailable";
    if (s === STATUSES.OK || s === STATUSES.AMBIGUOUS) {
      const distance = result.displayDistance ?? "?";
      const suffix = s === STATUSES.AMBIGUOUS ? " (approx.)" : "";
      return `${distance}${suffix}`;
    }
    return "—";
  }

  function modeRow(mode, outcome) {
    const wrap = document.createElement("div");
    wrap.className = "mode";
    const icon = document.createElement("span");
    icon.className = "mode__icon";
    icon.textContent = MODE_ICONS[mode] ?? "·";
    icon.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "mode__label";
    label.textContent = MODE_LABELS[mode] ?? mode;
    const value = document.createElement("span");
    value.className = "mode__value";
    if (!outcome) {
      value.textContent = "—";
    } else if (outcome.status === "ok") {
      const dur = outcome.displayDuration ?? "";
      const dist = outcome.displayDistance ?? "";
      value.textContent = [dur, dist].filter(Boolean).join(" · ");
    } else if (outcome.status === "no_route") {
      value.textContent = "no route";
      value.classList.add("mode__value--muted");
    } else {
      value.textContent = "unavailable";
      value.classList.add("mode__value--muted");
      if (outcome.error) value.title = outcome.error;
    }
    wrap.appendChild(icon);
    wrap.appendChild(label);
    wrap.appendChild(value);
    return wrap;
  }

  function render(entries) {
    resultsEl.innerHTML = "";
    if (!entries || entries.length === 0) {
      listSection.hidden = true;
      return;
    }
    listSection.hidden = false;
    for (const e of entries) {
      const r = e.result ?? {};
      const li = document.createElement("li");

      const addr = document.createElement("div");
      addr.className = "addr";
      addr.textContent = r.formattedAddress || e.rawText || "(address)";

      const meta = document.createElement("div");
      meta.className = "meta";
      const pill = document.createElement("span");
      pill.className = pillClassFor(r);
      pill.textContent = topPillLabel(r);
      meta.appendChild(pill);
      if (r.formattedAddress && r.formattedAddress !== e.rawText) {
        const src = document.createElement("span");
        src.className = "meta__src";
        src.textContent = `on page: ${e.rawText}`;
        src.title = e.rawText;
        meta.appendChild(src);
      }

      li.appendChild(addr);
      li.appendChild(meta);

      // Per-mode rows for resolved addresses.
      if (
        (r.status === STATUSES.OK || r.status === STATUSES.AMBIGUOUS) &&
        r.modes
      ) {
        const modesWrap = document.createElement("div");
        modesWrap.className = "modes";
        for (const m of MODE_ORDER) {
          if (r.modes[m]) modesWrap.appendChild(modeRow(m, r.modes[m]));
        }
        if (modesWrap.childNodes.length > 0) li.appendChild(modesWrap);
      }

      resultsEl.appendChild(li);
    }
  }

  async function loadBase() {
    const response = await chrome.runtime.sendMessage({ type: MESSAGES.GET_BASE });
    renderEnabled(response?.enabled !== false);
    renderBudget(response?.budget);
    if (response?.base) {
      baseSection.hidden = false;
      baseAddressEl.textContent = response.base.formattedAddress;
      emptySection.hidden = true;
      return true;
    }
    baseSection.hidden = true;
    emptySection.hidden = false;
    return false;
  }

  async function loadResults() {
    if (!enabledState) return;
    const tab = await getActiveTab();
    if (!tab?.id) return;
    const response = await chrome.runtime.sendMessage({
      type: MESSAGES.GET_PAGE_RESULTS,
      payload: { tabId: tab.id },
    });
    renderBudget(response?.budget);
    render(response?.results ?? []);
  }

  async function refreshBudget() {
    const budget = await chrome.runtime.sendMessage({
      type: MESSAGES.GET_BUDGET,
      payload: { force: true },
    });
    renderBudget(budget);
  }

  rescanBtn.addEventListener("click", async () => {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    statusEl.textContent = "rescanning…";
    try {
      await chrome.tabs.sendMessage(tab.id, { type: MESSAGES.RESCAN });
    } catch {
      statusEl.textContent = "can't scan this page";
      return;
    }
    setTimeout(() => {
      statusEl.textContent = "";
      loadResults();
    }, 400);
  });

  // `chrome.runtime.openOptionsPage()` occasionally rejects with
  // "Could not create an options page" — most commonly when a previous
  // options tab is mid-close, the extension was just reloaded, or two clicks
  // race. The documented workaround is to fall back to opening the options
  // URL directly via `tabs.create`. We always go through this helper so the
  // popup never surfaces an uncaught promise error.
  function openOptions() {
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
  }

  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.id === "open-options" || t.getAttribute("data-action") === "open-options") {
      e.preventDefault();
      openOptions();
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === MESSAGES.PAGE_RESULTS_UPDATED) {
      loadResults();
    } else if (msg?.type === MESSAGES.BUDGET_UPDATED) {
      renderBudget(msg.payload);
    } else if (msg?.type === MESSAGES.ENABLED_CHANGED) {
      renderEnabled(msg.payload?.enabled !== false);
    }
  });

  enabledInput.addEventListener("change", async () => {
    const enabled = enabledInput.checked;
    // Optimistic flip so the toggle feels instant even on a slow SW wakeup.
    renderEnabled(enabled);
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: MESSAGES.SET_ENABLED,
        payload: { enabled },
      });
    } catch {
      // SW is sleeping/restarting and the port closed before responding.
      // Roll back the optimistic flip — storage was not updated.
      renderEnabled(!enabled);
      return;
    }
    if (!response?.ok) {
      renderEnabled(!enabled);
      return;
    }
    // After re-enabling, the active tab's content script has just been told
    // to rescan. Pull fresh results into the popup once they trickle back.
    if (enabled) {
      setTimeout(() => loadResults().catch(() => {}), 600);
    }
  });

  pausedOptionsBtn?.addEventListener("click", openOptions);

  (async function init() {
    const hasBase = await loadBase();
    if (hasBase) await loadResults();
    refreshBudget().catch(() => {});
  })();
})();

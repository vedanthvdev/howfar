(function () {
  const MESSAGES = self.WDFMessages;
  const MODE_ORDER = self.WDFModeOrder;
  const form = document.getElementById("form");
  const addressInput = document.getElementById("address");
  const backendInput = document.getElementById("backend");
  const adminTokenInput = document.getElementById("admin-token");
  const enabledInput = document.getElementById("enabled");
  const toggleHint = document.getElementById("toggle-hint");
  const statusEl = document.getElementById("status");
  const saveBtn = document.getElementById("save");
  const clearBtn = document.getElementById("clear");
  const currentCard = document.getElementById("current");
  const currentAddr = document.getElementById("current-addr");
  const currentCoords = document.getElementById("current-coords");

  const TOGGLE_HINT_ON =
    "Scanning new addresses and showing badges on every page.";
  const TOGGLE_HINT_OFF =
    "Paused. No pages are scanned and no API calls are made.";

  function renderEnabled(enabled) {
    enabledInput.checked = !!enabled;
    if (toggleHint) {
      toggleHint.textContent = enabled ? TOGGLE_HINT_ON : TOGGLE_HINT_OFF;
    }
  }

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = `status ${kind ?? ""}`.trim();
  }

  function getUnits() {
    const selected = form.querySelector('input[name="units"]:checked');
    return selected?.value === "metric" ? "metric" : "imperial";
  }

  function setUnits(units) {
    const v = units === "metric" ? "metric" : "imperial";
    const el = form.querySelector(`input[name="units"][value="${v}"]`);
    if (el) el.checked = true;
  }

  function getModes() {
    const checked = Array.from(
      form.querySelectorAll('input[name="modes"]:checked')
    ).map((el) => el.value);
    const out = MODE_ORDER.filter((m) => checked.includes(m));
    return out.length > 0 ? out : [...MODE_ORDER];
  }

  function setModes(modes) {
    const set = new Set(Array.isArray(modes) && modes.length > 0 ? modes : MODE_ORDER);
    form.querySelectorAll('input[name="modes"]').forEach((el) => {
      el.checked = set.has(el.value);
    });
  }

  function renderCurrent(base) {
    if (!base) {
      currentCard.hidden = true;
      return;
    }
    currentCard.hidden = false;
    currentAddr.textContent = base.formattedAddress;
    currentCoords.textContent = `${base.lat.toFixed(5)}, ${base.lng.toFixed(5)} · placeId ${base.placeId}`;
  }

  // Flipped to `true` the first time the user touches the admin-token field.
  // Used as a guard against the auto-fetcher racing the user's keystrokes /
  // form submit.
  let adminTokenUserDirty = false;
  adminTokenInput.addEventListener("input", () => {
    adminTokenUserDirty = true;
  });

  async function load() {
    const s = await chrome.runtime.sendMessage({ type: MESSAGES.GET_BASE });
    renderEnabled(s?.enabled !== false);
    setUnits(s?.units ?? "imperial");
    setModes(s?.modes);
    backendInput.value = s?.backendUrl ?? "";
    adminTokenInput.value = s?.adminToken ?? "";
    if (s?.base) {
      addressInput.value = s.base.formattedAddress;
      renderCurrent(s.base);
    }
    if (s?.budget) renderBudget(s.budget);
    // If the field is empty AND the user hasn't started typing yet, try to
    // auto-fetch the token. The backend only exposes `/admin/token` on
    // loopback, so this is a no-op against remote backends.
    if (!adminTokenInput.value && !adminTokenUserDirty && s?.backendUrl) {
      tryAutoFetchAdminToken(s.backendUrl).catch(() => {});
    }
  }

  async function tryAutoFetchAdminToken(backendUrl) {
    const base = (backendUrl ?? "").replace(/\/$/, "");
    if (!base) return;
    try {
      const res = await fetch(`${base}/admin/token`, { cache: "no-store" });
      if (!res.ok) return;
      const body = await res.json();
      if (typeof body?.token !== "string" || !body.token) return;
      // Between fetch start and now the user may have started typing or even
      // submitted the form. Never clobber their input — only fill in when the
      // field is still empty AND untouched.
      if (adminTokenUserDirty || adminTokenInput.value) return;
      adminTokenInput.value = body.token;
      // Persist it so the service worker has it for future resets.
      await chrome.runtime.sendMessage({
        type: MESSAGES.SET_BASE,
        payload: { adminToken: body.token },
      });
    } catch {
      // Backend unreachable / doesn't expose /admin/token — no problem.
    }
  }

  // --- Budget UI -----------------------------------------------------------

  const budgetTripped = document.getElementById("budget-tripped");
  const budgetTrippedReason = document.getElementById("budget-tripped-reason");
  const usageFill = document.getElementById("usage-fill");
  const usageLabel = document.getElementById("usage-label");
  const usagePercent = document.getElementById("usage-percent");
  const usageCounts = document.getElementById("usage-counts");
  const budgetResetBtn = document.getElementById("budget-reset");
  const budgetRefreshBtn = document.getElementById("budget-refresh");
  const budgetStatusEl = document.getElementById("budget-status");

  function fmtUsd(n) {
    const v = Number.isFinite(n) ? n : 0;
    return `$${v.toFixed(2)}`;
  }

  function setBudgetStatus(text, kind) {
    budgetStatusEl.textContent = text;
    budgetStatusEl.className = `status ${kind ?? ""}`.trim();
  }

  const budgetBlurb = document.getElementById("budget-blurb");

  function renderBlurb(budget) {
    if (!budgetBlurb) return;
    if (budget?.cap > 0) {
      budgetBlurb.textContent =
        `The backend stops calling Google once estimated spend reaches ` +
        `${fmtUsd(budget.cap)} in the current month. Adjust the cap with ` +
        `BUDGET_MONTHLY_USD_CAP in the backend .env.`;
    }
  }

  function renderBudget(budget) {
    if (!budget) return;
    if (budget.reachable === false) {
      usageLabel.textContent = "Backend unreachable";
      usagePercent.textContent = "—";
      usageCounts.textContent = budget.error ?? "";
      usageFill.style.width = "0%";
      usageFill.className = "usage__fill usage__fill--muted";
      budgetTripped.hidden = true;
      return;
    }
    renderBlurb(budget);
    const pct = Math.max(0, Math.min(100, Number(budget.percent ?? 0)));
    usageFill.style.width = `${pct}%`;
    usageFill.className = "usage__fill";
    if (budget.tripped) usageFill.classList.add("usage__fill--err");
    else if (pct >= 80) usageFill.classList.add("usage__fill--warn");
    usageLabel.textContent = `${fmtUsd(budget.estimatedUsd)} / ${fmtUsd(budget.cap)} · ${budget.month || "—"}`;
    usagePercent.textContent = `${pct.toFixed(1)}%`;
    const g = budget.counts?.geocode ?? 0;
    const d = budget.counts?.directions ?? 0;
    const persistNote = budget.persistError
      ? ` · ⚠ persist failed: ${budget.persistError}`
      : "";
    usageCounts.textContent =
      `${g.toLocaleString()} geocoding · ${d.toLocaleString()} directions calls this month` +
      persistNote;
    if (budget.tripped) {
      budgetTripped.hidden = false;
      budgetTrippedReason.textContent = budget.trippedReason
        ? ` ${budget.trippedReason}`
        : "";
    } else {
      budgetTripped.hidden = true;
    }
  }

  async function refreshBudget() {
    setBudgetStatus("Fetching…");
    const budget = await chrome.runtime.sendMessage({
      type: MESSAGES.GET_BUDGET,
      payload: { force: true },
    });
    renderBudget(budget);
    if (budget?.reachable === false) {
      setBudgetStatus(`Backend unreachable: ${budget.error ?? "unknown"}`, "error");
    } else {
      setBudgetStatus("");
    }
  }

  budgetResetBtn.addEventListener("click", async () => {
    budgetResetBtn.disabled = true;
    setBudgetStatus("Resetting…");
    const response = await chrome.runtime.sendMessage({
      type: MESSAGES.RESET_BUDGET,
    });
    budgetResetBtn.disabled = false;
    if (!response?.ok) {
      setBudgetStatus(response?.error ?? "Failed to reset", "error");
      return;
    }
    renderBudget(response.budget);
    setBudgetStatus("Quota reset. Scanning resumed.", "success");
  });

  budgetRefreshBtn.addEventListener("click", () => {
    refreshBudget().catch((err) =>
      setBudgetStatus(err?.message ?? String(err), "error")
    );
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === MESSAGES.BUDGET_UPDATED) renderBudget(msg.payload);
    else if (msg?.type === MESSAGES.ENABLED_CHANGED) {
      renderEnabled(msg.payload?.enabled !== false);
    }
  });

  enabledInput.addEventListener("change", async () => {
    const enabled = enabledInput.checked;
    // Optimistic UI: flip hint immediately, even before the SW confirms. The
    // checkbox is already in the new state per the browser default. If the
    // SW rejects, we'll resync from its response.
    renderEnabled(enabled);
    const response = await chrome.runtime.sendMessage({
      type: MESSAGES.SET_ENABLED,
      payload: { enabled },
    });
    if (!response?.ok) {
      renderEnabled(!enabled);
      setStatus(response?.error ?? "Failed to update", "error");
      return;
    }
    setStatus(enabled ? "HowFar enabled." : "HowFar disabled.", "success");
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const address = addressInput.value.trim();
    const units = getUnits();
    const backendUrl = backendInput.value.trim();
    const modes = getModes();

    saveBtn.disabled = true;
    setStatus("Saving…");

    const adminToken = adminTokenInput.value.trim();
    const response = await chrome.runtime.sendMessage({
      type: MESSAGES.SET_BASE,
      payload: { address, units, backendUrl, modes, adminToken },
    });

    saveBtn.disabled = false;

    if (!response?.ok) {
      setStatus(response?.error ?? "Failed to save", "error");
      return;
    }
    if (response.base) {
      renderCurrent(response.base);
      addressInput.value = response.base.formattedAddress;
    }
    setStatus("Saved.", "success");
  });

  clearBtn.addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({ type: MESSAGES.CLEAR_BASE });
    if (response?.ok) {
      renderCurrent(null);
      addressInput.value = "";
      setStatus("Base cleared.", "success");
    }
  });

  load();
  refreshBudget().catch(() => {});
})();

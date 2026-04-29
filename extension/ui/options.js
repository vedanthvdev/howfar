(function () {
  const MESSAGES = self.WDFMessages;
  const MODE_ORDER = self.WDFModeOrder;

  // Form (non-wizard) elements
  const form = document.getElementById("form");
  const addressInput = document.getElementById("address");
  const apiKeyInput = document.getElementById("api-key");
  const enabledInput = document.getElementById("enabled");
  const toggleHint = document.getElementById("toggle-hint");
  const statusEl = document.getElementById("status");
  const saveBtn = document.getElementById("save");
  const clearBtn = document.getElementById("clear");
  const setupAgainLink = document.getElementById("setup-again");
  const currentCard = document.getElementById("current");
  const currentAddr = document.getElementById("current-addr");
  const currentCoords = document.getElementById("current-coords");

  // Budget
  const budgetCard = document.getElementById("budget");
  const budgetTripped = document.getElementById("budget-tripped");
  const budgetTrippedReason = document.getElementById("budget-tripped-reason");
  const usageFill = document.getElementById("usage-fill");
  const usageLabel = document.getElementById("usage-label");
  const usagePercent = document.getElementById("usage-percent");
  const usageCounts = document.getElementById("usage-counts");
  const budgetCapInput = document.getElementById("budget-cap");
  const budgetSaveCapBtn = document.getElementById("budget-save-cap");
  const budgetResetBtn = document.getElementById("budget-reset");
  const budgetStatusEl = document.getElementById("budget-status");

  // Wizard
  const wizardSection = document.getElementById("wizard");
  const wizardDots = Array.from(document.querySelectorAll(".wizard__dot"));
  const wizardPanels = Array.from(document.querySelectorAll(".wizard__panel"));
  const wizardKeyInput = document.getElementById("wizard-key");
  const wizardKeySaveBtn = document.getElementById("wizard-key-save");
  const wizardKeyStatus = document.getElementById("wizard-key-status");
  const wizardAddressInput = document.getElementById("wizard-address");
  const wizardAddressSaveBtn = document.getElementById("wizard-address-save");
  const wizardAddressStatus = document.getElementById("wizard-address-status");

  const TOGGLE_HINT_ON = "Scanning new addresses and showing badges on every page.";
  const TOGGLE_HINT_OFF = "Paused. No pages are scanned and no API calls are made.";

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = `status ${kind ?? ""}`.trim();
  }

  function setBudgetStatus(text, kind) {
    budgetStatusEl.textContent = text;
    budgetStatusEl.className = `status ${kind ?? ""}`.trim();
  }

  function renderEnabled(enabled) {
    enabledInput.checked = !!enabled;
    if (toggleHint) {
      toggleHint.textContent = enabled ? TOGGLE_HINT_ON : TOGGLE_HINT_OFF;
    }
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

  function fmtUsd(n) {
    const v = Number.isFinite(n) ? n : 0;
    return `$${v.toFixed(2)}`;
  }

  function renderBudget(budget) {
    if (!budget) return;
    budgetCard.hidden = false;
    const pct = Math.max(0, Math.min(100, Number(budget.percent ?? 0)));
    usageFill.style.width = `${pct}%`;
    usageFill.className = "usage__fill";
    if (budget.tripped) usageFill.classList.add("usage__fill--err");
    else if (pct >= 80) usageFill.classList.add("usage__fill--warn");
    usageLabel.textContent = `${fmtUsd(budget.estimatedUsd)} / ${fmtUsd(budget.cap)} · ${budget.month || "—"}`;
    usagePercent.textContent = `${pct.toFixed(1)}%`;
    const g = budget.counts?.geocode ?? 0;
    const d = budget.counts?.directions ?? 0;
    usageCounts.textContent =
      `${g.toLocaleString()} geocoding · ${d.toLocaleString()} directions calls this month`;
    if (budget.tripped) {
      budgetTripped.hidden = false;
      budgetTrippedReason.textContent = budget.trippedReason ? ` ${budget.trippedReason}` : "";
    } else {
      budgetTripped.hidden = true;
    }
    // Surface storage-write failures inline so users notice when the
    // persisted spend is silently lagging reality (the cap can drift
    // backwards across SW restarts otherwise).
    if (budget.persistError) {
      setBudgetStatus(
        `Storage write is failing — usage may be undercounted: ${budget.persistError}`,
        "error"
      );
    }
    if (budgetCapInput && document.activeElement !== budgetCapInput) {
      budgetCapInput.value = String(Math.round(budget.cap));
    }
  }

  // --- Wizard helpers ----------------------------------------------------

  let wizardActive = false;

  function showWizard(step = 1) {
    wizardActive = true;
    wizardSection.hidden = false;
    form.hidden = true;
    currentCard.hidden = true;
    budgetCard.hidden = true;
    goToStep(step);
  }

  function hideWizard() {
    wizardActive = false;
    wizardSection.hidden = true;
    form.hidden = false;
    // currentCard / budgetCard visibility decided by data load.
  }

  function goToStep(step) {
    wizardPanels.forEach((p) => {
      p.hidden = String(p.dataset.step) !== String(step);
    });
    wizardDots.forEach((d) => {
      const n = Number(d.dataset.step);
      d.classList.toggle("is-active", n === step);
      d.classList.toggle("is-done", n < step);
    });
    // Auto-focus the first interactive element in the new step.
    const panel = wizardPanels.find((p) => Number(p.dataset.step) === step);
    if (panel) {
      const focusable = panel.querySelector("input, button");
      if (focusable && typeof focusable.focus === "function") {
        setTimeout(() => focusable.focus(), 30);
      }
    }
  }

  // Step navigation buttons (data-go="N").
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const step = t.getAttribute("data-go");
    if (step) {
      e.preventDefault();
      goToStep(Number(step));
    }
  });

  function setWizardKeyStatus(text, kind) {
    wizardKeyStatus.textContent = text;
    wizardKeyStatus.className = `status ${kind ?? ""}`.trim();
  }
  function setWizardAddressStatus(text, kind) {
    wizardAddressStatus.textContent = text;
    wizardAddressStatus.className = `status ${kind ?? ""}`.trim();
  }

  /**
   * Helper: run an async fn while keeping a button disabled. The button is
   * always re-enabled in `finally`, so a thrown sendMessage rejection (e.g.
   * the SW being recycled mid-flow) doesn't leave the user staring at a
   * permanently grey button.
   */
  async function withDisabled(btn, fn) {
    if (btn) btn.disabled = true;
    try {
      return await fn();
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /**
   * Validate-then-save flow shared by the wizard step 3 and the regular form.
   * Returns true on success so callers can advance / show success state.
   */
  async function validateAndSaveKey(key, statusFn) {
    const trimmed = (key ?? "").trim();
    if (!trimmed) {
      statusFn("Paste your API key first.", "error");
      return false;
    }
    statusFn("Validating with Google…");
    let result;
    try {
      result = await chrome.runtime.sendMessage({
        type: MESSAGES.VALIDATE_KEY,
        payload: { apiKey: trimmed },
      });
    } catch (err) {
      statusFn(`Validation failed: ${err?.message ?? err}`, "error");
      return false;
    }
    if (!result?.ok) {
      const reason = result?.reason ?? "Unknown error";
      const status = result?.status ? ` (${result.status})` : "";
      statusFn(`Google rejected the key${status}: ${reason}`, "error");
      return false;
    }
    let saveResp;
    try {
      saveResp = await chrome.runtime.sendMessage({
        type: MESSAGES.SET_API_KEY,
        payload: { apiKey: trimmed },
      });
    } catch (err) {
      statusFn(`Save failed: ${err?.message ?? err}`, "error");
      return false;
    }
    if (!saveResp?.ok) {
      statusFn(saveResp?.error ?? "Failed to save key.", "error");
      return false;
    }
    statusFn("Key validated and saved.", "success");
    return true;
  }

  wizardKeySaveBtn.addEventListener("click", async () => {
    const ok = await withDisabled(wizardKeySaveBtn, () =>
      validateAndSaveKey(wizardKeyInput.value, setWizardKeyStatus)
    );
    if (ok) {
      // Mirror into the main form so a later "Run setup again" sees it.
      apiKeyInput.value = wizardKeyInput.value.trim();
      setTimeout(() => goToStep(4), 350);
    }
  });

  /**
   * If the user re-enters the wizard with a tripped breaker, geocoding the
   * base address fails with code:"quota_exhausted" and there's no in-wizard
   * way to clear it. Offer a one-click reset that runs RESET_BUDGET and
   * retries the address save.
   */
  async function offerBudgetResetAndRetry(addr) {
    setWizardAddressStatus(
      "Monthly budget breaker is tripped. Resetting and retrying…"
    );
    let resetResp;
    try {
      resetResp = await chrome.runtime.sendMessage({ type: MESSAGES.RESET_BUDGET });
    } catch (err) {
      setWizardAddressStatus(
        `Reset failed: ${err?.message ?? err}. Open the main form and try again.`,
        "error"
      );
      return null;
    }
    if (!resetResp?.ok) {
      setWizardAddressStatus(
        resetResp?.error ?? "Reset failed. Open the main form and try again.",
        "error"
      );
      return null;
    }
    try {
      return await chrome.runtime.sendMessage({
        type: MESSAGES.SET_BASE,
        payload: { address: addr },
      });
    } catch (err) {
      setWizardAddressStatus(`Save failed: ${err?.message ?? err}`, "error");
      return null;
    }
  }

  wizardAddressSaveBtn.addEventListener("click", async () => {
    const addr = wizardAddressInput.value.trim();
    if (!addr) {
      setWizardAddressStatus("Enter an address.", "error");
      return;
    }
    await withDisabled(wizardAddressSaveBtn, async () => {
      setWizardAddressStatus("Geocoding with Google…");
      let resp;
      try {
        resp = await chrome.runtime.sendMessage({
          type: MESSAGES.SET_BASE,
          payload: { address: addr },
        });
      } catch (err) {
        setWizardAddressStatus(`Save failed: ${err?.message ?? err}`, "error");
        return;
      }
      // Auto-recover from a tripped breaker once — saves the user a trip
      // out of the wizard for a state they probably didn't even know about.
      if (!resp?.ok && resp?.code === "quota_exhausted") {
        resp = await offerBudgetResetAndRetry(addr);
        if (!resp) return;
      }
      if (!resp?.ok) {
        setWizardAddressStatus(resp?.error ?? "Failed to save base.", "error");
        return;
      }
      setWizardAddressStatus(`Saved: ${resp.base.formattedAddress}`, "success");
      addressInput.value = resp.base.formattedAddress;
      renderCurrent(resp.base);
      // Brief delay so the user sees the success state, then exit wizard.
      setTimeout(() => {
        hideWizard();
        setStatus("All set. HowFar is ready to go.", "success");
      }, 800);
    });
  });

  setupAgainLink?.addEventListener("click", (e) => {
    e.preventDefault();
    // Pre-fill wizard with existing values so users don't lose work.
    wizardKeyInput.value = apiKeyInput.value ?? "";
    wizardAddressInput.value = addressInput.value ?? "";
    setWizardKeyStatus("");
    setWizardAddressStatus("");
    showWizard(1);
  });

  // --- Standard form ----------------------------------------------------

  // Cached snapshot of the persisted apiKey so the form-submit path can
  // compare new vs old without a second round-trip. Populated on load().
  let cachedApiKey = "";

  async function load() {
    let s;
    try {
      s = await chrome.runtime.sendMessage({ type: MESSAGES.GET_BASE });
    } catch (err) {
      setStatus(`Could not reach HowFar service worker: ${err?.message ?? err}. Reload this page.`, "error");
      return;
    }
    renderEnabled(s?.enabled !== false);
    setUnits(s?.units ?? "imperial");
    setModes(s?.modes);
    if (s?.base) {
      addressInput.value = s.base.formattedAddress;
      renderCurrent(s.base);
    }
    if (s?.budget) renderBudget(s.budget);

    const hasApiKey = Boolean(s?.hasApiKey);
    // Fetch the actual key only for the (trusted) options page so we can
    // pre-fill the password input without leaking it to content scripts.
    if (hasApiKey) {
      try {
        const resp = await chrome.runtime.sendMessage({ type: MESSAGES.GET_API_KEY });
        if (resp?.ok && typeof resp.apiKey === "string") {
          cachedApiKey = resp.apiKey;
          apiKeyInput.value = cachedApiKey;
        }
      } catch {
        // Couldn't fetch — leave the field empty; user can paste a new key.
      }
    } else {
      cachedApiKey = "";
      apiKeyInput.value = "";
    }

    // First-run: no API key configured → take over with the wizard.
    if (!hasApiKey) {
      showWizard(1);
    } else {
      hideWizard();
    }
  }

  budgetSaveCapBtn?.addEventListener("click", async () => {
    const cap = Number(budgetCapInput.value);
    if (!Number.isFinite(cap) || cap <= 0) {
      setBudgetStatus("Cap must be a positive number.", "error");
      return;
    }
    await withDisabled(budgetSaveCapBtn, async () => {
      let resp;
      try {
        resp = await chrome.runtime.sendMessage({
          type: MESSAGES.SET_BUDGET_CAP,
          payload: { cap },
        });
      } catch (err) {
        setBudgetStatus(`Save failed: ${err?.message ?? err}`, "error");
        return;
      }
      if (!resp?.ok) {
        setBudgetStatus(resp?.error ?? "Failed to save cap.", "error");
        return;
      }
      renderBudget(resp.budget);
      setBudgetStatus("Cap updated.", "success");
    });
  });

  budgetResetBtn.addEventListener("click", async () => {
    await withDisabled(budgetResetBtn, async () => {
      setBudgetStatus("Resetting…");
      let resp;
      try {
        resp = await chrome.runtime.sendMessage({ type: MESSAGES.RESET_BUDGET });
      } catch (err) {
        setBudgetStatus(`Reset failed: ${err?.message ?? err}`, "error");
        return;
      }
      if (!resp?.ok) {
        setBudgetStatus(resp?.error ?? "Failed to reset.", "error");
        return;
      }
      renderBudget(resp.budget);
      setBudgetStatus("Counter reset. Scanning resumed.", "success");
    });
  });

  enabledInput.addEventListener("change", async () => {
    const enabled = enabledInput.checked;
    renderEnabled(enabled);
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: MESSAGES.SET_ENABLED,
        payload: { enabled },
      });
    } catch {
      renderEnabled(!enabled);
      return;
    }
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
    const modes = getModes();
    const apiKey = apiKeyInput.value.trim();

    await withDisabled(saveBtn, async () => {
      // 1. API key handling — validate new key, persist a clear.
      if (apiKey && apiKey !== cachedApiKey) {
        const ok = await validateAndSaveKey(apiKey, setStatus);
        if (!ok) return;
        cachedApiKey = apiKey;
      } else if (!apiKey && cachedApiKey) {
        try {
          await chrome.runtime.sendMessage({
            type: MESSAGES.SET_API_KEY,
            payload: { apiKey: "" },
          });
          cachedApiKey = "";
        } catch (err) {
          setStatus(`Could not clear key: ${err?.message ?? err}`, "error");
          return;
        }
        // Cleared the key — the SET_BASE call below would fail with
        // needs_setup anyway, so jump straight to the wizard. The user
        // hasn't lost any state; the saved address is preserved.
        setStatus("API key cleared. Walk through setup to add a new one.", "success");
        showWizard(1);
        return;
      }

      // 2. Settings + base.
      setStatus("Saving…");
      let response;
      try {
        response = await chrome.runtime.sendMessage({
          type: MESSAGES.SET_BASE,
          payload: { address, units, modes },
        });
      } catch (err) {
        setStatus(`Save failed: ${err?.message ?? err}`, "error");
        return;
      }
      if (!response?.ok) {
        // Setup-required errors should put the user back on the wizard
        // rather than just staring at an inline error.
        if (response?.code === "needs_setup") {
          setStatus(response.error ?? "Setup needed.", "error");
          showWizard(1);
          return;
        }
        setStatus(response?.error ?? "Failed to save", "error");
        return;
      }
      if (response.base) {
        renderCurrent(response.base);
        addressInput.value = response.base.formattedAddress;
      }
      setStatus("Saved.", "success");
    });
  });

  clearBtn.addEventListener("click", async () => {
    await withDisabled(clearBtn, async () => {
      let response;
      try {
        response = await chrome.runtime.sendMessage({ type: MESSAGES.CLEAR_BASE });
      } catch (err) {
        setStatus(`Clear failed: ${err?.message ?? err}`, "error");
        return;
      }
      if (!response?.ok) {
        setStatus(response?.error ?? "Failed to clear base.", "error");
        return;
      }
      renderCurrent(null);
      addressInput.value = "";
      setStatus("Base cleared.", "success");
    });
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === MESSAGES.BUDGET_UPDATED) renderBudget(msg.payload);
    else if (msg?.type === MESSAGES.ENABLED_CHANGED) {
      renderEnabled(msg.payload?.enabled !== false);
    } else if (msg?.type === MESSAGES.API_KEY_CHANGED) {
      // Another extension page (or this one's previous tab) toggled the
      // key. Refresh from storage so cachedApiKey + the input stay in sync.
      load().catch(() => {});
    }
  });

  load();
})();

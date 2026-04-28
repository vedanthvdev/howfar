/**
 * Renders badges next to candidate anchors. Badges have four visual states:
 *   - loading
 *   - ok       (at least one mode resolved)
 *   - warn     (ambiguous or every requested mode lacks a route)
 *   - error    (resolver failure / address not found)
 *
 * The "ok" badge is multi-mode: it shows distance plus per-mode durations,
 * e.g. "1.6 mi · 🚶 32m · 🚗 8m · 🚴 12m".
 */
(function (root) {
  const BADGE_CLASS = "howfar-badge";
  const BADGE_ATTR = "data-howfar-candidate";
  const MODE_ORDER = root.WDFModeOrder ?? ["walk", "drive", "cycle"];
  const MODE_ICONS = root.WDFModeIcons ?? { walk: "🚶", drive: "🚗", cycle: "🚴" };
  const MODE_LABELS =
    root.WDFModeLabels ?? { walk: "Walk", drive: "Drive", cycle: "Cycle" };

  function shortDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
  }

  function modeChip(mode, outcome) {
    const icon = MODE_ICONS[mode] ?? "·";
    if (!outcome || outcome.status === "no_route") {
      return `${icon} —`;
    }
    if (outcome.status !== "ok") {
      return `${icon} ?`;
    }
    const dur =
      outcome.displayDuration ?? shortDuration(outcome.durationSec ?? -1);
    return `${icon} ${dur}`;
  }

  function ensureBadge(anchor, candidateId) {
    if (!(anchor instanceof HTMLElement)) return null;
    const existing = anchor.querySelector(
      `.${BADGE_CLASS}[${BADGE_ATTR}="${candidateId}"]`
    );
    if (existing) return existing;

    const badge = document.createElement("span");
    badge.className = `${BADGE_CLASS} ${BADGE_CLASS}--loading`;
    badge.setAttribute(BADGE_ATTR, candidateId);
    badge.setAttribute("role", "status");
    badge.setAttribute("aria-live", "polite");
    badge.textContent = "…";

    if (anchor.tagName === "A" || anchor.tagName === "SPAN") {
      anchor.insertAdjacentElement("afterend", badge);
    } else {
      anchor.appendChild(badge);
    }
    return badge;
  }

  function buildOkText(result) {
    const modes = result.modes ?? {};
    const present = MODE_ORDER.filter((m) => modes[m]);
    const distance = result.displayDistance;
    const chips = present.map((m) => modeChip(m, modes[m]));

    // If only one mode is present, keep the legacy compact form.
    if (present.length <= 1 && distance) {
      const only = present[0];
      const outcome = only ? modes[only] : undefined;
      const icon = MODE_ICONS[only] ?? "🚶";
      const dur =
        outcome?.displayDuration ?? shortDuration(outcome?.durationSec ?? -1);
      return `${icon} ${distance}${dur ? ` · ${dur}` : ""}`;
    }

    if (distance && chips.length > 0) return `${distance} · ${chips.join(" · ")}`;
    if (chips.length > 0) return chips.join(" · ");
    return distance ?? "";
  }

  function buildTooltip(result) {
    const lines = [];
    if (result.formattedAddress) lines.push(result.formattedAddress);
    const modes = result.modes ?? {};
    for (const m of MODE_ORDER) {
      const o = modes[m];
      if (!o) continue;
      const label = MODE_LABELS[m] ?? m;
      if (o.status === "ok") {
        const parts = [];
        if (o.displayDistance) parts.push(o.displayDistance);
        if (o.displayDuration) parts.push(o.displayDuration);
        lines.push(`${label}: ${parts.join(" · ")}`);
      } else if (o.status === "no_route") {
        lines.push(`${label}: no route`);
      } else {
        lines.push(`${label}: error${o.error ? ` (${o.error})` : ""}`);
      }
    }
    return lines.join("\n");
  }

  function allModesNoRoute(result) {
    const modes = result.modes ?? {};
    const entries = Object.values(modes);
    if (entries.length === 0) return false;
    return entries.every((o) => o && o.status === "no_route");
  }

  function setBadgeState(badge, result) {
    if (!badge) return;
    badge.classList.remove(
      `${BADGE_CLASS}--loading`,
      `${BADGE_CLASS}--ok`,
      `${BADGE_CLASS}--warn`,
      `${BADGE_CLASS}--error`,
      `${BADGE_CLASS}--paused`
    );

    const s = result.status;
    if (s === "loading") {
      badge.classList.add(`${BADGE_CLASS}--loading`);
      badge.textContent = "…";
      badge.title = "";
      return;
    }

    // `paused` is distinct from `error`: we never called Google because the
    // monthly budget ran out. Show a calm "paused" chip so the user knows
    // this isn't a failure — they just need to reset the quota / wait for
    // the new month.
    if (s === "paused") {
      badge.classList.add(`${BADGE_CLASS}--paused`);
      badge.textContent = "paused";
      badge.title = result.error ?? "Scanning paused — monthly budget reached.";
      return;
    }

    if (s === "ok" || s === "ambiguous") {
      if (allModesNoRoute(result)) {
        badge.classList.add(`${BADGE_CLASS}--warn`);
        badge.textContent = "no route";
        badge.title = buildTooltip(result);
        return;
      }
      badge.classList.add(s === "ambiguous" ? `${BADGE_CLASS}--warn` : `${BADGE_CLASS}--ok`);
      const text = buildOkText(result);
      badge.textContent = s === "ambiguous" ? `${text} (approx.)` : text;
      badge.title = buildTooltip(result);
      return;
    }

    if (s === "not_found") {
      badge.classList.add(`${BADGE_CLASS}--warn`);
      badge.textContent = "address not found";
      badge.title = "";
      return;
    }

    badge.classList.add(`${BADGE_CLASS}--error`);
    badge.textContent = "unavailable";
    badge.title = result.error ?? "";
  }

  function removeAllBadges() {
    for (const b of document.querySelectorAll(`.${BADGE_CLASS}`)) b.remove();
  }

  root.WDFAnnotator = Object.freeze({
    BADGE_CLASS,
    ensureBadge,
    setBadgeState,
    removeAllBadges,
  });
})(typeof self !== "undefined" ? self : globalThis);

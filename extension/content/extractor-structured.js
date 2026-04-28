/**
 * Structured address extraction. Tries sources in priority order:
 *   1. <address> elements
 *   2. JSON-LD schema.org PostalAddress
 *   3. Microdata (itemtype=schema.org/PostalAddress)
 *   4. Map-service links (google, apple, openstreetmap, bing)
 *
 * Each found candidate carries an `anchor` Element (for annotation) and a
 * `text` payload (for the backend).
 */
(function (root) {
  const MAP_HOSTS = /(?:google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|goo\.gl\/maps|apple\.com\/maps|openstreetmap\.org|osm\.org|bing\.com\/maps)/i;

  function isHidden(el) {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return true;
    const rect = el.getBoundingClientRect();
    return rect.width === 0 && rect.height === 0;
  }

  function textFromAddressEl(el) {
    return el.textContent?.replace(/\s+/g, " ").trim() ?? "";
  }

  function postalAddressToText(pa) {
    if (!pa || typeof pa !== "object") return "";
    if (typeof pa.name === "string" && pa.streetAddress === undefined) {
      return pa.name.trim();
    }
    const parts = [
      pa.streetAddress,
      pa.addressLocality,
      pa.addressRegion,
      pa.postalCode,
      pa.addressCountry && (typeof pa.addressCountry === "object"
        ? pa.addressCountry.name
        : pa.addressCountry),
    ]
      .filter((p) => typeof p === "string" && p.trim())
      .map((p) => p.trim());
    return parts.join(", ");
  }

  function walkJsonLd(node, out) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((n) => walkJsonLd(n, out));
      return;
    }
    const type = node["@type"];
    const types = Array.isArray(type) ? type : [type];
    if (types.includes("PostalAddress")) {
      const t = postalAddressToText(node);
      if (t) out.push(t);
    }
    if (node.address) walkJsonLd(node.address, out);
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (v && typeof v === "object") walkJsonLd(v, out);
    }
  }

  function extractFromAddressTags() {
    const out = [];
    for (const el of document.querySelectorAll("address")) {
      if (isHidden(el)) continue;
      const text = textFromAddressEl(el);
      if (text && text.length >= 8 && /\d/.test(text)) {
        out.push({ source: "address_tag", text, anchor: el });
      }
    }
    return out;
  }

  function extractFromJsonLd() {
    const out = [];
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      let parsed;
      try {
        parsed = JSON.parse(s.textContent ?? "");
      } catch {
        continue;
      }
      const texts = [];
      walkJsonLd(parsed, texts);
      for (const text of texts) {
        out.push({ source: "jsonld", text, anchor: null });
      }
    }
    return out;
  }

  function extractFromMicrodata() {
    const out = [];
    const roots = document.querySelectorAll(
      '[itemtype$="PostalAddress"], [itemtype*="PostalAddress"]'
    );
    for (const el of roots) {
      if (isHidden(el)) continue;
      const props = {};
      for (const p of el.querySelectorAll("[itemprop]")) {
        const key = p.getAttribute("itemprop");
        if (!key) continue;
        props[key] = (p.getAttribute("content") ?? p.textContent ?? "").trim();
      }
      const text = postalAddressToText(props);
      if (text) out.push({ source: "microdata", text, anchor: el });
    }
    return out;
  }

  function extractFromMapLinks() {
    const out = [];
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") ?? "";
      if (!MAP_HOSTS.test(href)) continue;
      if (isHidden(a)) continue;
      // Prefer the link text since it usually reads as an address.
      let text = (a.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!text || text.length < 6 || !/\d/.test(text)) {
        // Fallback: try to pull the "q=" or "query=" param.
        try {
          const u = new URL(href, location.href);
          const q =
            u.searchParams.get("q") ||
            u.searchParams.get("query") ||
            u.searchParams.get("daddr");
          if (q && /\d/.test(q)) text = decodeURIComponent(q);
        } catch {
          // ignore
        }
      }
      if (text && text.length >= 6 && /\d/.test(text)) {
        out.push({ source: "map_link", text, anchor: a });
      }
    }
    return out;
  }

  root.WDFStructuredExtractor = Object.freeze({
    extractFromAddressTags,
    extractFromJsonLd,
    extractFromMicrodata,
    extractFromMapLinks,
    isHidden,
  });
})(typeof self !== "undefined" ? self : globalThis);

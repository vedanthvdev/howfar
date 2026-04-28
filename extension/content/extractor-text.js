/**
 * Heuristic text-based extraction. Walks visible text nodes and runs
 * conservative regexes that catch common street-address shapes.
 *
 * We deliberately bias toward precision. Anything questionable is dropped;
 * the backend is the source of truth on whether a candidate is real.
 */
(function (root) {
  const BLOCK_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "CODE",
    "PRE",
    "TEMPLATE",
    "IFRAME",
    "OBJECT",
    "SVG",
    "CANVAS",
  ]);

  // A "number + street" opener, e.g. "221B Baker Street" or "10 Downing St".
  // Up to 6 street-name words, then a thoroughfare suffix.
  // Suffix list is intentionally broad, including UK/Scottish thoroughfares
  // (Wynd, Brae, Loan, March, Gardens, …).
  const STREET_REGEX = new RegExp(
    [
      "\\b\\d{1,6}[A-Za-z]?\\s",
      "(?:[A-Z][A-Za-z'’.-]+\\s){0,6}",
      "(?:",
      "Street|St\\.?|Road|Rd\\.?|Avenue|Ave\\.?|Boulevard|Blvd\\.?|",
      "Drive|Dr\\.?|Lane|Ln\\.?|Way|Court|Ct\\.?|Place|Pl\\.?|",
      "Square|Sq\\.?|Terrace|Ter\\.?|Parkway|Pkwy\\.?|Highway|Hwy\\.?|",
      "Row|Close|Crescent|Cres\\.?|Mews|Walk|",
      "Gardens?|Park|Grove|Green|Hill|Bridge|Vale|Gate|Rise|View|",
      "Heights|Quay|Wharf|Circus|Circle|March|Loan|Brae|Wynd|Path|",
      "Esplanade|Promenade|Boulevard",
      ")\\b",
    ].join(""),
    "g"
  );

  // US ZIP at the end of a line e.g. ", MA 02139" or ", CA 94107".
  const US_ZIP_REGEX = /\b([A-Z]{2})\s(\d{5}(?:-\d{4})?)\b/;
  const US_ZIP_GLOBAL = /\b([A-Z]{2})\s(\d{5}(?:-\d{4})?)\b/g;

  // UK postcode, e.g. "SW1A 1AA", "NW1 6XE".
  const UK_POSTCODE_REGEX =
    /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/;
  const UK_POSTCODE_GLOBAL =
    /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g;

  // Chars we treat as hard boundaries when walking backwards from a postcode.
  // Keeps us from dragging in "Semi-Detached Bungalow : " style prefixes.
  const BACK_BOUNDARY = /[:;|\n\r\t•\u2022·]/;

  // Memoization cache for elementText. Keyed by the element itself via
  // WeakMap so entries are GC'd when the DOM changes. A single scan can
  // invoke elementText many times on overlapping ancestors (the climb
  // extractor especially), so memoization matters.
  //
  // We replace the map between scans via resetElementTextCache() rather
  // than keep it across scans — the DOM may have mutated since last time.
  let elementTextCache = new WeakMap();

  function isBlocked(el) {
    if (!(el instanceof Element)) return false;
    if (BLOCK_TAGS.has(el.tagName)) return true;
    if (el.isContentEditable) return false;
    const ce = el.closest("[contenteditable='true']");
    if (ce) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return true;
    if (Number(style.opacity) === 0) return true;
    return false;
  }

  function enclosingAnchor(node) {
    let el = node.parentElement;
    while (el && el !== document.body) {
      if (
        el.tagName === "P" ||
        el.tagName === "LI" ||
        el.tagName === "ADDRESS" ||
        el.tagName === "DIV" ||
        el.tagName === "SPAN" ||
        el.tagName === "TD"
      ) {
        return el;
      }
      el = el.parentElement;
    }
    return node.parentElement ?? document.body;
  }

  function* iterateTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (isBlocked(parent)) return NodeFilter.FILTER_REJECT;
        const v = node.nodeValue;
        if (!v || v.trim().length < 8) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) yield node;
  }

  function expandToAddressChunk(text, matchStart, matchEnd) {
    // Extend forward through up to 3 comma-separated components and a postcode.
    let end = matchEnd;
    let commas = 0;
    while (end < text.length && commas < 4) {
      const ch = text[end];
      if (ch === "\n") break;
      if (ch === ",") commas += 1;
      end += 1;
      // stop when we reach a US ZIP or UK postcode
      const slice = text.slice(matchStart, end);
      if (US_ZIP_REGEX.test(slice) || UK_POSTCODE_REGEX.test(slice)) {
        // round out to the end of the postcode
        const mZip = slice.match(US_ZIP_REGEX);
        const mUk = slice.match(UK_POSTCODE_REGEX);
        const m = mZip ?? mUk;
        if (m && m.index !== undefined) {
          end = matchStart + m.index + m[0].length;
        }
        break;
      }
    }
    return text.slice(matchStart, end).replace(/\s+/g, " ").trim();
  }

  function extractFromText(root = document.body) {
    const out = [];
    for (const node of iterateTextNodes(root)) {
      const text = node.nodeValue ?? "";
      STREET_REGEX.lastIndex = 0;
      let m;
      while ((m = STREET_REGEX.exec(text))) {
        const chunk = expandToAddressChunk(text, m.index, m.index + m[0].length);
        if (chunk.length < 8 || chunk.length > 200) continue;
        out.push({
          source: "text_heuristic",
          text: chunk,
          anchor: enclosingAnchor(node),
        });
        if (out.length >= 50) return out;
      }
    }
    return out;
  }

  /**
   * Walks back from an index through plain text until a hard boundary.
   * Lets us lift e.g. "4 West Pilton March, EH4 4JG" out of
   * "Semi-Detached Bungalow : 4 West Pilton March, EH4 4JG".
   *
   * The `floor` argument clamps how far back we can walk — callers use it
   * to prevent fusing a candidate with an earlier postcode block.
   */
  function walkBackTo(text, end, maxChars = 180, floor = 0) {
    let i = end;
    const hardFloor = Math.max(0, floor);
    while (i > hardFloor) {
      const ch = text[i - 1];
      if (BACK_BOUNDARY.test(ch)) break;
      i -= 1;
      if (end - i >= maxChars) break;
    }
    return text.slice(i, end);
  }

  /**
   * Find the index just past the previous postcode/ZIP ending before
   * `before`. Returns 0 if there's no earlier postcode. Used as a floor
   * for walkBackTo so two consecutive addresses on the same line don't
   * fuse together.
   *
   * IMPORTANT: we instantiate fresh `/g` RegExps here rather than reusing
   * `UK_POSTCODE_GLOBAL` / `US_ZIP_GLOBAL`, because this helper is called
   * *inside* the callers' own `while ((m = rx.exec(text)))` loops over
   * those exact globals. Sharing state would reset their `lastIndex` to
   * 0 and send the outer loop into an infinite cycle on the very first
   * match — hanging the content script on any page containing a postcode.
   */
  function previousPostcodeEndBefore(text, before) {
    if (before <= 0) return 0;
    const prefix = text.slice(0, before);
    let floor = 0;
    const localRegexes = [
      /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g,
      /\b([A-Z]{2})\s(\d{5}(?:-\d{4})?)\b/g,
    ];
    for (const rx of localRegexes) {
      let m;
      while ((m = rx.exec(prefix))) {
        const end = m.index + m[0].length;
        if (end > floor) floor = end;
      }
    }
    return floor;
  }

  /**
   * Postcode-anchored extraction. Looks for UK postcodes or US ZIPs in text
   * and captures the preceding run as the candidate address. This catches
   * addresses whose street type isn't in the thoroughfare suffix list
   * (e.g. "4 West Pilton March" — "March" is rare but valid).
   */
  function extractByPostcode(root = document.body) {
    const out = [];
    for (const node of iterateTextNodes(root)) {
      const text = node.nodeValue ?? "";
      for (const rx of [UK_POSTCODE_GLOBAL, US_ZIP_GLOBAL]) {
        rx.lastIndex = 0;
        let m;
        while ((m = rx.exec(text))) {
          const postcodeEnd = m.index + m[0].length;
          const floor = previousPostcodeEndBefore(text, m.index);
          const raw = walkBackTo(text, postcodeEnd, 180, floor);
          // Strip leading non-address noise. If we can find a digit (the
          // likely house number), start the address from there; otherwise
          // just trim punctuation off the front.
          let cleaned = raw.replace(/\s+/g, " ").trim();
          const firstDigit = cleaned.search(/\d/);
          if (firstDigit > 0 && firstDigit < cleaned.length - m[0].length) {
            cleaned = cleaned.slice(firstDigit);
          }
          cleaned = cleaned.replace(/^[^A-Za-z0-9]+/, "").trim();
          if (cleaned.length < 8 || cleaned.length > 200) continue;
          // Require at least one digit outside the postcode (house number,
          // building number, etc.) — otherwise we'd lift bare postcodes like
          // "EH4 4JG" on their own, which are useless to Directions.
          const beforePostcode = cleaned.slice(0, cleaned.length - m[0].length);
          if (!/\d/.test(beforePostcode)) continue;
          out.push({
            source: "postcode_anchored",
            text: cleaned,
            anchor: enclosingAnchor(node),
          });
          if (out.length >= 50) return out;
        }
      }
    }
    return out;
  }

  /**
   * Block-level postcode extraction. Grabs `textContent` from elements that
   * tend to hold addresses, flattening whitespace between child nodes, and
   * runs postcode-anchored extraction on that.
   *
   * This is what catches property-listing pages that split an address across
   * many <li>/<span>/<div> children (so a single text node only contains
   * "9 Annfield Court" while the postcode is in a sibling).
   */
  const BLOCK_SELECTORS = [
    "address",
    "p",
    "li",
    "dd",
    "td",
    "figcaption",
    "article",
    "section",
    "[class*='address' i]",
    "[class*='addr' i]",
    "[class*='location' i]",
    "[data-testid*='address' i]",
  ].join(",");

  function elementText(el) {
    // Cache is scan-scoped: scanner.js calls resetElementTextCache() at the
    // top of every scan. Do not `await` between fills and reads within a
    // single scan — if the DOM mutates mid-scan the cache will serve stale
    // text. Today gatherAll() is fully synchronous, so this is safe.
    const cached = elementTextCache.get(el);
    if (cached !== undefined) return cached;
    // textContent concatenates descendant text nodes with no separator, which
    // can fuse "9 Annfield Court" + "Macmerry" into "9 Annfield CourtMacmerry".
    // We collect children manually and join with spaces instead.
    const parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || isBlocked(p)) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) parts.push(n.nodeValue.trim());
    const joined = parts
      .join(", ")
      .replace(/\s*,\s*,+/g, ", ")
      .replace(/\s+/g, " ")
      .trim();
    elementTextCache.set(el, joined);
    return joined;
  }

  /**
   * Clear the elementText memo. Callers (scanner) invoke this at the start
   * of each scan so we don't serve stale text after a DOM mutation.
   */
  function resetElementTextCache() {
    elementTextCache = new WeakMap();
  }

  /**
   * Given joined text that we know contains a postcode, extract the
   * `digits…street…postcode` substring. Shared helper used by both the block
   * and climb extractors.
   */
  function extractAddressFromJoined(text) {
    const out = [];
    for (const rx of [UK_POSTCODE_GLOBAL, US_ZIP_GLOBAL]) {
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(text))) {
        const postcodeEnd = m.index + m[0].length;
        const floor = previousPostcodeEndBefore(text, m.index);
        const raw = walkBackTo(text, postcodeEnd, 220, floor);
        let cleaned = raw.replace(/\s+/g, " ").trim();
        const firstDigit = cleaned.search(/\d/);
        if (firstDigit > 0 && firstDigit < cleaned.length - m[0].length) {
          cleaned = cleaned.slice(firstDigit);
        }
        cleaned = cleaned.replace(/^[^A-Za-z0-9]+/, "").trim();
        if (cleaned.length < 8 || cleaned.length > 220) continue;
        const before = cleaned.slice(0, cleaned.length - m[0].length);
        // Require at least one digit before the postcode (house number) so
        // we don't emit bare postcode-and-city strings.
        if (!/\d/.test(before)) continue;
        out.push(cleaned);
      }
    }
    return out;
  }

  function extractByPostcodeInBlocks(root = document.body) {
    const out = [];
    const seenElements = new WeakSet();
    for (const el of root.querySelectorAll(BLOCK_SELECTORS)) {
      if (seenElements.has(el) || isBlocked(el)) continue;
      // Skip giant containers; likely not a focused address block. 400 chars
      // is enough for multi-line addresses while keeping us out of wrappers
      // like the whole article body.
      const text = elementText(el);
      if (!text || text.length < 8 || text.length > 400) continue;
      // Must contain at least one postcode/ZIP to bother.
      if (!UK_POSTCODE_REGEX.test(text) && !US_ZIP_REGEX.test(text)) continue;
      seenElements.add(el);
      for (const cleaned of extractAddressFromJoined(text)) {
        out.push({ source: "postcode_block", text: cleaned, anchor: el });
        if (out.length >= 50) return out;
      }
    }
    return out;
  }

  /**
   * Postcode-climb extraction. Starts from every text node that contains a
   * postcode / ZIP and climbs up the DOM looking for the smallest ancestor
   * whose joined text contains BOTH the postcode and a house-number + street.
   *
   * This rescues addresses split across `<div>` siblings — e.g. a listing
   * card with "30 Whitson Road" in one child and "Edinburgh, EH11 3BU" in
   * another — where neither the single-node nor block-selector extractors
   * see the full string. Without this, the text-heuristic extractor would
   * emit the bare "30 Whitson Road" and Google geocodes to the wrong
   * continent.
   */
  function extractByPostcodeClimb(root = document.body) {
    const out = [];
    const claimedAncestors = new WeakSet();
    const MAX_HOPS = 5;
    for (const node of iterateTextNodes(root)) {
      const text = node.nodeValue ?? "";
      if (!UK_POSTCODE_REGEX.test(text) && !US_ZIP_REGEX.test(text)) continue;

      let el = node.parentElement;
      for (let hops = 0; el && el !== document.body && hops < MAX_HOPS; hops++) {
        if (isBlocked(el)) {
          el = el.parentElement;
          continue;
        }
        if (claimedAncestors.has(el)) {
          // A previous text node reached this same element and emitted its
          // address from here. Since we only climb strictly upward, any
          // further ancestors would emit the same (or a fused) address —
          // break and move on to the next postcode-bearing text node.
          break;
        }
        const joined = elementText(el);
        if (!joined || joined.length < 8 || joined.length > 400) {
          el = el.parentElement;
          continue;
        }
        // Needs both sides of the puzzle: a postcode AND something that
        // looks like a house number. Otherwise keep climbing.
        if (!UK_POSTCODE_REGEX.test(joined) && !US_ZIP_REGEX.test(joined)) {
          el = el.parentElement;
          continue;
        }
        if (!STREET_REGEX.test(joined)) {
          STREET_REGEX.lastIndex = 0;
          el = el.parentElement;
          continue;
        }
        STREET_REGEX.lastIndex = 0;
        const extracted = extractAddressFromJoined(joined);
        if (extracted.length > 0) {
          claimedAncestors.add(el);
          for (const cleaned of extracted) {
            out.push({ source: "postcode_climb", text: cleaned, anchor: el });
            if (out.length >= 50) return out;
          }
          break;
        }
        el = el.parentElement;
      }
    }
    return out;
  }

  root.WDFTextExtractor = Object.freeze({
    extractFromText,
    extractByPostcode,
    extractByPostcodeInBlocks,
    extractByPostcodeClimb,
    // Exposed for unit tests — operates on already-joined text and has no
    // DOM dependency, so it's the cheapest guard against the previous
    // regex-state-clobber regression.
    extractAddressFromJoined,
    previousPostcodeEndBefore,
    resetElementTextCache,
    isBlocked,
  });
})(typeof self !== "undefined" ? self : globalThis);

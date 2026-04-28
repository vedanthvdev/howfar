import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extractorPath = path.resolve(__dirname, "..", "content", "extractor-text.js");
const source = readFileSync(extractorPath, "utf8");

/**
 * The extractor file is a browser-style IIFE that attaches `WDFTextExtractor`
 * to its root (`self`). We load it into a dedicated vm context with a stub
 * `self` so the string-only helpers (extractAddressFromJoined,
 * previousPostcodeEndBefore) are reachable without a real DOM.
 */
function loadExtractor() {
  const sandbox = { self: {} };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: extractorPath });
  if (!sandbox.self.WDFTextExtractor) {
    throw new Error("WDFTextExtractor failed to attach to self");
  }
  return sandbox.self.WDFTextExtractor;
}

const { extractAddressFromJoined, previousPostcodeEndBefore } = loadExtractor();

test("extractAddressFromJoined returns one address for a single postcode block", () => {
  const input = "Semi-detached House : 30 Whitson Road, Edinburgh, EH11 3BU";
  const out = extractAddressFromJoined(input);
  assert.equal(out.length, 1);
  assert.match(out[0], /30 Whitson Road/);
  assert.match(out[0], /EH11 3BU$/);
});

test("extractAddressFromJoined returns two distinct addresses when two postcodes appear back-to-back", () => {
  // This is the exact regression from the previous review pass: two listing
  // cards joined into one string used to fuse because walkBackTo would walk
  // past the earlier postcode.
  const input =
    "4 West Pilton March, EH4 4JG 30 Whitson Road, Edinburgh, EH11 3BU";
  const out = extractAddressFromJoined(input);
  assert.equal(out.length, 2);
  assert.match(out[0], /^4 West Pilton March.*EH4 4JG$/);
  assert.match(out[1], /^30 Whitson Road.*EH11 3BU$/);
});

test("extractAddressFromJoined does not fuse across an intervening postcode even without punctuation", () => {
  const input = "Flat A, 12 Hope Street EH2 4DB 9 Annfield Court EH33 1PN";
  const out = extractAddressFromJoined(input);
  assert.equal(out.length, 2);
  assert.match(out[1], /^9 Annfield Court.*EH33 1PN$/);
});

test("extractAddressFromJoined terminates promptly on a single-postcode input", () => {
  // Belt-and-braces wall-clock sanity check. If the M1 regression recurs
  // as a true infinite loop, this test *hangs* — node:test has no default
  // per-test timeout, so the real catch is a CI job timeout or manual
  // Ctrl-C, not the 500 ms assertion below. The deterministic M1 tripwire
  // is the "does not clobber caller regex state" test below.
  //
  // What the 500 ms assertion does meaningfully catch on this short input:
  // non-infinite pathologies such as regex catastrophic backtracking or an
  // accidental per-character rescan that still returns, but slowly.
  const input = "30 Whitson Road, Edinburgh, EH11 3BU";
  const start = Date.now();
  const out = extractAddressFromJoined(input);
  const elapsed = Date.now() - start;
  assert.ok(
    elapsed < 500,
    `extractAddressFromJoined took ${elapsed}ms — likely pathological`
  );
  assert.equal(out.length, 1);
});

test("extractAddressFromJoined handles US ZIPs", () => {
  const input = "Main office: 1600 Amphitheatre Parkway, Mountain View, CA 94043";
  const out = extractAddressFromJoined(input);
  assert.equal(out.length, 1);
  assert.match(out[0], /1600 Amphitheatre Parkway/);
  assert.match(out[0], /CA 94043$/);
});

test("extractAddressFromJoined rejects bare postcodes without a house number", () => {
  const input = "See our office near EH1 1YZ for directions.";
  const out = extractAddressFromJoined(input);
  assert.equal(out.length, 0);
});

test("previousPostcodeEndBefore returns 0 when there is no earlier postcode", () => {
  const input = "Some prose, nothing interesting yet, EH11 3BU trailing";
  // `before` is the index of the postcode, so everything before it is
  // prose → floor should be 0.
  const idx = input.indexOf("EH11");
  assert.equal(previousPostcodeEndBefore(input, idx), 0);
});

test("previousPostcodeEndBefore finds the end of the preceding postcode", () => {
  const input = "4 West Pilton March, EH4 4JG 30 Whitson Road, EH11 3BU";
  const second = input.indexOf("EH11");
  const floor = previousPostcodeEndBefore(input, second);
  // The first postcode ends at `… EH4 4JG`; the returned offset must point
  // to the char right after "EH4 4JG".
  assert.equal(input.slice(0, floor), "4 West Pilton March, EH4 4JG");
});

test("previousPostcodeEndBefore does not clobber caller regex state", () => {
  // Call the helper in a tight loop that mimics how extractAddressFromJoined
  // invokes it. The fact that the helper uses its own local /g regex means
  // repeated calls with the same input return stable results.
  const input = "A, EH1 1AA, B, EH2 2BB, C, EH3 3CC";
  const results = [];
  for (let i = 0; i < 5; i++) {
    results.push(previousPostcodeEndBefore(input, input.length));
  }
  // Every call sees the same state; the floor must point past "EH3 3CC".
  assert.ok(new Set(results).size === 1);
  assert.ok(results[0] > input.indexOf("EH3"));
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const trackerPath = path.resolve(
  __dirname,
  "..",
  "shared",
  "budget-tracker.js"
);
const source = readFileSync(trackerPath, "utf8");

/**
 * Loads budget-tracker.js with a fake `chrome.storage.local`. The fake is a
 * thin in-memory map so we can drive the same code paths the extension uses
 * without spinning up a real Chrome runtime.
 */
function loadTracker() {
  const store = new Map();
  const sandbox = {
    self: {},
    chrome: {
      storage: {
        local: {
          async get(key) {
            const k = typeof key === "string" ? key : key?.[0];
            return k && store.has(k) ? { [k]: store.get(k) } : {};
          },
          async set(obj) {
            for (const [k, v] of Object.entries(obj)) store.set(k, v);
          },
          async remove(keys) {
            for (const k of [].concat(keys)) store.delete(k);
          },
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: trackerPath });
  return { ns: sandbox.self.WDFBudget, store };
}

test("setCap trips immediately when lowered below current spend", async () => {
  const { ns } = loadTracker();
  const t = new ns.BudgetTracker({ cap: 200 });
  await t.init();
  // 110 directions calls = $0.55 — under the $200 cap, breaker quiet.
  for (let i = 0; i < 110; i++) t.reserveCall("directions");
  assert.equal(t.usage().tripped, false);
  // Lower the cap below the current spend — should trip now.
  await t.setCap(0.25);
  assert.equal(t.usage().tripped, true);
  assert.match(t.usage().trippedReason ?? "", /\$0\.25 cap/);
});

test("setCap untrips when raised above current spend", async () => {
  const { ns } = loadTracker();
  const t = new ns.BudgetTracker({ cap: 0.5 });
  await t.init();
  // 100 directions × $0.005 = $0.50 → at the cap, breaker trips.
  for (let i = 0; i < 100; i++) t.reserveCall("directions");
  assert.equal(t.usage().tripped, true);
  // Raising the cap is an explicit decision to allow more spend; clear the
  // breaker so the user doesn't also need to reset the counter.
  await t.setCap(10);
  assert.equal(t.usage().tripped, false);
  assert.equal(t.usage().trippedReason, null);
  // Counter is untouched.
  assert.equal(t.usage().counts.directions, 100);
});

test("reserveCall throws BudgetExceededError after the cap is hit", async () => {
  const { ns } = loadTracker();
  // $0.005 cap = exactly one geocode/directions call before tripping.
  const t = new ns.BudgetTracker({ cap: 0.005 });
  await t.init();
  // First reservation pushes spend to the cap and trips the breaker.
  t.reserveCall("geocode");
  assert.equal(t.usage().tripped, true);
  // Subsequent reservations must throw, not silently increment.
  assert.throws(() => t.reserveCall("geocode"), ns.BudgetExceededError);
});

test("usage exposes persistError when storage writes fail", async () => {
  // Build a tracker on top of a storage stub that always rejects writes —
  // the SW's renderBudget paths now surface this so we lock in the contract.
  const sandbox = {
    self: {},
    chrome: {
      storage: {
        local: {
          async get() {
            return {};
          },
          async set() {
            throw new Error("simulated quota");
          },
          async remove() {},
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: trackerPath });
  const ns = sandbox.self.WDFBudget;
  const t = new ns.BudgetTracker({ cap: 5 });
  await t.init();
  t.reserveCall("geocode");
  // Wait for the queued background write to complete (even if it rejects).
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.usage().persistError, "simulated quota");
});

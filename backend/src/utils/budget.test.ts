import test, { after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  BudgetExceededError,
  BudgetTracker,
  type BudgetConfig,
} from "./budget";

/**
 * Track every temp directory we create so an after() hook can clean them up.
 * Keeps CI tmp directories tidy regardless of whether the OS eventually
 * sweeps them.
 */
const createdDirs: string[] = [];

/**
 * Track every BudgetTracker we instantiate so the after() hook can (a) flush
 * its in-flight writeQueue before we blow away the tmp dir, and (b) assert
 * that no tracker silently entered a broken persist state. Without (a),
 * saves kicked off by `init()` / `reserveCall()` race the teardown and the
 * output is peppered with `[budget] failed to persist: ENOENT`. Without (b),
 * a future test could leave `persistError` populated without failing —
 * the guard below catches that.
 */
const createdTrackers: BudgetTracker[] = [];
const expectingPersistFailure = new WeakSet<BudgetTracker>();

function makeTracker(cfg: BudgetConfig): BudgetTracker {
  const b = new BudgetTracker(cfg);
  createdTrackers.push(b);
  return b;
}

/**
 * Variant for tests that *intentionally* drive the tracker into a persist
 * failure (the unwritable-path fixture). Exempts the tracker from the
 * `after()` persistError sanity check so that expected failure doesn't
 * trigger a spurious suite failure.
 */
function makeFailingTracker(cfg: BudgetConfig): BudgetTracker {
  const b = makeTracker(cfg);
  expectingPersistFailure.add(b);
  return b;
}

async function tmpFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wdf-budget-"));
  createdDirs.push(dir);
  return path.join(dir, "budget.json");
}

/**
 * Portable "this path is unwritable" fixture: we make the parent path a
 * regular *file*, so any `mkdir` or `writeFile` underneath it fails. Works
 * on Darwin, Linux, and Windows (unlike `/dev/null/...`).
 */
async function unwritablePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wdf-budget-notdir-"));
  createdDirs.push(dir);
  const blocker = path.join(dir, "blocker");
  await fs.writeFile(blocker, "not a directory");
  return path.join(blocker, "budget.json");
}

after(async () => {
  // Drain any in-flight persistence so the rm below doesn't race a write.
  await Promise.all(
    createdTrackers.map((t) => t.flushWrites().catch(() => {}))
  );
  // Sanity check: every tracker that wasn't *expected* to fail should have
  // a clean persist state. If one doesn't, a test quietly drove the tracker
  // into a broken save and we want to know.
  for (const t of createdTrackers) {
    if (expectingPersistFailure.has(t)) continue;
    const err = t.usage().persistError;
    assert.equal(
      err,
      null,
      `tracker left persistError set after its test: ${err}`
    );
  }
  for (const dir of createdDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {
      // Best-effort: the OS will handle it eventually.
    });
  }
});

function baseConfig(filePath: string): BudgetConfig {
  return {
    filePath,
    monthlyUsdCap: 1,
    pricing: { geocode: 0.005, directions: 0.005 },
  };
}

test("fresh tracker reports zero usage", async () => {
  const filePath = await tmpFile();
  const b = makeTracker(baseConfig(filePath));
  await b.init();
  const u = b.usage();
  assert.equal(u.counts.geocode, 0);
  assert.equal(u.counts.directions, 0);
  assert.equal(u.tripped, false);
  assert.equal(u.estimatedUsd, 0);
  assert.equal(u.cap, 1);
  assert.equal(u.persistError, null);
});

test("reserveCall increments and tracks spend", async () => {
  const b = makeTracker(baseConfig(await tmpFile()));
  await b.init();
  b.reserveCall("geocode");
  b.reserveCall("directions", 3);
  const u = b.usage();
  assert.equal(u.counts.geocode, 1);
  assert.equal(u.counts.directions, 3);
  // 4 calls * $0.005 = $0.02
  assert.equal(Math.round(u.estimatedUsd * 1000) / 1000, 0.02);
  assert.equal(u.tripped, false);
});

test("reserveCall trips the breaker when the cap is crossed", async () => {
  const b = makeTracker(baseConfig(await tmpFile()));
  await b.init();
  // $0.005 per call * 200 = $1 cap reached.
  for (let i = 0; i < 199; i++) b.reserveCall("geocode");
  assert.equal(b.usage().tripped, false);
  b.reserveCall("geocode"); // 200th call crosses the cap
  const u = b.usage();
  assert.equal(u.tripped, true);
  assert.ok(u.trippedReason);
});

test("reserveCall throws BudgetExceededError after tripping", async () => {
  const b = makeTracker(baseConfig(await tmpFile()));
  await b.init();
  for (let i = 0; i < 200; i++) b.reserveCall("geocode");
  assert.equal(b.usage().tripped, true);
  assert.throws(() => b.reserveCall("geocode"), BudgetExceededError);
});

test("reserveCall is atomic under many concurrent callers", async () => {
  // Belt-and-braces tripwire for a future refactor that adds an `await`
  // between the increment and the trip check in reserveCall. Today this
  // is tautological (single-threaded JS), but it will fail loudly if the
  // "synchronous critical section" invariant ever breaks.
  const b = makeTracker(baseConfig(await tmpFile()));
  await b.init();
  const attempts = 300;
  let tripped = 0;
  await Promise.all(
    Array.from({ length: attempts }, () =>
      Promise.resolve().then(() => {
        try {
          b.reserveCall("geocode");
        } catch {
          tripped += 1;
        }
      })
    )
  );
  const u = b.usage();
  assert.equal(u.counts.geocode, 200, "cap should be reached exactly");
  assert.equal(u.tripped, true);
  assert.equal(tripped, attempts - 200, "excess reservations must throw");
});

test("ensureAvailable throws once tripped", async () => {
  const b = makeTracker(baseConfig(await tmpFile()));
  await b.init();
  await b.trip("forced");
  assert.throws(() => b.ensureAvailable(), BudgetExceededError);
});

test("releaseCall refunds a call only if count > 0", async () => {
  const b = makeTracker(baseConfig(await tmpFile()));
  await b.init();
  b.reserveCall("geocode");
  b.releaseCall("geocode");
  assert.equal(b.usage().counts.geocode, 0);
  // Negative refund protected
  b.releaseCall("geocode");
  assert.equal(b.usage().counts.geocode, 0);
});

test("releaseCall does NOT untrip an already-tripped breaker", async () => {
  const b = makeTracker(baseConfig(await tmpFile()));
  await b.init();
  for (let i = 0; i < 200; i++) b.reserveCall("geocode");
  assert.equal(b.usage().tripped, true);
  b.releaseCall("geocode");
  assert.equal(b.usage().tripped, true);
});

test("reset clears counters and breaker but preserves auto admin token", async () => {
  const b = makeTracker(baseConfig(await tmpFile()));
  await b.init();
  const token = b.adminToken();
  assert.ok(token);
  b.reserveCall("geocode");
  await b.trip("manual");
  await b.reset();
  const u = b.usage();
  assert.equal(u.counts.geocode, 0);
  assert.equal(u.tripped, false);
  assert.equal(b.adminToken(), token);
});

test("init generates and persists an auto admin token when none is given", async () => {
  const filePath = await tmpFile();
  const b1 = makeTracker(baseConfig(filePath));
  await b1.init();
  const t1 = b1.adminToken();
  assert.ok(t1.length > 0);
  assert.equal(b1.hasEnvAdminToken(), false);

  // Deterministic: wait for the queued save to settle instead of guessing.
  await b1.flushWrites();

  // A fresh tracker pointing at the same file should read the same token.
  const b2 = makeTracker(baseConfig(filePath));
  await b2.init();
  assert.equal(b2.adminToken(), t1);
});

test("env admin token wins and is not persisted", async () => {
  const filePath = await tmpFile();
  const cfg: BudgetConfig = {
    ...baseConfig(filePath),
    adminTokenFromEnv: "env-secret",
  };
  const b = makeTracker(cfg);
  await b.init();
  assert.equal(b.hasEnvAdminToken(), true);
  assert.equal(b.adminToken(), "env-secret");
  await b.flushWrites();
  // The file must not exist at all — init() never calls save() on the
  // env-token branch. If it ever starts to, this assertion will fail even
  // if `autoAdminToken` happens to land as null.
  await assert.rejects(
    fs.readFile(filePath, "utf8"),
    (err: NodeJS.ErrnoException) => err.code === "ENOENT"
  );
});

test("persist failure is surfaced via usage().persistError", async () => {
  const filePath = await unwritablePath();
  const b = makeFailingTracker(baseConfig(filePath));
  await b.init();
  b.reserveCall("geocode");
  // Wait deterministically for the background write to fail.
  await b.flushWrites();
  const u = b.usage();
  assert.ok(u.persistError, "expected persistError to be populated");
});

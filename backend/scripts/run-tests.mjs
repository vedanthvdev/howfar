#!/usr/bin/env node
/**
 * Discover every *.test.ts file under ./src and run them through
 * `node --import tsx --test`. Two reasons this lives here instead of an
 * inline `find … -exec`:
 *
 *   1. Node 18's default shell globbing doesn't recurse with `**`, and
 *      `find … -exec node --test {} +` silently exits 0 when it matches
 *      nothing — which hides a future "tests stopped being discovered"
 *      regression behind a green CI.
 *
 *   2. A Node script is portable across macOS / Linux / Git Bash / cmd
 *      without shell quoting gymnastics.
 */
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const searchRoot = join(projectRoot, "src");

/**
 * Recursively collect every `*.test.ts` under `dir`.
 *
 * Symlinks are deliberately NOT followed: `entry.isDirectory()` returns
 * `false` for symlinked directories and `entry.isFile()` returns `false`
 * for symlinked files. Good enough for this repo and safe against symlink
 * loops. If someone ever needs symlink-following test discovery they can
 * switch to `fs.stat` here.
 */
async function findTestFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return out;
    throw err;
  }
  for (const entry of entries) {
    // Defensive: if `node_modules` ever ends up under src/ (e.g. someone
    // runs `npm init` in the wrong cwd), we don't want to discover and run
    // every transitive dep's test suite.
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await findTestFiles(full)));
    } else if (entry.isFile() && /\.test\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = (await findTestFiles(searchRoot)).sort();

if (files.length === 0) {
  console.error(`[run-tests] No *.test.ts files found under ${relative(projectRoot, searchRoot)}/`);
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ["--import", "tsx", "--test", ...files],
  { stdio: "inherit", cwd: projectRoot }
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});

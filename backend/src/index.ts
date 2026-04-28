import "dotenv/config";
import express from "express";
import cors from "cors";
import * as path from "node:path";
import type { DistanceProvider, DistanceResult } from "./providers/types";
import { GoogleDistanceProvider } from "./providers/google";
import { TTLCache } from "./utils/cache";
import { BudgetTracker } from "./utils/budget";
import { createResolveBaseHandler } from "./routes/resolveBase";
import { createResolveDistancesHandler } from "./routes/resolveDistances";
import {
  createGetAdminTokenHandler,
  createGetBudgetHandler,
  createResetBudgetHandler,
} from "./routes/budget";

function parseOrigins(raw: string | undefined): string[] | "*" {
  if (!raw || raw.trim() === "" || raw.trim() === "*") return "*";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envString(name: string): string | undefined {
  const raw = process.env[name];
  return raw && raw.trim() !== "" ? raw.trim() : undefined;
}

const port = envNumber("PORT", 8787);
const ttlSeconds = envNumber("CACHE_TTL_SECONDS", 900);
const maxCandidates = envNumber("MAX_CANDIDATES", 20);
const origins = parseOrigins(process.env.ALLOWED_ORIGINS);

const budget = new BudgetTracker({
  filePath: path.resolve(
    process.env.BUDGET_FILE ?? path.join(process.cwd(), ".budget.json")
  ),
  monthlyUsdCap: envNumber("BUDGET_MONTHLY_USD_CAP", 180),
  pricing: {
    geocode: envNumber("BUDGET_PRICE_GEOCODE", 0.005),
    directions: envNumber("BUDGET_PRICE_DIRECTIONS", 0.005),
  },
  adminTokenFromEnv: envString("BUDGET_ADMIN_TOKEN"),
});

function buildProvider(): DistanceProvider {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_MAPS_API_KEY is not set");
  }
  return new GoogleDistanceProvider(apiKey, budget);
}

const provider = buildProvider();
const baseCache = new TTLCache<unknown>(ttlSeconds * 1000);
const distCache = new TTLCache<DistanceResult>(ttlSeconds * 1000);

const app = express();
// Trust the first hop so req.ip reflects the real client (important for the
// loopback check on /budget/reset when the backend sits behind a proxy).
app.set("trust proxy", "loopback");
app.use(express.json({ limit: "64kb" }));
app.use(
  cors({
    origin: origins === "*" ? true : origins,
  })
);

app.get("/health", (_req, res) => {
  const usage = budget.usage();
  res.json({
    ok: usage.persistError === null,
    baseCacheSize: baseCache.size(),
    distCacheSize: distCache.size(),
    budget: usage,
    ...(usage.persistError ? { warnings: [`budget persist: ${usage.persistError}`] } : {}),
  });
});

app.get("/budget", createGetBudgetHandler(budget));
app.post("/budget/reset", createResetBudgetHandler(budget));
app.get("/admin/token", createGetAdminTokenHandler(budget));

app.post("/resolve-base", createResolveBaseHandler(provider, baseCache));
app.post(
  "/resolve-distances",
  createResolveDistancesHandler(provider, distCache, maxCandidates, budget)
);

async function start(): Promise<void> {
  await budget.init();
  app.listen(port, () => {
    const u = budget.usage();
    // eslint-disable-next-line no-console
    console.log(
      `HowFar API listening on :${port} — budget $${u.estimatedUsd.toFixed(
        2
      )} / $${u.cap.toFixed(2)} this month (tripped=${u.tripped})`
    );
    if (!budget.hasEnvAdminToken()) {
      // eslint-disable-next-line no-console
      console.log(
        `[budget] Auto-generated admin token (loopback-only): ${budget.adminToken()}`
      );
      // eslint-disable-next-line no-console
      console.log(
        "[budget] Copy it into the extension options, or set BUDGET_ADMIN_TOKEN in .env."
      );
    }
    if (origins === "*") {
      // eslint-disable-next-line no-console
      console.warn(
        "[cors] ALLOWED_ORIGINS is unset (defaulting to *). For production, " +
          "set it to your extension origin, e.g. chrome-extension://<EXT_ID>."
      );
    } else if (origins.length === 0) {
      // `ALLOWED_ORIGINS=","` or similar typo — parseOrigins filters the
      // empties and we're left with nothing. CORS will silently deny every
      // request, which is painful to debug from the extension side because
      // the browser surfaces only an opaque "Failed to fetch".
      // eslint-disable-next-line no-console
      console.warn(
        "[cors] ALLOWED_ORIGINS parsed to an empty allow-list — the API will " +
          "refuse every cross-origin request. Check for stray commas / " +
          "whitespace-only entries in your .env."
      );
    } else {
      // Chrome extension IDs are exactly 32 lowercase chars in [a-p]. Any
      // `chrome-extension://…` origin that doesn't match that shape is
      // almost certainly a placeholder ("<YOUR_EXTENSION_ID>", "$EXT_ID",
      // "YOUR_EXTENSION_ID", "TODO", etc.) or a typo (uppercase, wrong
      // length). Either way the browser will refuse the preflight and the
      // extension will surface an opaque network error — so fail loud.
      const EXT_ID = /^chrome-extension:\/\/[a-p]{32}$/;
      const suspicious = origins.filter(
        (o) => o.startsWith("chrome-extension://") && !EXT_ID.test(o)
      );
      if (suspicious.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[cors] ALLOWED_ORIGINS contains an unrecognized chrome-extension origin: ${suspicious.join(
            ", "
          )}\n` +
            "        Chrome extension IDs are 32 lowercase letters in [a-p]. " +
            "Edit your .env to use your real extension ID, " +
            "or the extension will be refused by the browser."
        );
      }
    }
  });
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start:", err);
  process.exit(1);
});

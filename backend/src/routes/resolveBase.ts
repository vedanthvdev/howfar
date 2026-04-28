import type { Request, Response } from "express";
import type { DistanceProvider } from "../providers/types";
import { ProviderError } from "../providers/google";
import { TTLCache } from "../utils/cache";
import { normalizeAddress } from "../utils/normalize";
import { BudgetExceededError } from "../utils/budget";

export function createResolveBaseHandler(
  provider: DistanceProvider,
  cache: TTLCache<unknown>
) {
  return async function resolveBase(req: Request, res: Response): Promise<void> {
    const address = typeof req.body?.address === "string" ? req.body.address.trim() : "";
    if (!address) {
      res.status(400).json({ error: "address is required" });
      return;
    }

    const cacheKey = `base:${normalizeAddress(address)}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    try {
      const base = await provider.resolveBaseAddress(address);
      cache.set(cacheKey, base);
      res.json(base);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        res.status(429).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof ProviderError) {
        const status = err.kind === "not_found" ? 404 : 502;
        res.status(status).json({ error: err.message, kind: err.kind });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  };
}

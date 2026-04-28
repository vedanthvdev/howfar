interface Entry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Tiny in-memory TTL cache. Intentionally simple — a real deployment would use
 * Redis or Memcached behind this interface.
 */
export class TTLCache<T> {
  private readonly store = new Map<string, Entry<T>>();

  constructor(private readonly defaultTtlMs: number) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number = this.defaultTtlMs): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** Number of live (non-expired) entries. Sweeps lazily. */
  size(): number {
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (v.expiresAt <= now) this.store.delete(k);
    }
    return this.store.size;
  }
}

// A minimal in-process TTL cache for read-heavy, rarely-changing endpoints
// (competitions list, today's fixtures, the AI Football Analyst screening
// views) — Road_map.md's "Performance optimization... no caching layer
// yet" gap. Deliberately not Redis or any external store: this app
// currently deploys as a single Render instance (render.yaml), so a
// process-local cache already gives every request the benefit without a
// new infrastructure dependency to run, configure, or fail independently
// of the app itself. Revisit if this app is ever deployed as more than one
// replica — an in-process cache doesn't share state across instances, so a
// request hitting a different replica could see slightly different
// staleness (still bounded by the same TTL, just not synchronized).
//
// Time-based expiry only, no active invalidation on write: every cached
// route here is refreshed by a scheduled job (fixtures/competitions daily,
// ensemble predictions/accumulators daily), never by a user action, so a
// short TTL relative to that cadence is simpler than threading cache
// invalidation into every sync job and carries only a few seconds to
// minutes of extra staleness at worst.
export class TtlCache<T> {
  private readonly store = new Map<string, { value: T; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Drops every cached entry — for tests, and for an admin action that should bypass staleness entirely. */
  clear(): void {
    this.store.clear();
  }
}

// The one shape every cached route here actually needs: return the cached
// value if present and unexpired, otherwise compute it with `factory`,
// cache it, and return it. A concurrent cache miss on the same key before
// the first factory() resolves will compute twice rather than share one
// in-flight request — acceptable for this app's request volume, and far
// simpler than a request-coalescing cache.
export async function cached<T>(cache: TtlCache<T>, key: string, factory: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = await factory();
  cache.set(key, value);
  return value;
}

/**
 * Tiny localStorage-backed TTL cache.
 *
 * Use for any expensive fetch whose value is OK to be a few minutes stale —
 * e.g. LLM-generated briefings, embeddings, anything that costs tokens.
 *
 * Persistence is via localStorage, so cached values survive page refreshes
 * (the whole point — otherwise the LLM call fires on every reload).
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const PREFIX = "gooni-cache:";

export function cacheGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry<T>;
    if (Date.now() > entry.expiresAt) {
      localStorage.removeItem(PREFIX + key);
      return null;
    }
    return entry.value;
  } catch {
    return null;
  }
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  try {
    const entry: CacheEntry<T> = { value, expiresAt: Date.now() + ttlMs };
    localStorage.setItem(PREFIX + key, JSON.stringify(entry));
  } catch {
    // quota exceeded / storage disabled — fail silently, just skip caching
  }
}

export function cacheInvalidate(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // ignore
  }
}

/**
 * Return the cached value if fresh, otherwise call `loader`, cache its result,
 * and return that. Pass `force: true` to bypass the cache and refresh.
 */
export async function cachedFetch<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  opts: { force?: boolean } = {},
): Promise<T> {
  if (!opts.force) {
    const hit = cacheGet<T>(key);
    if (hit !== null) return hit;
  }
  const fresh = await loader();
  cacheSet(key, fresh, ttlMs);
  return fresh;
}

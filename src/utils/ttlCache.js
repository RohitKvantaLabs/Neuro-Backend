/**
 * Lightweight in-memory TTL cache.
 *
 * Stores values with a configurable time-to-live.  Expired entries are
 * lazily evicted on read.  Useful for caching API responses that change
 * infrequently and are identical across all users (e.g. repository list).
 *
 * Usage
 * -----
 *   const reposCache = new TtlCache({ ttlMs: 60_000 }); // 60-second TTL
 *
 *   // On read, check cache first — miss hit calls the fetcher:
 *   const repos = reposCache.get('repos');
 *   if (!repos) {
 *     repos = await Repository.find(...);
 *     reposCache.set('repos', repos);
 *   }
 */
class TtlCache {
  /**
   * @param {object} [opts]
   * @param {number} [opts.ttlMs=60_000]  Default TTL in milliseconds
   */
  constructor(opts = {}) {
    this._ttlMs = opts.ttlMs || 60_000;
    /** @type {Map<string, { value: unknown, expiresAt: number }>} */
    this._store = new Map();
  }

  /**
   * Get a cached value.  Returns undefined when the key is missing or
   * the entry has expired (lazy eviction).
   * @param {string} key
   * @returns {unknown | undefined}
   */
  get(key) {
    const entry = this._store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this._store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Set a cached value.
   * @param {string} key
   * @param {unknown} value
   * @param {number} [ttlMs]  Optional per-entry TTL override (ms)
   */
  set(key, value, ttlMs) {
    this._store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this._ttlMs),
    });
  }

  /**
   * Remove a single key from the cache.
   * @param {string} key
   */
  delete(key) {
    this._store.delete(key);
  }

  /**
   * Remove all entries from the cache.
   */
  clear() {
    this._store.clear();
  }

  /**
   * Get-or-set helper: returns the cached value if present and fresh,
   * otherwise calls *fetcher*, stores the result, and returns it.
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fetcher
   * @param {number} [ttlMs]
   * @returns {Promise<T>}
   */
  async getOrSet(key, fetcher, ttlMs) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await fetcher();
    this.set(key, value, ttlMs);
    return value;
  }
}

module.exports = { TtlCache };

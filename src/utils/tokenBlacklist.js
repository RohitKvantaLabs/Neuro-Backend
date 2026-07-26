/**
 * Refresh-token blacklist backed by Redis with an in-memory fallback.
 *
 * Provides server-side invalidation of stateless JWTs so that a `logout`
 * call (or account deletion) immediately renders a stolen refresh token
 * unusable, even before its natural 7-day expiry.
 *
 * In serverless deployments (e.g., Vercel), the in-memory Map alone is
 * insufficient because each cold start is a fresh process.  This module
 * attempts to use the shared Redis instance (configured via env.redisUrl)
 * and silently falls back to the local Map when Redis is unavailable.
 */

const crypto = require('crypto');

/**
 * Token TTL in seconds — kept in sync with auth.service.js
 * REFRESH_COOKIE_OPTIONS.maxAge (7 days).  Memory-only entries store
 * expiry as ms for the sweep timer; Redis entries use the native EX.
 */
const BLACKLIST_TTL_S = 7 * 24 * 60 * 60; // 7 days
const BLACKLIST_TTL_MS = BLACKLIST_TTL_S * 1000;

/** Redis key prefix. */
const REDIS_PREFIX = 'neuro:token-blacklist:';

// --- In-memory fallback ---
const _blocklist = new Map();

let _cleanupTimer = null;
function _scheduleCleanup() {
  if (_cleanupTimer) clearTimeout(_cleanupTimer);
  _cleanupTimer = setTimeout(() => {
    const now = Date.now();
    for (const [hash, expiresAt] of _blocklist) {
      if (expiresAt <= now) _blocklist.delete(hash);
    }
    _scheduleCleanup();
  }, 60_000);
}
_scheduleCleanup();

// --- Redis client (lazy-loaded) ---
let _redisClient = null;
/**
 * Lazily load the shared Redis client.  Returns `null` if Redis
 * is not configured or not yet connected.
 */
function _getRedis() {
  if (_redisClient !== null) return _redisClient;
  try {
    const { redisClient } = require('../config/redis.config');
    _redisClient = redisClient;
  } catch {
    _redisClient = false; // cache the failure
  }
  return _redisClient || null;
}

/** SHA-256 hex digest of a token string. */
function _digest(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Add a refresh-token to the blacklist.
 *
 * Always writes to the local in-memory Map synchronously, then
 * fire-and-forgets a Redis write for cross-instance sync.  This
 * ensures the blacklist is always updated immediately, even when
 * Redis is unavailable or during a cold start.
 */
function addToTokenBlacklist(token) {
  if (!token) return;
  const hash = _digest(token);

  // Always write to memory first (synchronous, guaranteed to work)
  _blocklist.set(hash, Date.now() + BLACKLIST_TTL_MS);

  // Fire-and-forget Redis write for cross-instance sync
  const redis = _getRedis();
  if (redis?.isOpen) {
    redis.set(REDIS_PREFIX + hash, '1', { EX: BLACKLIST_TTL_S }).catch(() => {});
  }
}

/**
 * Returns `true` if the given refresh-token has been blacklisted.
 *
 * Always returns synchronously from the in-memory Map.  Also
 * fire-and-forgets a Redis `exists` call to keep the memory cache
 * in sync with blacklists written by other instances — providing
 * eventual consistency across serverless cold starts.
 */
function isTokenBlacklisted(token) {
  if (!token) return false;
  const hash = _digest(token);

  // Fire-and-forget Redis read to sync memory cache with other instances
  const redis = _getRedis();
  if (redis?.isOpen) {
    redis.exists(REDIS_PREFIX + hash).then((exists) => {
      if (exists === 1) {
        // Ensure memory has this entry so subsequent calls don't need Redis
        if (!_blocklist.has(hash)) {
          _blocklist.set(hash, Date.now() + BLACKLIST_TTL_MS);
        }
      }
    }).catch(() => {});
  }

  // Always return from memory (synchronous, never blocks the event loop)
  return _blocklist.has(hash);
}

/**
 * Graceful shutdown — clear the sweep timer (used in testing).
 */
function _cleanup() {
  if (_cleanupTimer) clearTimeout(_cleanupTimer);
  _cleanupTimer = null;
  _blocklist.clear();
}

module.exports = { addToTokenBlacklist, isTokenBlacklisted, _cleanup };

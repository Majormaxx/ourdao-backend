import Redis from 'ioredis'
import { config } from '../config.js'

// Issue #277: Cache-Aside layer for the heaviest read endpoints (the members
// list and per-address member summary). Redis is strictly optional here —
// this is a read-heavy DAO backend, and every environment that has run
// without Redis so far (local dev, CI, the test suite) must keep working
// unchanged. `getOrSetCache` therefore falls through to `fetcher()` whenever
// REDIS_URL is unset, or whenever Redis itself is unreachable — the cache is
// a latency/DB-load optimization, never a dependency the API or indexer can
// fail on.

let client: Redis | null = null
// Logged once so a Redis outage doesn't spam the log for every request that
// falls back to Postgres — see `logConnectionFailureOnce` below.
let loggedConnectionFailure = false

function logConnectionFailureOnce(err: unknown): void {
  if (loggedConnectionFailure) return
  loggedConnectionFailure = true
  console.error('[cache] Redis unavailable — falling back to uncached reads:', (err as Error)?.message ?? err)
}

/**
 * Lazily create the shared ioredis client the first time it's needed. Returns
 * `null` (and creates nothing) when `REDIS_URL` isn't configured — the
 * no-Redis-configured path never opens a socket or attempts a connection.
 */
function getClient(): Redis | null {
  if (!config.cache.redisUrl) return null
  if (client) return client

  client = new Redis(config.cache.redisUrl, {
    // Issue #277: never let a slow/absent Redis hold up a request queuing
    // retries forever — a bounded number of attempts, then callers fall back
    // to Postgres via the try/catch in getOrSetCache/invalidateCache below.
    maxRetriesPerRequest: 1,
    // ioredis normally throws on the *next* command issued before the
    // initial connection completes; lazyConnect + explicit `.connect()`
    // aren't used here because ioredis connects on first command by default,
    // which is exactly the "no connection attempted until actually needed"
    // behavior this module wants.
    retryStrategy: () => null, // don't keep reconnecting in a hot loop
  })

  client.on('error', (err) => {
    // Issue #277: a background connection error must never crash the API or
    // indexer process — log once, keep going uncached.
    logConnectionFailureOnce(err)
  })

  return client
}

/**
 * Cache-Aside read: return the cached value for `key` if present, otherwise
 * call `fetcher()`, cache its result for `ttlSeconds`, and return it.
 *
 * Mirrors the level of abstraction of `query`/`queryOne` in src/db/index.ts —
 * callers don't see ioredis at all. When Redis is unconfigured or
 * unreachable, this degrades to simply calling `fetcher()` on every call.
 */
export async function getOrSetCache<T>(key: string, ttlSeconds: number, fetcher: () => Promise<T>): Promise<T> {
  const redis = getClient()
  if (!redis) return fetcher()

  try {
    const cached = await redis.get(key)
    if (cached !== null) return JSON.parse(cached) as T
  } catch (err) {
    logConnectionFailureOnce(err)
    return fetcher()
  }

  const value = await fetcher()

  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds)
  } catch (err) {
    // The value is still correct — just not cached this time. Never let a
    // write failure surface to the caller.
    logConnectionFailureOnce(err)
  }

  return value
}

/**
 * Remove one or more keys from the cache. A no-op when Redis isn't
 * configured or unreachable — invalidation is best-effort, since a cache
 * that fails to invalidate degrades to "stale for up to the TTL", not
 * "wrong forever" (issue #277).
 */
export async function invalidateCache(...keys: string[]): Promise<void> {
  const redis = getClient()
  if (!redis || keys.length === 0) return
  try {
    await redis.del(...keys)
  } catch (err) {
    logConnectionFailureOnce(err)
  }
}

/**
 * Remove every cached `/api/members` list entry, across every `?limit=`
 * value that's been cached (issue #277) — a membership-changing event
 * invalidates the listing at every limit, not just the default one. Uses
 * SCAN (not KEYS) so a large keyspace is walked in small batches rather than
 * blocking Redis; the members-list keyspace here is tiny in practice, but
 * SCAN costs nothing extra and avoids the footgun outright.
 */
export async function invalidateMembersListCache(): Promise<void> {
  const redis = getClient()
  if (!redis) return
  try {
    const keys: string[] = []
    let cursor = '0'
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', MEMBERS_LIST_CACHE_KEY_PATTERN, 'COUNT', 100)
      cursor = next
      keys.push(...batch)
    } while (cursor !== '0')
    if (keys.length > 0) await redis.del(...keys)
  } catch (err) {
    logConnectionFailureOnce(err)
  }
}

/** Cache key for the `/api/members` leaderboard-style listing, parameterized
 *  by the resolved `limit` — different limits are different result sets, so
 *  each gets its own entry. */
export function membersListCacheKey(limit: number): string {
  return `members:list:${limit}`
}

/** Matches every `members:list:*` key regardless of limit, for invalidation
 *  (issue #277) — a `joined`/`exited`/`staked`/`unstaked`/`claimed` event
 *  changes the membership list at every limit, not just one. */
export const MEMBERS_LIST_CACHE_KEY_PATTERN = 'members:list:*'

/** Cache key for one member's `/api/members/:address/summary` payload. */
export function memberSummaryCacheKey(address: string): string {
  return `members:summary:${address}`
}

/** Test-only: drop the shared client so a fresh REDIS_URL/mock takes effect
 *  on the next call. Never used outside tests. */
export function __resetCacheClientForTests(): void {
  if (client) {
    client.disconnect()
  }
  client = null
  loggedConnectionFailure = false
}

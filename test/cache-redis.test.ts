import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Issue #277: an in-memory fake standing in for ioredis, so these tests never
// need a real Redis instance (matching this repo's stance that Redis is
// strictly optional for local dev / CI). Mocked at the module level, before
// importing src/cache/redis.js, so the module's own `new Redis(...)` picks
// this up instead of opening a real socket.
const store = new Map<string, string>()

class FakeRedis {
  static shouldFailConnection = false

  constructor(_url: string, _opts?: unknown) {
    if (FakeRedis.shouldFailConnection) {
      // Simulate a client that immediately errors on first use, the way a
      // refused connection would.
      queueMicrotask(() => this.emitError())
    }
  }

  private listeners: Record<string, ((err: unknown) => void)[]> = {}

  on(event: string, cb: (err: unknown) => void): this {
    this.listeners[event] ??= []
    this.listeners[event].push(cb)
    return this
  }

  private emitError(): void {
    for (const cb of this.listeners.error ?? []) cb(new Error('ECONNREFUSED (fake)'))
  }

  async get(key: string): Promise<string | null> {
    if (FakeRedis.shouldFailConnection) throw new Error('ECONNREFUSED (fake)')
    return store.has(key) ? store.get(key)! : null
  }

  async set(key: string, value: string, _ex: 'EX', _ttl: number): Promise<'OK'> {
    if (FakeRedis.shouldFailConnection) throw new Error('ECONNREFUSED (fake)')
    store.set(key, value)
    return 'OK'
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0
    for (const k of keys) {
      if (store.delete(k)) n++
    }
    return n
  }

  async scan(_cursor: string, _match: 'MATCH', pattern: string, _count: 'COUNT', _n: number): Promise<[string, string[]]> {
    const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
    return ['0', [...store.keys()].filter((k) => re.test(k))]
  }

  disconnect(): void {}
}

vi.mock('ioredis', () => ({ default: FakeRedis }))

describe('cache/redis', () => {
  beforeEach(async () => {
    vi.resetModules()
    store.clear()
    FakeRedis.shouldFailConnection = false
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('no-ops and always calls the fetcher when REDIS_URL is not configured', async () => {
    vi.doMock('../src/config.js', () => ({
      config: { cache: { redisUrl: undefined, memberCacheTtlSeconds: 30 } },
    }))
    const { getOrSetCache } = await import('../src/cache/redis.js')

    const fetcher = vi.fn().mockResolvedValue({ hello: 'world' })
    const result1 = await getOrSetCache('k', 30, fetcher)
    const result2 = await getOrSetCache('k', 30, fetcher)

    expect(result1).toEqual({ hello: 'world' })
    expect(result2).toEqual({ hello: 'world' })
    // No caching happened at all — every call re-invokes the fetcher.
    expect(fetcher).toHaveBeenCalledTimes(2)
    // And nothing was ever written to the fake Redis store.
    expect(store.size).toBe(0)
  })

  it('cache miss calls the fetcher and populates the cache', async () => {
    vi.doMock('../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    const { getOrSetCache } = await import('../src/cache/redis.js')

    const fetcher = vi.fn().mockResolvedValue({ n: 1 })
    const result = await getOrSetCache('members:list:50', 30, fetcher)

    expect(result).toEqual({ n: 1 })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(store.get('members:list:50')).toBe(JSON.stringify({ n: 1 }))
  })

  it('cache hit avoids the fetcher', async () => {
    vi.doMock('../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    const { getOrSetCache } = await import('../src/cache/redis.js')

    const fetcher = vi.fn().mockResolvedValue({ n: 1 })
    await getOrSetCache('members:list:50', 30, fetcher)
    const second = await getOrSetCache('members:list:50', 30, fetcher)

    expect(second).toEqual({ n: 1 })
    // Only the first call actually hit the fetcher — the second was served
    // from the fake store.
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('invalidation clears the specific key', async () => {
    vi.doMock('../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    const { getOrSetCache, invalidateCache, memberSummaryCacheKey } = await import('../src/cache/redis.js')

    const address = 'GABC'
    const fetcher = vi.fn().mockResolvedValue({ member: address })
    await getOrSetCache(memberSummaryCacheKey(address), 30, fetcher)
    expect(store.has(memberSummaryCacheKey(address))).toBe(true)

    await invalidateCache(memberSummaryCacheKey(address))
    expect(store.has(memberSummaryCacheKey(address))).toBe(false)

    // A subsequent read is a fresh cache miss.
    await getOrSetCache(memberSummaryCacheKey(address), 30, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('invalidateMembersListCache clears every cached limit', async () => {
    vi.doMock('../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    const { getOrSetCache, invalidateMembersListCache, membersListCacheKey } = await import('../src/cache/redis.js')

    await getOrSetCache(membersListCacheKey(50), 30, vi.fn().mockResolvedValue([1]))
    await getOrSetCache(membersListCacheKey(200), 30, vi.fn().mockResolvedValue([2]))
    expect(store.size).toBe(2)

    await invalidateMembersListCache()
    expect(store.size).toBe(0)
  })

  it('degrades to calling the fetcher when Redis is unreachable, without throwing', async () => {
    vi.doMock('../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    FakeRedis.shouldFailConnection = true
    const { getOrSetCache } = await import('../src/cache/redis.js')

    const fetcher = vi.fn().mockResolvedValue({ ok: true })
    await expect(getOrSetCache('some-key', 30, fetcher)).resolves.toEqual({ ok: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

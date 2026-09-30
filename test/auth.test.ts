import { afterEach, describe, expect, it, vi } from 'vitest'
import { Account, Keypair, MuxedAccount, StrKey } from '@stellar/stellar-sdk'
import {
  authenticateRequest,
  classifyStellarAddress,
  extractAuthHeaders,
  isValidStellarAddress,
  verifySignature,
  AuthFailureTracker,
  MemoryNonceStore,
  type AuthLogger,
  type NonceStore,
} from '../src/auth.js'

// Direct coverage for the whole auth/authz surface (#72). Pure logic, no
// database. Real Keypair.random() keys and real signatures throughout, never
// mocked verification. The classifyStellarAddress / verifySignature (#71) and
// authenticateRequest (#70) blocks below landed with those issues; #72 adds
// MemoryNonceStore, extractAuthHeaders, isValidStellarAddress, and the
// characterization cases that pin exact behaviour (including anything that
// looks off — noted, not fixed). The AuthFailureTracker block covers the
// per-address exponential-backoff brute-force protection (#183, #184).

const keypair = Keypair.random()
const G = keypair.publicKey()
const M = new MuxedAccount(new Account(G, '0'), '42').accountId()
const C = StrKey.encodeContract(Buffer.alloc(32, 7))

function sign(nonce: string, address: string): string {
  return keypair.sign(Buffer.from(`${nonce}:${address}`, 'utf8')).toString('base64')
}

/** A NonceStore that always accepts, so signature-path assertions don't need a DB. */
const alwaysValidNonce: NonceStore = {
  issue: async () => 'n',
  consume: async () => true,
  shutdown: async () => {},
}

describe('classifyStellarAddress', () => {
  it('distinguishes ed25519, muxed, contract, and invalid', () => {
    expect(classifyStellarAddress(G)).toBe('ed25519')
    expect(classifyStellarAddress(M)).toBe('muxed')
    expect(classifyStellarAddress(C)).toBe('contract')
    expect(classifyStellarAddress('not-a-strkey')).toBe('invalid')
  })
})

describe('verifySignature (issue #71)', () => {
  it('accepts a valid G… signature', () => {
    const r = verifySignature(G, 'nonce1', sign('nonce1', G))
    expect(r).toEqual({ ok: true, ed25519Address: G })
  })

  it('rejects a valid-length but wrong signature as 401 "Invalid signature"', () => {
    const wrong = Keypair.random().sign(Buffer.from('x')).toString('base64')
    expect(verifySignature(G, 'nonce1', wrong)).toEqual({
      ok: false,
      status: 401,
      error: 'Invalid signature',
    })
  })

  it('reports a contract (C…) account as unsupported with a 400, not "Invalid signature"', () => {
    const r = verifySignature(C, 'nonce1', sign('nonce1', C))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.status).toBe(400)
    expect(r.error).toMatch(/contract/i)
    expect(r.error).not.toMatch(/invalid signature/i)
  })

  it('resolves a muxed (M…) address to its underlying G… account and verifies against it', () => {
    const r = verifySignature(M, 'nonce1', sign('nonce1', M))
    expect(r).toEqual({ ok: true, ed25519Address: G })
  })

  it('rejects an unrecognized address format with a 400', () => {
    const r = verifySignature('GARBAGE', 'nonce1', sign('nonce1', 'GARBAGE'))
    expect(r).toMatchObject({ ok: false, status: 400 })
  })

  it('treats a malformed-length signature as invalid without throwing', () => {
    expect(verifySignature(G, 'nonce1', 'not-base64-!!!')).toMatchObject({
      ok: false,
      status: 401,
    })
  })
})

describe('authenticateRequest (issue #70)', () => {
  function headersFor(address: string, nonce = 'nonce1'): Record<string, unknown> {
    return { authorization: `StellarSignature ${address}:${sign(nonce, address)}:${nonce}` }
  }

  it('returns the authenticated address on success', async () => {
    const res = await authenticateRequest(headersFor(G), alwaysValidNonce)
    expect(res).toEqual({ authenticated: true, address: G })
  })

  it('never carries an address on failure — the union makes it a type error to read one', async () => {
    const res = await authenticateRequest({ authorization: 'StellarSignature bad' }, alwaysValidNonce)
    expect(res.authenticated).toBe(false)
    // @ts-expect-error address is not present on the failure branch
    expect(res.address).toBeUndefined()
  })

  it('surfaces the 400 status for a contract account rather than a blanket 401', async () => {
    const res = await authenticateRequest(headersFor(C), alwaysValidNonce)
    expect(res).toMatchObject({ authenticated: false, status: 400 })
  })

  it('keeps existing 401 behaviour for a bad nonce and a bad signature', async () => {
    const rejectingNonce: NonceStore = { issue: async () => 'n', consume: async () => false, shutdown: async () => {} }
    const badNonce = await authenticateRequest(headersFor(G), rejectingNonce)
    expect(badNonce).toMatchObject({ authenticated: false, status: 401 })

    const store = new MemoryNonceStore()
    const nonce = await store.issue(G)
    const badSig = await authenticateRequest(
      { authorization: `StellarSignature ${G}:${Keypair.random().sign(Buffer.from('x')).toString('base64')}:${nonce}` },
      store,
    )
    expect(badSig).toMatchObject({ authenticated: false, status: 401, error: 'Invalid signature' })
    await store.shutdown()
  })

  it('rejects a target-address mismatch with 403 — authenticated but not authorized (issue #134)', async () => {
    const other = Keypair.random().publicKey()
    const res = await authenticateRequest(headersFor(G), alwaysValidNonce, other)
    expect(res).toMatchObject({ authenticated: false, status: 403 })
  })
})

describe('MemoryNonceStore (#72)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('issue() returns distinct nonces each time (issue #180)', async () => {
    const store = new MemoryNonceStore()
    const a1 = await store.issue('GA')
    const a2 = await store.issue('GA')
    const b1 = await store.issue('GB')
    for (const n of [a1, a2, b1]) expect(n).toMatch(/^[0-9a-f]{64}$/)
    // Issue #180: a1 and a2 should be different to support independent sessions on separate devices
    expect(a1).not.toBe(a2)
    // b1 should also be different (different address)
    expect(b1).not.toBe(a1)
    expect(b1).not.toBe(a2)
    // Both nonces should be valid for their respective addresses
    expect(await store.consume('GA', a1)).toBe(true)
    expect(await store.consume('GA', a2)).toBe(true)
    expect(await store.consume('GB', b1)).toBe(true)
    await store.shutdown()
  })

  it('consume() succeeds exactly once for a valid (address, nonce) pair', async () => {
    const store = new MemoryNonceStore()
    const nonce = await store.issue(G)
    expect(await store.consume(G, nonce)).toBe(true)
    expect(await store.consume(G, nonce)).toBe(false)
    await store.shutdown()
  })

  it('consume() fails for the wrong nonce and for an unknown address', async () => {
    const store = new MemoryNonceStore()
    const nonce = await store.issue(G)
    expect(await store.consume(G, 'not-the-nonce')).toBe(false)
    expect(await store.consume('GUNKNOWN', nonce)).toBe(false)
    await store.shutdown()
  })

  it("consume() rejects address A's nonce presented for address B", async () => {
    const store = new MemoryNonceStore()
    const nonceForA = await store.issue('GA')
    expect(await store.consume('GB', nonceForA)).toBe(false)
    await store.shutdown()
  })

  it('an entry past its 5-minute TTL fails on consume — expiry is evaluated at consume time', async () => {
    vi.useFakeTimers()
    const store = new MemoryNonceStore()
    await store.shutdown() // stop the periodic sweep so `consume` is what detects expiry
    const nonce = await store.issue(G)
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    expect(await store.consume(G, nonce)).toBe(false)
  })

  it('the periodic sweep evicts expired entries without a consume call', async () => {
    vi.useFakeTimers()
    const store = new MemoryNonceStore()
    await store.issue(G)
    vi.advanceTimersByTime(6 * 60 * 1000) // sweep runs every 60s; entry expires at 300s
    const internal = (store as unknown as { store: Map<string, unknown> }).store
    expect(internal.size).toBe(0)
    await store.shutdown()
  })

  it('concurrent issue calls do not clobber each other (issue #179)', async () => {
    const store = new MemoryNonceStore()

    // Issue #180: support multiple nonces per address
    const [nonce1, nonce2] = await Promise.all([
      store.issue(G),
      store.issue(G),
    ])

    // Both nonces should be distinct
    expect(nonce1).not.toBe(nonce2)

    // Both nonces should be valid
    expect(await store.consume(G, nonce1)).toBe(true)
    expect(await store.consume(G, nonce2)).toBe(true)

    await store.shutdown()
  })
})

describe('extractAuthHeaders (#72)', () => {
  const NULLS = { address: null, signature: null, nonce: null }

  it('returns nulls for an absent header', () => {
    expect(extractAuthHeaders({})).toEqual(NULLS)
  })

  it('returns nulls for a non-string header', () => {
    expect(extractAuthHeaders({ authorization: 12345 })).toEqual(NULLS)
  })

  it('returns nulls for the wrong scheme prefix', () => {
    expect(extractAuthHeaders({ authorization: 'Bearer abc:def:ghi' })).toEqual(NULLS)
  })

  it('returns nulls for too few colon-separated parts', () => {
    expect(extractAuthHeaders({ authorization: 'StellarSignature addr:sig' })).toEqual(NULLS)
  })

  it('returns nulls for too many colon-separated parts', () => {
    expect(extractAuthHeaders({ authorization: 'StellarSignature a:b:c:d' })).toEqual(NULLS)
  })

  it('parses a well-formed header into its three components', () => {
    expect(extractAuthHeaders({ authorization: 'StellarSignature GABC:c2ln:n0nce' })).toEqual({
      address: 'GABC',
      signature: 'c2ln',
      nonce: 'n0nce',
    })
  })

  it('pins current behaviour: empty components come back as empty strings, not null', () => {
    expect(extractAuthHeaders({ authorization: 'StellarSignature ::' })).toEqual({
      address: '',
      signature: '',
      nonce: '',
    })
  })
})

describe('isValidStellarAddress (#72)', () => {
  it('accepts a real G-address and rejects junk and non-ed25519 strkeys', () => {
    expect(isValidStellarAddress(G)).toBe(true)
    expect(isValidStellarAddress('not-an-address')).toBe(false)
    expect(isValidStellarAddress(C)).toBe(false)
  })
})

describe('authenticateRequest — characterization (#72)', () => {
  function headersFor(address: string, nonce: string): Record<string, unknown> {
    return { authorization: `StellarSignature ${address}:${sign(nonce, address)}:${nonce}` }
  }

  it('authenticates a request with a real nonce and signature', async () => {
    const store = new MemoryNonceStore()
    const nonce = await store.issue(G)
    expect(await authenticateRequest(headersFor(G, nonce), store)).toEqual({
      authenticated: true,
      address: G,
    })
    await store.shutdown()
  })

  it('returns the exact client-facing error string for each failure', async () => {
    expect(await authenticateRequest({}, alwaysValidNonce)).toMatchObject({
      error: 'Missing authentication headers',
    })
    expect(
      await authenticateRequest(headersFor(G, 'n'), { issue: async () => 'n', consume: async () => false, shutdown: async () => {} }),
    ).toMatchObject({ error: 'Invalid or expired nonce' })
    expect(
      await authenticateRequest({ authorization: `StellarSignature ${G}:bm90LXNpZw:n` }, alwaysValidNonce),
    ).toMatchObject({ error: 'Invalid signature' })

    const store = new MemoryNonceStore()
    const nonce = await store.issue(G)
    expect(
      await authenticateRequest(headersFor(G, nonce), store, Keypair.random().publicKey()),
    ).toMatchObject({ error: 'Cannot modify notifications for another address' })
    await store.shutdown()
  })

  // The actual authorization control: one member cannot act on another's data.
  // Deleting the `if (targetAddress && targetAddress !== address)` block in
  // src/auth.ts makes this test return `{ authenticated: true, address: G }`.
  it('rejects a targetAddress that is not the authenticated address', async () => {
    const store = new MemoryNonceStore()
    const nonce = await store.issue(G)
    const res = await authenticateRequest(headersFor(G, nonce), store, Keypair.random().publicKey())
    expect(res).toEqual({
      authenticated: false,
      status: 403,
      error: 'Cannot modify notifications for another address',
    })
    await store.shutdown()
  })

  it('verifies the signature before consuming the nonce, so a bad-signature request never spends it (issue #115)', async () => {
    const store = new MemoryNonceStore()
    const nonce = await store.issue(G)
    const first = await authenticateRequest(
      { authorization: `StellarSignature ${G}:bm90LXNpZw:${nonce}` },
      store,
    )
    expect(first).toMatchObject({ authenticated: false, error: 'Invalid signature' })
    // The nonce must still be alive: a correctly-signed follow-up succeeds.
    const second = await authenticateRequest(headersFor(G, nonce), store)
    expect(second).toEqual({ authenticated: true, address: G })
    await store.shutdown()
  })
})

describe('structured logging, not console (issues #132, #133)', () => {
  function fakeLogger(): { logger: AuthLogger; debugCalls: string[]; warnCalls: string[] } {
    const debugCalls: string[] = []
    const warnCalls: string[] = []
    const logger: AuthLogger = {
      debug: (msg) => debugCalls.push(msg),
      info: () => {},
      warn: (msg) => warnCalls.push(msg),
      error: () => {},
    }
    return { logger, debugCalls, warnCalls }
  }

  it('MemoryNonceStore.issue logs through the given logger, truncated, never through console (issue #181)', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const store = new MemoryNonceStore()
    const { logger, debugCalls } = fakeLogger()
    await store.issue(G, logger)
    await store.issue(G, logger) // Issue #180: each call returns a distinct nonce

    expect(debugCalls).toHaveLength(2)
    expect(debugCalls[0]).toContain(`${G.slice(0, 4)}…${G.slice(-4)}`)
    expect(debugCalls[0]).not.toContain(G)
    expect(debugCalls[1]).toContain(`${G.slice(0, 4)}…${G.slice(-4)}`)
    expect(debugCalls[1]).not.toContain(G)
    expect(debugSpy).not.toHaveBeenCalled()

    debugSpy.mockRestore()
    await store.shutdown()
  })

  it('MemoryNonceStore.issue works with no logger passed (logging is optional)', async () => {
    const store = new MemoryNonceStore()
    await expect(store.issue(G)).resolves.toEqual(expect.any(String))
    await expect(store.issue(G)).resolves.toEqual(expect.any(String))
    await store.shutdown()
  })

  it('verifySignature logs a malformed signature through the given logger, never through console', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { logger, warnCalls } = fakeLogger()
    verifySignature(G, 'nonce1', 'not-base64-!!!', logger)

    expect(warnCalls).toHaveLength(1)
    expect(warnCalls[0]).toContain(`${G.slice(0, 4)}…${G.slice(-4)}`)
    expect(warnCalls[0]).not.toContain(G)
    expect(warnSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it('authenticateRequest threads its logger through to verifySignature', async () => {
    const { logger, warnCalls } = fakeLogger()
    const res = await authenticateRequest(
      { authorization: `StellarSignature ${G}:bm90LXNpZw:n` },
      { issue: async () => 'n', consume: async () => true, shutdown: async () => {} },
      undefined,
      logger,
    )
    expect(res).toMatchObject({ authenticated: false, error: 'Invalid signature' })
    expect(warnCalls).toHaveLength(1)
  })
})

describe('AuthFailureTracker — per-address exponential backoff (issues #183, #184)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Build a tracker whose cleanup interval is unref'd/no-op; shutdown() in afterEach where needed. */
  function newTracker(): AuthFailureTracker {
    return new AuthFailureTracker()
  }

  /** Internal failure record, for asserting nextAllowedAt directly. */
  function recordOf(tracker: AuthFailureTracker, address: string): { count: number; lastFailureAt: number; nextAllowedAt: number } {
    const failures = (tracker as unknown as { failures: Map<string, { count: number; lastFailureAt: number; nextAllowedAt: number }> }).failures
    const record = failures.get(address)
    expect(record).toBeDefined()
    return record!
  }

  it('1st failure: 1s backoff, attempt blocked until it elapses, then allowed', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-30T00:00:00Z'))
    const tracker = newTracker()
    const addr = 'GA-BRUTE'

    tracker.recordFailure(addr)

    const rec = recordOf(tracker, addr)
    expect(rec.count).toBe(1)
    expect(rec.nextAllowedAt).toBe(Date.now() + 1000)
    expect(tracker.isAllowed(addr)).toBe(false)
    expect(tracker.getRemainingBackoff(addr)).toBe(1000)

    vi.advanceTimersByTime(1000)
    expect(tracker.isAllowed(addr)).toBe(true)
    expect(tracker.getRemainingBackoff(addr)).toBe(0)
    tracker.shutdown()
  })

  it('2nd failure within the window doubles the backoff to 2s', () => {
    vi.useFakeTimers()
    const tracker = newTracker()
    const addr = 'GA-BRUTE'

    tracker.recordFailure(addr)
    vi.advanceTimersByTime(500) // still within the 5-minute failure window
    tracker.recordFailure(addr)

    const rec = recordOf(tracker, addr)
    expect(rec.count).toBe(2)
    expect(rec.nextAllowedAt).toBe(Date.now() + 2000)
    expect(tracker.getRemainingBackoff(addr)).toBe(2000)
    tracker.shutdown()
  })

  it('3rd failure doubles again to 4s', () => {
    vi.useFakeTimers()
    const tracker = newTracker()
    const addr = 'GA-BRUTE'

    tracker.recordFailure(addr)
    vi.advanceTimersByTime(500)
    tracker.recordFailure(addr)
    vi.advanceTimersByTime(500)
    tracker.recordFailure(addr)

    const rec = recordOf(tracker, addr)
    expect(rec.count).toBe(3)
    expect(rec.nextAllowedAt).toBe(Date.now() + 4000)
    tracker.shutdown()
  })

  it('subsequent failures keep doubling up to the 60s MAX_BACKOFF_MS cap', () => {
    vi.useFakeTimers()
    const tracker = newTracker()
    const addr = 'GA-BRUTE'

    // Failures 1..6 → 1s, 2s, 4s, 8s, 16s, 32s; then the cap kicks in.
    const expectedBackoffs = [1000, 2000, 4000, 8000, 16000, 32000]
    for (const backoff of expectedBackoffs) {
      tracker.recordFailure(addr)
      vi.advanceTimersByTime(500) // stay inside the 5-minute failure window
      const rec = recordOf(tracker, addr)
      expect(rec.nextAllowedAt - rec.lastFailureAt).toBe(backoff)
    }

    // 7th and 8th failures are capped at MAX_BACKOFF_MS = 60s
    tracker.recordFailure(addr)
    let rec = recordOf(tracker, addr)
    expect(rec.count).toBe(7)
    expect(rec.nextAllowedAt - rec.lastFailureAt).toBe(60000)

    tracker.recordFailure(addr)
    rec = recordOf(tracker, addr)
    expect(rec.count).toBe(8)
    expect(rec.nextAllowedAt - rec.lastFailureAt).toBe(60000)
    expect(tracker.getRemainingBackoff(addr)).toBe(60000)
    tracker.shutdown()
  })

  it('a failure outside the 5-minute window resets to the base 1s backoff', () => {
    vi.useFakeTimers()
    const tracker = newTracker()
    const addr = 'GA-BRUTE'

    tracker.recordFailure(addr)
    vi.advanceTimersByTime(500)
    tracker.recordFailure(addr)
    expect(recordOf(tracker, addr).count).toBe(2)

    // Beyond FAILURE_WINDOW_MS (5 min): the counter resets instead of escalating.
    vi.advanceTimersByTime(5 * 60 * 1000)
    tracker.recordFailure(addr)
    const rec = recordOf(tracker, addr)
    expect(rec.count).toBe(1)
    expect(rec.nextAllowedAt - rec.lastFailureAt).toBe(1000)
    tracker.shutdown()
  })

  it('backoff is tracked per address — one address failing does not block another', () => {
    vi.useFakeTimers()
    const tracker = newTracker()

    tracker.recordFailure('GA-ONE')
    tracker.recordFailure('GA-ONE')
    tracker.recordFailure('GA-TWO')

    expect(recordOf(tracker, 'GA-ONE').count).toBe(2)
    expect(recordOf(tracker, 'GA-TWO').count).toBe(1)
    expect(tracker.isAllowed('GA-THREE')).toBe(true)
    expect(tracker.getRemainingBackoff('GA-THREE')).toBe(0)
    tracker.shutdown()
  })

  it('recordSuccess clears the failure record — recovery after successful authentication', () => {
    vi.useFakeTimers()
    const tracker = newTracker()
    const addr = 'GA-BRUTE'

    tracker.recordFailure(addr)
    tracker.recordFailure(addr)
    tracker.recordFailure(addr)
    expect(tracker.isAllowed(addr)).toBe(false)

    tracker.recordSuccess(addr)
    expect(tracker.isAllowed(addr)).toBe(true)
    expect(tracker.getRemainingBackoff(addr)).toBe(0)
    // The internal record is gone entirely, so the next failure starts fresh at count 1.
    tracker.recordFailure(addr)
    const rec = recordOf(tracker, addr)
    expect(rec.count).toBe(1)
    expect(rec.nextAllowedAt - rec.lastFailureAt).toBe(1000)
    tracker.shutdown()
  })

  it('end-to-end: authenticateRequest records failures on bad signatures and clears on success', async () => {
    vi.useFakeTimers()
    const tracker = newTracker()
    const store = new MemoryNonceStore()
    const nonce = await store.issue(G)

    // Bad signature → recorded failure, backoff grows 1s → 2s → 4s.
    // Each attempt must wait out the current backoff first: while blocked,
    // authenticateRequest answers 429 before even looking at the signature,
    // so a blocked attempt does not extend the escalation.
    const badSigHeaders = (): Record<string, unknown> => ({
      authorization: `StellarSignature ${G}:bm90LXNpZw:${nonce}`,
    })
    await authenticateRequest(badSigHeaders(), store, undefined, undefined, tracker)
    expect(tracker.getRemainingBackoff(G)).toBe(1000)
    // A repeat attempt inside the backoff window is bounced with 429 instead.
    const bounced = await authenticateRequest(badSigHeaders(), store, undefined, undefined, tracker)
    expect(bounced).toMatchObject({ authenticated: false, status: 429 })
    expect(tracker.getRemainingBackoff(G)).toBe(1000) // unchanged — no new failure recorded

    vi.advanceTimersByTime(1000)
    await authenticateRequest(badSigHeaders(), store, undefined, undefined, tracker)
    expect(tracker.getRemainingBackoff(G)).toBe(2000)

    vi.advanceTimersByTime(2000)
    await authenticateRequest(badSigHeaders(), store, undefined, undefined, tracker)
    expect(tracker.getRemainingBackoff(G)).toBe(4000)

    // While under backoff, even a fully valid attempt is rejected with 429.
    const validHeaders = (): Record<string, unknown> => ({
      authorization: `StellarSignature ${G}:${sign(nonce, G)}:${nonce}`,
    })
    const blocked = await authenticateRequest(validHeaders(), store, undefined, undefined, tracker)
    expect(blocked).toMatchObject({ authenticated: false, status: 429 })
    if (!blocked.authenticated) expect(blocked.error).toMatch(/Too many failed attempts/)

    // After the backoff elapses, a valid attempt succeeds and clears the record.
    vi.advanceTimersByTime(4000)
    const ok = await authenticateRequest(validHeaders(), store, undefined, undefined, tracker)
    expect(ok).toEqual({ authenticated: true, address: G })
    expect(tracker.isAllowed(G)).toBe(true)
    expect(tracker.getRemainingBackoff(G)).toBe(0)

    await store.shutdown()
    tracker.shutdown()
  })

  it('shutdown() stops the timer and is idempotent — a second call is a no-op', () => {
    const tracker = newTracker()
    expect((tracker as unknown as { cleanupTimer: NodeJS.Timeout | null }).cleanupTimer).not.toBeNull()
    tracker.shutdown()
    expect((tracker as unknown as { cleanupTimer: NodeJS.Timeout | null }).cleanupTimer).toBeNull()
    expect(() => tracker.shutdown()).not.toThrow()
  })

  it('constructs and works even when the timer handle has no unref (environment guard)', () => {
    // Some environments (old Node, exotic runtimes) return timer handles
    // without `unref`. The constructor must tolerate that rather than throw.
    vi.stubGlobal('setInterval', vi.fn(() => ({})) as unknown as typeof setInterval)
    const tracker = new AuthFailureTracker()
    vi.unstubAllGlobals()

    tracker.recordFailure('GA')
    expect(tracker.isAllowed('GA')).toBe(false)
    tracker.shutdown()
  })

  it('the periodic cleanup deletes stale records', () => {
    vi.useFakeTimers()
    const tracker = newTracker()
    tracker.recordFailure('GA-STALE')
    expect(recordOf(tracker, 'GA-STALE')).toBeDefined()

    // Sweep runs every 60s; the record goes stale after 5 minutes.
    vi.advanceTimersByTime(6 * 60 * 1000)
    const failures = (tracker as unknown as { failures: Map<string, unknown> }).failures
    expect(failures.size).toBe(0)
    tracker.shutdown()
  })
})

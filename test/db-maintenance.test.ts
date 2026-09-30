import { describe, expect, it, vi } from 'vitest'
import type { Client } from 'pg'
import { runMaintenance } from '../src/db/maintenance.js'

// Issue #279: `runMaintenance` is the pure/testable piece pulled out of the
// worker's maintenance loop (src/worker.ts) — it just needs a `pg`-shaped
// `client.query`, so it's exercised here with a fake rather than a real
// Postgres connection (VACUUM can't meaningfully run against a fixture DB
// in a unit test anyway, and this repo's test suite avoids running real
// commands where a fake suffices).
function fakeClient(queryImpl: (sql: string) => Promise<{ rowCount: number | null }>): Client {
  return { query: vi.fn(queryImpl) } as unknown as Client
}

describe('db/maintenance: runMaintenance', () => {
  it('VACUUMs events, auth_nonces, and notifications, and sweeps expired nonces', async () => {
    const calls: string[] = []
    const client = fakeClient(async (sql) => {
      calls.push(sql)
      if (sql.startsWith('DELETE FROM auth_nonces')) return { rowCount: 3 }
      return { rowCount: null }
    })

    const result = await runMaintenance(client)

    expect(calls).toContain('VACUUM (ANALYZE) events')
    expect(calls).toContain('VACUUM (ANALYZE) auth_nonces')
    expect(calls).toContain('VACUUM (ANALYZE) notifications')
    expect(calls.some((c) => c.startsWith('DELETE FROM auth_nonces'))).toBe(true)

    expect(result.tables).toHaveLength(3)
    expect(result.tables.every((t) => t.ok)).toBe(true)
    expect(result.expiredNoncesDeleted).toBe(3)
    expect(result.expiredNoncesError).toBeUndefined()
    expect(typeof result.durationMs).toBe('number')
  })

  it('records a per-table failure without throwing or skipping the remaining tables', async () => {
    const client = fakeClient(async (sql) => {
      if (sql === 'VACUUM (ANALYZE) auth_nonces') throw new Error('lock not available')
      return { rowCount: 0 }
    })

    const result = await runMaintenance(client)

    const tableNames = result.tables.map((t) => t.table)
    expect(tableNames).toEqual(['events', 'auth_nonces', 'notifications'])

    const failed = result.tables.find((t) => t.table === 'auth_nonces')!
    expect(failed.ok).toBe(false)
    expect(failed.error).toContain('lock not available')

    // The other two tables still ran and succeeded — one failure doesn't
    // abort the run (issue #279).
    expect(result.tables.find((t) => t.table === 'events')!.ok).toBe(true)
    expect(result.tables.find((t) => t.table === 'notifications')!.ok).toBe(true)
  })

  it('records the expired-nonce sweep failing without throwing', async () => {
    const client = fakeClient(async (sql) => {
      if (sql.startsWith('DELETE FROM auth_nonces')) throw new Error('connection reset')
      return { rowCount: 0 }
    })

    const result = await runMaintenance(client)

    expect(result.expiredNoncesDeleted).toBeNull()
    expect(result.expiredNoncesError).toContain('connection reset')
    // VACUUMs still all ran and succeeded.
    expect(result.tables.every((t) => t.ok)).toBe(true)
  })
})

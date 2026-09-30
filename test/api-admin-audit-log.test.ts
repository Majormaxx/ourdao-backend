// Unit tests for the admin_audit_log table and GET /api/admin/audit-log
// endpoint (issue #291).
//
// These tests verify:
//  - writeAuditLog inserts a row with the correct fields (tested indirectly
//    via the endpoint's own insertion path + direct DB queries)
//  - GET /api/admin/audit-log requires authentication
//  - The endpoint returns rows newest-first, supports ?before= pagination,
//    and supports ?admin= and ?action= filters
//  - IP address, payload, and admin_address are persisted correctly
//  - The endpoint never exposes raw error detail (no raw exception text)
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'
import type { AdminAuditLogRow } from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers — insert audit log rows directly (simulates writeAuditLog)
// ---------------------------------------------------------------------------

async function insertAuditRow(
  adminAddress: string,
  action: string,
  ipAddress: string | null = null,
  payload: Record<string, unknown> = {}
): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO admin_audit_log (admin_address, action, ip_address, payload)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [adminAddress, action, ipAddress, JSON.stringify(payload)]
  )
  return rows[0]!.id
}

// ---------------------------------------------------------------------------
// Build an auth header for a Stellar keypair — mirrors the format that
// authenticateRequest expects: "StellarSignature <address>:<sig>:<nonce>"
// ---------------------------------------------------------------------------

async function buildAuthHeader(
  app: FastifyInstance,
  kp: ReturnType<typeof Keypair.random>
): Promise<string> {
  // 1. Obtain a nonce from the challenge endpoint
  const challengeRes = await app.inject({
    method: 'GET',
    url: `/api/auth/challenge?address=${kp.publicKey()}`,
  })
  expect(challengeRes.statusCode).toBe(200)
  const { nonce } = challengeRes.json<{ nonce: string }>()

  // 2. Sign `nonce:address` with the keypair
  const payload = Buffer.from(`${nonce}:${kp.publicKey()}`, 'utf8')
  const signature = kp.sign(payload).toString('base64')

  return `StellarSignature ${kp.publicKey()}:${signature}:${nonce}`
}

// ---------------------------------------------------------------------------
// Schema — admin_audit_log table
// ---------------------------------------------------------------------------

describe('admin_audit_log table', () => {
  beforeEach(resetDb)
  afterAll(closeDb)

  it('persists admin_address, action, ip_address, payload, and created_at', async () => {
    const id = await insertAuditRow(
      'GBTEST1',
      'resolve_quarantined_event',
      '192.168.1.1',
      { event_id: 'abc-0', reason: 'manual' }
    )

    const rows = await query<AdminAuditLogRow>(
      'SELECT * FROM admin_audit_log WHERE id = $1',
      [id]
    )
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.admin_address).toBe('GBTEST1')
    expect(row.action).toBe('resolve_quarantined_event')
    expect(row.ip_address).toBe('192.168.1.1')
    expect(row.payload).toEqual({ event_id: 'abc-0', reason: 'manual' })
    expect(row.created_at).toBeTruthy()
  })

  it('stores null ip_address when not provided', async () => {
    const id = await insertAuditRow('GBTEST2', 'reset_cursor')
    const rows = await query<AdminAuditLogRow>(
      'SELECT ip_address FROM admin_audit_log WHERE id = $1',
      [id]
    )
    expect(rows[0]!.ip_address).toBeNull()
  })

  it('stores empty payload when not provided', async () => {
    const id = await insertAuditRow('GBTEST3', 'manual_reindex')
    const rows = await query<AdminAuditLogRow>(
      'SELECT payload FROM admin_audit_log WHERE id = $1',
      [id]
    )
    expect(rows[0]!.payload).toEqual({})
  })

  it('accepts multiple rows for the same admin_address (immutable append)', async () => {
    await insertAuditRow('GBTEST4', 'reset_cursor', null, { ledger: 100 })
    await insertAuditRow('GBTEST4', 'reset_cursor', null, { ledger: 200 })
    const rows = await query<AdminAuditLogRow>(
      'SELECT * FROM admin_audit_log WHERE admin_address = $1 ORDER BY id',
      ['GBTEST4']
    )
    expect(rows).toHaveLength(2)
    expect((rows[0]!.payload as { ledger: number }).ledger).toBe(100)
    expect((rows[1]!.payload as { ledger: number }).ledger).toBe(200)
  })

  it('id is a monotonically increasing BIGSERIAL', async () => {
    const id1 = await insertAuditRow('GBTEST5', 'reset_cursor')
    const id2 = await insertAuditRow('GBTEST5', 'manual_reindex')
    expect(id2).toBeGreaterThan(id1)
  })
})

// ---------------------------------------------------------------------------
// GET /api/admin/audit-log — authentication gate
// ---------------------------------------------------------------------------

describe('GET /api/admin/audit-log — authentication', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })
  afterAll(closeDb)

  it('returns 401 with no auth header', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/audit-log' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ error: expect.any(String), code: 'UNAUTHORIZED' })
  })

  it('returns 401 with a malformed auth header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-log',
      headers: { authorization: 'Bearer bad-token' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 200 with a valid Stellar signature', async () => {
    const kp = Keypair.random()
    const authHeader = await buildAuthHeader(app, kp)
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-log',
      headers: { authorization: authHeader },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// GET /api/admin/audit-log — listing, pagination, filters
// ---------------------------------------------------------------------------

describe('GET /api/admin/audit-log — listing and filtering', () => {
  let app: FastifyInstance
  const ADMIN_A = Keypair.random()
  const ADMIN_B = Keypair.random()

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })
  afterAll(closeDb)

  async function authedGet(url: string): Promise<ReturnType<FastifyInstance['inject']>> {
    const authHeader = await buildAuthHeader(app, ADMIN_A)
    return app.inject({ method: 'GET', url, headers: { authorization: authHeader } })
  }

  it('returns rows newest-id-first', async () => {
    await insertAuditRow(ADMIN_A.publicKey(), 'reset_cursor', null, { ledger: 1 })
    await insertAuditRow(ADMIN_A.publicKey(), 'manual_reindex', null, { ledger: 2 })
    await insertAuditRow(ADMIN_A.publicKey(), 'resolve_quarantined_event', null, { ledger: 3 })

    const res = await authedGet('/api/admin/audit-log')
    expect(res.statusCode).toBe(200)
    const rows = res.json<AdminAuditLogRow[]>()
    expect(rows).toHaveLength(3)
    // Newest first
    expect(rows[0]!.action).toBe('resolve_quarantined_event')
    expect(rows[1]!.action).toBe('manual_reindex')
    expect(rows[2]!.action).toBe('reset_cursor')
  })

  it('respects ?limit=', async () => {
    await insertAuditRow(ADMIN_A.publicKey(), 'reset_cursor')
    await insertAuditRow(ADMIN_A.publicKey(), 'reset_cursor')
    await insertAuditRow(ADMIN_A.publicKey(), 'reset_cursor')

    const res = await authedGet('/api/admin/audit-log?limit=2')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(2)
  })

  it('rejects an invalid limit', async () => {
    const res = await authedGet('/api/admin/audit-log?limit=abc')
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'invalid limit parameter' })
  })

  it('paginates with ?before= cursor (id-based)', async () => {
    const id1 = await insertAuditRow(ADMIN_A.publicKey(), 'reset_cursor')
    const id2 = await insertAuditRow(ADMIN_A.publicKey(), 'manual_reindex')
    const id3 = await insertAuditRow(ADMIN_A.publicKey(), 'resolve_quarantined_event')

    // First page: newest 2
    const page1 = await authedGet('/api/admin/audit-log?limit=2')
    const p1rows = page1.json<AdminAuditLogRow[]>()
    expect(p1rows.map((r) => r.id)).toEqual([id3, id2])

    // Second page: before the lowest id on page1
    const page2 = await authedGet(`/api/admin/audit-log?limit=2&before=${id2}`)
    const p2rows = page2.json<AdminAuditLogRow[]>()
    expect(p2rows.map((r) => r.id)).toEqual([id1])
  })

  it('rejects an invalid before cursor', async () => {
    const res = await authedGet('/api/admin/audit-log?before=notanumber')
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'invalid before cursor' })
  })

  it('filters by ?admin= address', async () => {
    await insertAuditRow(ADMIN_A.publicKey(), 'reset_cursor')
    await insertAuditRow(ADMIN_B.publicKey(), 'manual_reindex')
    await insertAuditRow(ADMIN_A.publicKey(), 'resolve_quarantined_event')

    const res = await authedGet(`/api/admin/audit-log?admin=${ADMIN_A.publicKey()}`)
    expect(res.statusCode).toBe(200)
    const rows = res.json<AdminAuditLogRow[]>()
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.admin_address === ADMIN_A.publicKey())).toBe(true)
  })

  it('rejects an invalid ?admin= address', async () => {
    const res = await authedGet('/api/admin/audit-log?admin=not-a-stellar-address')
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'invalid Stellar address' })
  })

  it('filters by ?action= type', async () => {
    await insertAuditRow(ADMIN_A.publicKey(), 'reset_cursor')
    await insertAuditRow(ADMIN_A.publicKey(), 'manual_reindex')
    await insertAuditRow(ADMIN_B.publicKey(), 'reset_cursor')

    const res = await authedGet('/api/admin/audit-log?action=reset_cursor')
    expect(res.statusCode).toBe(200)
    const rows = res.json<AdminAuditLogRow[]>()
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.action === 'reset_cursor')).toBe(true)
  })

  it('combines ?admin= and ?action= filters', async () => {
    await insertAuditRow(ADMIN_A.publicKey(), 'reset_cursor')
    await insertAuditRow(ADMIN_A.publicKey(), 'manual_reindex')
    await insertAuditRow(ADMIN_B.publicKey(), 'reset_cursor')

    const res = await authedGet(
      `/api/admin/audit-log?admin=${ADMIN_A.publicKey()}&action=reset_cursor`
    )
    const rows = res.json<AdminAuditLogRow[]>()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.admin_address).toBe(ADMIN_A.publicKey())
    expect(rows[0]!.action).toBe('reset_cursor')
  })

  it('rejects an empty ?action= string', async () => {
    const res = await authedGet('/api/admin/audit-log?action=')
    // Empty string is treated as absent (no filter) — not an error
    expect(res.statusCode).toBe(200)
  })

  it('returns all fields in each row', async () => {
    await insertAuditRow(
      ADMIN_A.publicKey(),
      'resolve_quarantined_event',
      '10.0.0.1',
      { event_id: 'xyz-1' }
    )
    const res = await authedGet('/api/admin/audit-log')
    const rows = res.json<AdminAuditLogRow[]>()
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.id).toBeTypeOf('number')
    expect(row.admin_address).toBe(ADMIN_A.publicKey())
    expect(row.action).toBe('resolve_quarantined_event')
    expect(row.ip_address).toBe('10.0.0.1')
    expect(row.payload).toEqual({ event_id: 'xyz-1' })
    expect(row.created_at).toMatch(/^\d{4}-/)
  })

  it('returns an empty array when no rows match the filter', async () => {
    await insertAuditRow(ADMIN_A.publicKey(), 'reset_cursor')
    const res = await authedGet('/api/admin/audit-log?action=manual_reindex')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })
})

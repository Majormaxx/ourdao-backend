// Issue #283: POST /api/admin/failed-events/:id/re-evaluate — the HTTP door
// onto indexer/replay.ts's replayFailedEvent, added for `npm run
// replay-failed` (issue #170).
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { query, queryOne } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

describe('API: POST /api/admin/failed-events/:id/re-evaluate (issue #283)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })
  afterAll(closeDb)

  it('rejects an empty event id', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/failed-events/%20/re-evaluate' })
    expect(res.statusCode).toBe(400)
  })

  it('transitions a quarantined event from quarantined to folded on success', async () => {
    // 'unknown_evt' has no registered handler — applyEvent's documented
    // no-op path for a symbol the catalog doesn't know — so this exercises
    // the full replay pipeline (lock, fold, markFolded, resolved_at) without
    // needing to set up unrelated domain state a real handler would touch.
    await query(
      `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data)
       VALUES ('1-0', 100, now(), 'CTEST', 'unknown_evt', '[]', '[]')`
    )
    await query(
      `INSERT INTO failed_events (event_id, symbol, ledger, error) VALUES ('1-0', 'unknown_evt', 100, 'boom')`
    )

    const res = await app.inject({ method: 'POST', url: '/api/admin/failed-events/1-0/re-evaluate' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ eventId: '1-0', status: 'replayed' })

    const eventRow = await queryOne<{ folded_at: string | null }>(
      'SELECT folded_at FROM events WHERE id = $1',
      ['1-0']
    )
    expect(eventRow?.folded_at).not.toBeNull()

    const failedRow = await queryOne<{ resolved_at: string | null }>(
      'SELECT resolved_at FROM failed_events WHERE event_id = $1',
      ['1-0']
    )
    expect(failedRow?.resolved_at).not.toBeNull()

    // No longer listed among unresolved quarantined events.
    const listRes = await app.inject({ method: 'GET', url: '/api/admin/failed-events?unresolved=true' })
    expect(listRes.json()).toHaveLength(0)
  })

  it('reports already_resolved without re-applying when the event was already folded', async () => {
    await query(
      `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data, folded_at)
       VALUES ('2-0', 200, now(), 'CTEST', 'unknown_evt', '[]', '[]', now())`
    )
    await query(
      `INSERT INTO failed_events (event_id, symbol, ledger, error) VALUES ('2-0', 'unknown_evt', 200, 'boom')`
    )

    const res = await app.inject({ method: 'POST', url: '/api/admin/failed-events/2-0/re-evaluate' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ eventId: '2-0', status: 'already_resolved' })
  })

  it('reports already_resolved for an event id with no unresolved failed_events record', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/failed-events/does-not-exist/re-evaluate' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ eventId: 'does-not-exist', status: 'already_resolved' })
  })

  it('returns 422 with no raw exception text when the handler still fails', async () => {
    // 'loan_dflt' has a real registered handler; with no corresponding loan
    // row in `loans`, applying it throws — a realistic still-broken case.
    await query(
      `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data)
       VALUES ('3-0', 300, now(), 'CTEST', 'loan_dflt', '[]', '[999]')`
    )
    await query(
      `INSERT INTO failed_events (event_id, symbol, ledger, error) VALUES ('3-0', 'loan_dflt', 300, 'original boom')`
    )

    const res = await app.inject({ method: 'POST', url: '/api/admin/failed-events/3-0/re-evaluate' })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({ eventId: '3-0', status: 'still_failing' })
    expect(res.payload).not.toContain('original boom')

    const failedRow = await queryOne<{ resolved_at: string | null; error: string }>(
      'SELECT resolved_at, error FROM failed_events WHERE event_id = $1',
      ['3-0']
    )
    expect(failedRow?.resolved_at).toBeNull()
    // The existing row's error is updated in place, not duplicated into a
    // second record (replayFailedEvent's own documented invariant).
    const allRowsForEvent = await query('SELECT id FROM failed_events WHERE event_id = $1', ['3-0'])
    expect(allRowsForEvent).toHaveLength(1)
  })
})

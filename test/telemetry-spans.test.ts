// Issue #288: OpenTelemetry spans around the indexer's event processing loop.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { pool } from '../src/db/index.js'
import { applyEvent } from '../src/indexer/handlers.js'
import { fetchOnce } from '../src/indexer/poller.js'
import { closeDb, resetDb } from './db.js'
import { decodedEvent } from './fixtures.js'
import type { DecodedEvent } from '../src/stellar/events.js'

vi.mock('../src/stellar/events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/stellar/events.js')>()
  return { ...actual, decodeEvent: (raw: unknown) => raw as DecodedEvent }
})

const getEventsMock = vi.fn()
vi.mock('../src/stellar/rpc.js', () => ({
  server: { getEvents: (...args: unknown[]) => getEventsMock(...(args as [unknown])) },
  getLatestLedger: vi.fn().mockResolvedValue(100_000),
  getLatestLedgerInfo: vi.fn().mockResolvedValue({ sequence: 100_000, hash: 'HASH_TIP' }),
  getLedgerHash: vi.fn().mockResolvedValue('HASH_FOR_LEDGER'),
}))

const exporter = new InMemorySpanExporter()
let provider: NodeTracerProvider

beforeAll(() => {
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  provider.register()
})

afterAll(async () => {
  await provider.shutdown()
})

describe('indexer.apply_event span (issue #288)', () => {
  beforeEach(async () => {
    await resetDb()
    exporter.reset()
  })
  afterAll(closeDb)

  it('records symbol, ledger, and handler duration for a known event', async () => {
    const ev = decodedEvent('joined', { member: 'GA', fee: '10' })
    const client = await pool.connect()
    try {
      await applyEvent(client, ev)
    } finally {
      client.release()
    }

    const spans = exporter.getFinishedSpans().filter((s) => s.name === 'indexer.apply_event')
    expect(spans).toHaveLength(1)
    const span = spans[0]!
    expect(span.attributes['event.symbol']).toBe('joined')
    expect(span.attributes['event.ledger']).toBe(ev.ledger)
    expect(span.attributes['event.has_handler']).toBe(true)
    expect(typeof span.attributes['event.handler_duration_ms']).toBe('number')
    expect(span.status.code).not.toBe(2) // SpanStatusCode.ERROR
  })

  it('still emits a span for an event with no registered handler', async () => {
    const ev = decodedEvent('joined', { member: 'GA', fee: '10' })
    const unknownEv = { ...ev, symbol: 'totally_unknown_symbol' } as DecodedEvent
    const client = await pool.connect()
    try {
      await applyEvent(client, unknownEv)
    } finally {
      client.release()
    }

    const spans = exporter.getFinishedSpans().filter((s) => s.name === 'indexer.apply_event')
    expect(spans).toHaveLength(1)
    expect(spans[0]!.attributes['event.has_handler']).toBe(false)
  })

  it('marks the span as errored when the handler throws, without swallowing the error', async () => {
    // loan_dflt with no penalty field throws deterministically (issue #42).
    const bad = decodedEvent('loan_dflt', { loan_id: 1, borrower: 'GA' })
    const client = await pool.connect()
    try {
      await expect(applyEvent(client, bad)).rejects.toThrow(/penalty/)
    } finally {
      client.release()
    }

    const spans = exporter.getFinishedSpans().filter((s) => s.name === 'indexer.apply_event')
    expect(spans).toHaveLength(1)
    expect(spans[0]!.status.code).toBe(2) // SpanStatusCode.ERROR
    expect(spans[0]!.events.some((e) => e.name === 'exception')).toBe(true)
  })
})

describe('indexer.page span (issue #288)', () => {
  beforeEach(async () => {
    await resetDb()
    getEventsMock.mockReset()
    exporter.reset()
  })
  afterAll(closeDb)

  it('records the contract, page number, and event count for a drained page', async () => {
    const ev = decodedEvent('joined', { member: 'GA', fee: '10' })
    getEventsMock.mockResolvedValueOnce({ events: [ev], cursor: 'tok', latestLedger: 100_000 })

    await fetchOnce('CSPANTEST')

    const spans = exporter.getFinishedSpans().filter((s) => s.name === 'indexer.page')
    expect(spans).toHaveLength(1)
    const span = spans[0]!
    expect(span.attributes['page.contract_id']).toBe('CSPANTEST')
    expect(span.attributes['page.number']).toBe(1)
    expect(span.attributes['page.event_count']).toBe(1)
    expect(span.status.code).not.toBe(2) // SpanStatusCode.ERROR
  })
})

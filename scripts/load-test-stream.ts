#!/usr/bin/env tsx
/**
 * SSE /api/stream load test — issue #295.
 *
 * Verifies the shared-listener architecture (issue #152) under realistic
 * load: 1000 concurrent SSE clients sharing exactly one Postgres LISTEN
 * connection, subjected to 100 simulated NOTIFY broadcasts, with memory
 * and pool-connection metrics collected throughout.
 *
 * What it measures:
 *   • Connection ramp time (time to open all 1000 SSE sockets)
 *   • NOTIFY fan-out latency per broadcast (p50 / p95 / max across all clients)
 *   • RSS growth during the run (memory stability proxy)
 *   • Pool connection count before and after (confirms exactly 1 listener slot)
 *   • Zero dropped connections under load
 *
 * Usage:
 *   npm run load:stream                          # default: 1000 clients, 100 NOTIFYs
 *   LOAD_CLIENTS=200 LOAD_NOTIFIES=20 npm run load:stream
 *   LOAD_URL=http://staging:4000 npm run load:stream   # against a remote server
 *
 * The script can target either an in-process server spun up here (default,
 * no DATABASE_URL required other than for seeding the NOTIFY) or a remote
 * server via LOAD_URL. When targeting an in-process server, DATABASE_URL
 * must be set (the server migrates on boot).
 *
 * Exit codes:
 *   0  — all assertions passed
 *   1  — at least one assertion failed (details printed to stderr)
 */

import http from 'node:http'
import { performance } from 'node:perf_hooks'
import { EventEmitter } from 'node:events'

// ── Configuration ─────────────────────────────────────────────────────────────

const CONCURRENT_CLIENTS    = parseInt(process.env.LOAD_CLIENTS  ?? '1000', 10)
const NOTIFY_BROADCASTS     = parseInt(process.env.LOAD_NOTIFIES ?? '100',  10)
// Per-client connect timeout: how long (ms) each socket may take to receive
// its opening "Connected to stream" frame before we count it as a timeout.
const CONNECT_TIMEOUT_MS    = parseInt(process.env.LOAD_CONNECT_TIMEOUT_MS ?? '10000', 10)
// How long (ms) between consecutive NOTIFY broadcasts (keeps the server from
// being flooded with 100 notifies at the same instant).
const NOTIFY_INTERVAL_MS    = parseInt(process.env.LOAD_NOTIFY_INTERVAL_MS ?? '50',    10)
// Per-broadcast delivery timeout: how long (ms) each subscribed client is
// given to receive the frame before we count it as undelivered.
const DELIVERY_TIMEOUT_MS   = parseInt(process.env.LOAD_DELIVERY_TIMEOUT_MS ?? '5000', 10)
// Optional: target a running server instead of spinning one up in-process.
const LOAD_URL              = process.env.LOAD_URL ?? ''
// The `pool` / Postgres notifier is only needed when running in-process.
// When LOAD_URL is set we skip the NOTIFY step (external servers notified
// by their own indexer worker) and measure connection stability only.
const SKIP_NOTIFY           = LOAD_URL !== ''

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Structured test result for one assertion. */
interface AssertionResult {
  name: string
  pass: boolean
  detail: string
}

const assertions: AssertionResult[] = []

function assert(name: string, pass: boolean, detail: string): void {
  assertions.push({ name, pass, detail })
  const icon = pass ? '✓' : '✗'
  const out = pass ? process.stdout : process.stderr
  out.write(`  ${icon} ${name}: ${detail}\n`)
}

/** Open one SSE connection and return the IncomingMessage (headers validated). */
function openStream(base: string, path = '/api/stream'): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}${path}`, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode} from ${path}`))
      } else {
        resolve(res)
      }
    })
    req.on('error', reject)
    req.setTimeout(CONNECT_TIMEOUT_MS, () => {
      req.destroy(new Error(`connect timeout after ${CONNECT_TIMEOUT_MS}ms`))
    })
  })
}

interface SseFrame {
  event: string
  id: string
  data: Record<string, unknown>
}

/**
 * Wait for the first SSE frame of a given event type from `res`.
 * Resolves with the frame; rejects on timeout or stream error.
 */
function waitForFrame(
  res: http.IncomingMessage,
  eventType: string,
  timeoutMs: number
): Promise<SseFrame> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => {
      reject(new Error(`timeout waiting for "${eventType}" frame after ${timeoutMs}ms`))
    }, timeoutMs)

    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let idx: number
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const parsed: Record<string, string> = {}
        for (const line of raw.split('\n')) {
          const sep = line.indexOf(': ')
          if (sep === -1) continue
          parsed[line.slice(0, sep)!] = line.slice(sep + 2)
        }
        const frame: SseFrame = {
          event: parsed['event'] ?? '',
          id: parsed['id'] ?? '',
          data: parsed['data'] ? (JSON.parse(parsed['data']) as Record<string, unknown>) : {},
        }
        if (frame.event === eventType) {
          clearTimeout(timer)
          res.removeListener('data', onData)
          res.removeListener('error', onError)
          resolve(frame)
          return
        }
      }
    }

    const onError = (err: Error) => {
      clearTimeout(timer)
      reject(err)
    }

    res.on('data', onData)
    res.on('error', onError)
  })
}

/** Format a duration in ms with 2 decimal places. */
function ms(n: number): string {
  return `${n.toFixed(2)}ms`
}

/** Compute p-th percentile of a pre-sorted numeric array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1)
  return sorted[idx]!
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('━'.repeat(72))
  console.log(`OurDAO SSE /api/stream load test — issue #295`)
  console.log('━'.repeat(72))
  console.log(`  Concurrent clients : ${CONCURRENT_CLIENTS}`)
  console.log(`  NOTIFY broadcasts  : ${NOTIFY_BROADCASTS}`)
  console.log(`  Mode               : ${LOAD_URL ? `remote (${LOAD_URL})` : 'in-process'}`)
  console.log()

  // ── Server setup ─────────────────────────────────────────────────────────

  let base: string
  let pool: import('pg').Pool | null = null
  let shutdownServer: (() => Promise<void>) | null = null

  if (LOAD_URL) {
    base = LOAD_URL
  } else {
    // Spin up the real Fastify server in this process. This requires
    // DATABASE_URL (or PG* vars) to be set in the environment.
    console.log('[setup] Starting in-process server...')
    const { buildServer } = await import('../src/api/server.js')
    const { pool: dbPool } = await import('../src/db/index.js')
    const { migrate } = await import('../src/db/migrate.js')
    const {
      shutdownSharedListener,
      streamLimits,
    } = await import('../src/api/stream.js')

    await migrate()
    pool = dbPool

    // Raise stream limits so the load test can open 1000+ connections in one
    // process without 503s. In a real deployment, STREAM_MAX_CONNECTIONS is
    // the operator knob for this.
    streamLimits.maxConnections = CONCURRENT_CLIENTS + 50
    streamLimits.maxConnectionsPerIp = CONCURRENT_CLIENTS + 50

    const app = await buildServer({ logger: { level: 'silent' } })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const addr = app.server.address()
    if (!addr || typeof addr === 'string') throw new Error('expected TCP address')
    base = `http://127.0.0.1:${addr.port}`

    shutdownServer = async () => {
      await app.close()
      await shutdownSharedListener()
      await dbPool.end()
    }

    console.log(`[setup] Server listening at ${base}`)
  }

  // ── Baseline pool snapshot ─────────────────────────────────────────────

  // Count DB connections visible in pg_stat_activity before opening any
  // SSE sockets. We compare this after all clients connect to confirm the
  // shared listener consumed exactly one extra connection.
  let baselineDbConns = -1
  let peakDbConns     = -1
  if (pool) {
    try {
      const res = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND state != 'idle'`
      )
      baselineDbConns = parseInt(res.rows[0]?.count ?? '-1', 10)
      console.log(`[baseline] Active DB connections before load: ${baselineDbConns}`)
    } catch (err) {
      console.warn('[baseline] Could not read pg_stat_activity:', err)
    }
  }

  // ── Ramp: open 1000 concurrent SSE connections ─────────────────────────

  console.log(`\n[phase 1] Opening ${CONCURRENT_CLIENTS} SSE connections...`)
  const rampStart  = performance.now()
  const rssBeforeRamp = process.memoryUsage().rss

  const streams: http.IncomingMessage[] = []
  let connectTimeouts = 0
  let connectErrors   = 0

  // Open all connections in parallel and wait for each to deliver its
  // initial "Connected to stream" notification frame, proving the SSE
  // handshake completed (headers sent + first data frame flushed).
  const connectResults = await Promise.allSettled(
    Array.from({ length: CONCURRENT_CLIENTS }, async (_, i) => {
      const res = await openStream(base)
      // Wait for the initial connected frame to confirm streaming is live.
      await waitForFrame(res, 'notification', CONNECT_TIMEOUT_MS)
      streams.push(res)
      if ((i + 1) % 100 === 0) {
        process.stdout.write(`  ... ${i + 1} connected\n`)
      }
      return res
    })
  )

  const rampDuration = performance.now() - rampStart
  const rssAfterRamp = process.memoryUsage().rss

  for (const r of connectResults) {
    if (r.status === 'rejected') {
      const msg = (r.reason as Error).message ?? ''
      if (msg.includes('timeout')) connectTimeouts++
      else connectErrors++
    }
  }

  const successfulConnects = connectResults.filter((r) => r.status === 'fulfilled').length
  console.log(`[phase 1] Opened ${successfulConnects}/${CONCURRENT_CLIENTS} in ${ms(rampDuration)}`)
  console.log(`          Timeouts: ${connectTimeouts}  Errors: ${connectErrors}`)
  console.log(`          RSS before ramp: ${(rssBeforeRamp / 1024 / 1024).toFixed(1)} MB`)
  console.log(`          RSS after  ramp: ${(rssAfterRamp  / 1024 / 1024).toFixed(1)} MB`)
  console.log(`          RSS delta:       ${((rssAfterRamp - rssBeforeRamp) / 1024 / 1024).toFixed(1)} MB`)

  // ── Post-ramp DB connection snapshot ──────────────────────────────────

  if (pool) {
    try {
      const res = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND state != 'idle'`
      )
      peakDbConns = parseInt(res.rows[0]?.count ?? '-1', 10)
      const delta = peakDbConns - baselineDbConns
      console.log(`\n[pool] Active DB connections with ${successfulConnects} SSE clients: ${peakDbConns} (delta: +${delta})`)
    } catch (err) {
      console.warn('[pool] Could not read pg_stat_activity:', err)
    }
  }

  // ── Broadcasts: fire 100 NOTIFY payloads ──────────────────────────────

  const broadcastLatencies: number[][] = Array.from(
    { length: NOTIFY_BROADCASTS },
    () => []
  )
  let broadcastDrops = 0

  if (!SKIP_NOTIFY && pool && successfulConnects > 0) {
    console.log(`\n[phase 2] Broadcasting ${NOTIFY_BROADCASTS} NOTIFY messages...`)

    const { STREAM_CHANNELS } = await import('../src/api/stream.js')
    const channel = STREAM_CHANNELS.loans // representative channel

    for (let b = 0; b < NOTIFY_BROADCASTS; b++) {
      const payload = JSON.stringify({ symbol: 'loans_changed', ledger: 500000 + b })
      const notifyStart = performance.now()

      // Issue the NOTIFY from the shared pool (same path the indexer uses
      // via notifyStreamClientsAfterCommit).
      await pool.query('SELECT pg_notify($1, $2)', [channel, payload])

      // Wait for all connected clients to receive the frame, recording per-
      // client delivery latency. A client that times out is counted as a drop.
      const deliveryPromises = streams.map(async (res) => {
        try {
          await waitForFrame(res, 'notification', DELIVERY_TIMEOUT_MS)
          broadcastLatencies[b]!.push(performance.now() - notifyStart)
        } catch {
          broadcastDrops++
        }
      })

      await Promise.allSettled(deliveryPromises)

      if ((b + 1) % 10 === 0) {
        const lats = broadcastLatencies[b]!
        lats.sort((a, c) => a - c)
        const p50 = percentile(lats, 0.5)
        const p95 = percentile(lats, 0.95)
        process.stdout.write(
          `  broadcast ${b + 1}/${NOTIFY_BROADCASTS}: p50=${ms(p50)} p95=${ms(p95)} ` +
          `delivered=${lats.length}/${streams.length}\n`
        )
      }

      if (b < NOTIFY_BROADCASTS - 1) {
        await new Promise((r) => setTimeout(r, NOTIFY_INTERVAL_MS))
      }
    }
  } else if (SKIP_NOTIFY) {
    console.log('\n[phase 2] Skipped (remote mode — NOTIFY is driven by the target server)')
  } else if (successfulConnects === 0) {
    console.log('\n[phase 2] Skipped — no clients connected successfully')
  }

  // ── Teardown ──────────────────────────────────────────────────────────

  console.log('\n[teardown] Closing all stream connections...')
  for (const res of streams) {
    try { res.destroy() } catch { /* already gone */ }
  }
  // Brief settle so the server registers the closes.
  await new Promise((r) => setTimeout(r, 200))

  const rssFinal = process.memoryUsage().rss
  console.log(`[teardown] RSS after teardown: ${(rssFinal / 1024 / 1024).toFixed(1)} MB`)

  if (shutdownServer) {
    await shutdownServer()
  }

  // ── Metrics summary ───────────────────────────────────────────────────

  console.log('\n' + '━'.repeat(72))
  console.log('RESULTS')
  console.log('━'.repeat(72))

  // Flatten all delivery latencies for aggregate percentiles.
  const allLatencies = broadcastLatencies.flat().sort((a, b) => a - b)

  if (allLatencies.length > 0) {
    const p50 = percentile(allLatencies, 0.5)
    const p95 = percentile(allLatencies, 0.95)
    const maxLat = allLatencies[allLatencies.length - 1]!
    const minLat = allLatencies[0]!
    const mean = allLatencies.reduce((s, v) => s + v, 0) / allLatencies.length

    console.log('\nDelivery latency (NOTIFY → client frame):')
    console.log(`  Min  : ${ms(minLat)}`)
    console.log(`  p50  : ${ms(p50)}`)
    console.log(`  p95  : ${ms(p95)}`)
    console.log(`  Max  : ${ms(maxLat)}`)
    console.log(`  Mean : ${ms(mean)}`)
    console.log(`  Total frames delivered: ${allLatencies.length}`)
    console.log(`  Total frames dropped  : ${broadcastDrops}`)
  }

  console.log('\nConnection ramp:')
  console.log(`  Target      : ${CONCURRENT_CLIENTS} clients`)
  console.log(`  Connected   : ${successfulConnects}`)
  console.log(`  Timeouts    : ${connectTimeouts}`)
  console.log(`  Errors      : ${connectErrors}`)
  console.log(`  Duration    : ${ms(rampDuration)}`)

  const rssDeltaMb = (rssAfterRamp - rssBeforeRamp) / 1024 / 1024
  console.log('\nMemory:')
  console.log(`  RSS before ramp  : ${(rssBeforeRamp / 1024 / 1024).toFixed(1)} MB`)
  console.log(`  RSS after  ramp  : ${(rssAfterRamp  / 1024 / 1024).toFixed(1)} MB`)
  console.log(`  RSS after teardown: ${(rssFinal / 1024 / 1024).toFixed(1)} MB`)
  console.log(`  Delta (ramp)     : ${rssDeltaMb.toFixed(1)} MB`)

  if (pool && baselineDbConns >= 0 && peakDbConns >= 0) {
    const delta = peakDbConns - baselineDbConns
    console.log('\nPostgres connections:')
    console.log(`  Baseline (pre-ramp)          : ${baselineDbConns}`)
    console.log(`  Peak (${successfulConnects} clients connected): ${peakDbConns}`)
    console.log(`  Delta                         : +${delta}`)
  }

  // ── Assertions ────────────────────────────────────────────────────────

  console.log('\n' + '━'.repeat(72))
  console.log('ASSERTIONS')
  console.log('━'.repeat(72))
  console.log()

  // 1. At least 99% of clients connected (tolerance for CI flakiness).
  const connectRate = successfulConnects / CONCURRENT_CLIENTS
  assert(
    'Connection success rate ≥ 99%',
    connectRate >= 0.99,
    `${successfulConnects}/${CONCURRENT_CLIENTS} (${(connectRate * 100).toFixed(1)}%)`
  )

  // 2. RSS growth stays below a hard ceiling. 1000 open HTTP sockets + the
  //    SSE write buffers should not cost more than ~200 MB beyond baseline.
  //    Node's idle RSS typically runs 40–80 MB; 200 MB absolute headroom is
  //    generous while still catching a connection-leak regression.
  const RSS_GROWTH_LIMIT_MB = 200
  assert(
    `RSS growth during ramp < ${RSS_GROWTH_LIMIT_MB} MB`,
    rssDeltaMb < RSS_GROWTH_LIMIT_MB,
    `${rssDeltaMb.toFixed(1)} MB`
  )

  // 3. Shared listener consumed exactly one extra DB connection (issue #152).
  //    The delta should be 1 (the listener) ±0 normal request connections.
  //    Allow up to 3 to tolerate a brief pool checkout for initial queries.
  if (pool && baselineDbConns >= 0 && peakDbConns >= 0) {
    const delta = peakDbConns - baselineDbConns
    assert(
      'DB connection delta ≤ 3 (shared listener, not per-client)',
      delta <= 3,
      `+${delta} connections for ${successfulConnects} SSE clients`
    )
  }

  // 4. Zero dropped NOTIFY deliveries (every broadcast reached every client).
  if (!SKIP_NOTIFY && allLatencies.length > 0) {
    assert(
      'Zero NOTIFY delivery drops',
      broadcastDrops === 0,
      broadcastDrops === 0
        ? `all ${allLatencies.length} deliveries succeeded`
        : `${broadcastDrops} drops out of ${allLatencies.length + broadcastDrops}`
    )
  }

  // 5. p95 fan-out latency below 1 s under 1000 clients.
  if (allLatencies.length > 0) {
    const p95 = percentile(allLatencies, 0.95)
    assert(
      'p95 fan-out latency < 1000ms',
      p95 < 1000,
      ms(p95)
    )
  }

  // ── Final verdict ─────────────────────────────────────────────────────

  const failed = assertions.filter((a) => !a.pass)
  console.log()
  if (failed.length === 0) {
    console.log('ALL ASSERTIONS PASSED')
    console.log()
    process.exit(0)
  } else {
    console.error(`${failed.length} ASSERTION(S) FAILED:`)
    for (const a of failed) {
      console.error(`  ✗ ${a.name}: ${a.detail}`)
    }
    console.log()
    process.exit(1)
  }
}

main().catch((err: unknown) => {
  console.error('[load-test-stream] fatal:', err)
  process.exit(1)
})

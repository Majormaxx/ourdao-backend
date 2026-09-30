import './worker-role.js'
import { initTelemetry, shutdownTelemetry } from './telemetry.js'
import { migrate } from './db/migrate.js'
import { pool, createDedicatedClient } from './db/index.js'
import { runIndexer, stopIndexer } from './indexer/poller.js'
import { config } from './config.js'
import { runMaintenance, logMaintenanceResult } from './db/maintenance.js'

const SHUTDOWN_TIMEOUT_MS = 10_000

// Issue #279: periodic VACUUM ANALYZE + expired-auth_nonces sweep, run
// alongside the indexer loop on its own abort-aware timer — a self-
// rescheduling setTimeout loop (matching the style already used by the
// indexer's own poll loop in src/indexer/poller.ts), so a maintenance run
// that takes a while never overlaps with the next scheduled one, and the
// loop stops promptly on shutdown rather than leaving a dangling timer.
function runMaintenanceLoop(signal: AbortSignal): { stopped: Promise<void> } {
  let resolveStopped: () => void
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve
  })

  async function tick(): Promise<void> {
    if (signal.aborted) {
      resolveStopped()
      return
    }

    const client = createDedicatedClient()
    try {
      await client.connect()
      const result = await runMaintenance(client)
      logMaintenanceResult(result)
    } catch (err) {
      // A maintenance run failing outright (e.g. can't even connect) must
      // never crash the worker or block the indexer (issue #279) — log and
      // wait for the next scheduled run.
      console.error('[maintenance] run failed unexpectedly:', err)
    } finally {
      try {
        await client.end()
      } catch {
        // Ignore — the connection may already be gone.
      }
    }

    if (signal.aborted) {
      resolveStopped()
      return
    }

    const timer = setTimeout(() => void tick(), config.maintenance.intervalMs)
    // Don't hold the process open on this timer alone — mirrors the
    // indexer's own backoff-sleep timers (issue #121).
    if (timer.unref) timer.unref()
    signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  }

  void tick()
  return { stopped }
}

async function main(): Promise<void> {
  // Issue #288: registered before anything else runs, matching OpenTelemetry's
  // own recommended Node.js bootstrap ordering — a no-op when OTEL_ENABLED
  // is unset (the default), see src/telemetry.ts.
  initTelemetry()
  await migrate()

  const maintenanceAbort = new AbortController()
  const maintenance = runMaintenanceLoop(maintenanceAbort.signal)

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[indexer] received ${signal} — waiting for current page to complete`)

    maintenanceAbort.abort()

    // Wait for the indexer loop to finish its current page and exit,
    // bounded so a wedged RPC call can't hang shutdown forever (issue #47).
    const stopPromise = stopIndexer()
    let timedOut = false
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true
        resolve()
      }, SHUTDOWN_TIMEOUT_MS)
    })
    await Promise.race([stopPromise, timeout])

    if (timedOut) {
      // stopIndexer() never resolved within the budget — closing the pool
      // now risks doing so mid-transaction (issue #122). The backoff sleep
      // is abort-aware (issue #121), so runIndexer's loop should exit almost
      // immediately once signaled; hitting this budget instead means
      // something else is stuck (a wedged RPC call, a long-running query)
      // and is worth investigating, not a normal shutdown path.
      console.error(
        `[indexer] shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms — closing the pool anyway; ` +
          `the indexer loop may still have been mid-transaction`
      )
    }

    // The maintenance loop only checks its abort signal between runs (or
    // right after connecting), so it isn't raced here the way the indexer
    // is above — a maintenance run in flight when shutdown starts is a plain
    // VACUUM/DELETE using its own dedicated connection, entirely independent
    // of `pool`, and finishes (or fails) on its own without blocking this.
    void maintenance.stopped

    console.log('[indexer] closing database pool')
    await pool.end()
    await shutdownTelemetry()
    console.log('[indexer] shutdown complete')
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await runIndexer()
}

main().catch((err) => {
  console.error('[indexer] fatal:', err)
  process.exit(1)
})

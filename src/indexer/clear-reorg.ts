// Issue #191: acknowledge a recorded ledger discontinuity without rebuilding.
//
// `npm run reorg:clear` — for a false alarm (an RPC that briefly served a
// wrong hash, a rewind the network itself corrected) confirmed per the triage
// steps in docs/REORG_RECOVERY.md. After a *real* divergence use
// `npm run reindex` instead: it rebuilds the derived tables and clears the
// halt in the same transaction. Either way the worker refuses to start until
// one of the two has run.
import { pool } from '../db/index.js'
import { clearReorgHalts, loadUnclearedReorgHalt } from './poller.js'

async function main(): Promise<void> {
  const halt = await loadUnclearedReorgHalt()
  if (!halt) {
    console.log('[reorg:clear] no uncleared ledger discontinuity recorded — nothing to do')
    return
  }
  console.log(
    `[reorg:clear] clearing the discontinuity recorded at ${new Date(halt.detected_at).toISOString()} ` +
      `on ${halt.contract_id} (last folded ledger ${halt.last_ledger ?? 'unknown'}): ${halt.detail}`
  )
  const cleared = await clearReorgHalts('operator')
  console.log(`[reorg:clear] cleared ${cleared} record(s); the worker may be restarted`)
}

main()
  .catch((err) => {
    console.error('[reorg:clear] failed:', err)
    process.exitCode = 1
  })
  .finally(() => pool.end())

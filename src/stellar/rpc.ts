import { rpc } from '@stellar/stellar-sdk'
import { config } from '../config.js'

// Allow http:// for local/standalone RPC while defaulting to secure transport.
// `headers` (issue #284) lets a managed/private RPC provider (QuickNode and
// similar) require an API key or bearer token — only set when
// STELLAR_RPC_HEADERS is non-empty, since passing `headers: {}` is harmless
// but passing `undefined` more clearly reflects "not configured" if the SDK
// ever branches on the option's presence rather than its contents.
const rpcHeaders = config.stellar.rpcHeaders
export const server = new rpc.Server(config.stellar.rpcUrl, {
  allowHttp: config.stellar.rpcUrl.startsWith('http://'),
  ...(Object.keys(rpcHeaders).length > 0 ? { headers: rpcHeaders } : {}),
})

export async function getLatestLedger(): Promise<number> {
  const res = await server.getLatestLedger()
  return res.sequence
}

/** Latest-ledger sequence plus its hash (`id`) — used for the coarse rewind
 *  signal in reorg detection (issue #23). */
export async function getLatestLedgerInfo(): Promise<{ sequence: number; hash: string }> {
  const res = await server.getLatestLedger()
  return { sequence: res.sequence, hash: res.id }
}

/** Hash of a specific ledger by sequence. Soroban's `getEvents` exposes no
 *  per-event ledger hash, so this is how the poller learns the hash of the
 *  ledger it actually folded to (issue #127) and later re-checks it against
 *  what the RPC reports for that same sequence, to catch a same-height fork
 *  the sequence-only continuity check can't see (issue #128).
 *
 *  Resolves to null — never rejects — when the RPC can't answer: it throws
 *  (rather than returning an empty page) when `sequence` has aged out of its
 *  retention window, and a transient RPC/network error is just as
 *  unanswerable here. Either way, callers must treat null as "unverifiable",
 *  not as evidence of a fork; letting a hiccup on this best-effort check
 *  reject would otherwise wedge fetchOnce in permanent retry over a ledger
 *  whose events may already be safely folded and committed. */
export async function getLedgerHash(sequence: number): Promise<string | null> {
  try {
    const res = await server.getLedgers({ startLedger: sequence, pagination: { limit: 1 } })
    return res.ledgers[0]?.hash ?? null
  } catch {
    return null
  }
}

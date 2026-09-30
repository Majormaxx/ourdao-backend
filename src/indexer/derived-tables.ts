// Canonical list of tables derived from the raw `events` log.
//
// Every table that is rebuilt by reindexing or wiped on contract repoint must
// appear here exactly once. Both `poller.ts` (resetForContractChange) and
// `reindex.ts` (reindexFromEventLog) import this list so they can never drift.

export const DERIVED_TABLES = [
  'members',
  'loan_proposals',
  'loans',
  'treasury_proposals',
  'notifications',
  'interest_distributions',
  'daily_loan_stats',
  'documents',
] as const

/** Reset the `dao_totals` singleton in place. This row is a fixed single-row
 *  table that can't be truncated, so both the reset path (contract repoint)
 *  and the reindex path must zero it identically. */
export async function resetDaoTotals(client: { query: (sql: string) => Promise<unknown> }): Promise<void> {
  await client.query(
    `UPDATE dao_totals
        SET interest_collected = 0, principal_lent = 0,
            principal_repaid = 0, value_defaulted = 0, updated_at = now()
      WHERE id = 1`
  )
}

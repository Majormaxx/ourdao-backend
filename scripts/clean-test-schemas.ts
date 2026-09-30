#!/usr/bin/env node --import=tsx
/**
 * Clean up orphaned test_worker_* schemas left behind by interrupted test runs
 * (issue #204).
 *
 * Parallel test execution creates one schema per worker (test_worker_1,
 * test_worker_2, etc.). test/setup.ts drops its schema on clean exit, but a
 * killed test run leaves them behind. This script removes all test_worker_*
 * schemas to reclaim space and avoid schema bloat.
 *
 * Safe to run at any time — if tests are running, they'll recreate their
 * schemas as needed.
 */
import { pool } from '../src/db/index.js'

async function main(): Promise<void> {
  try {
    // Find all test_worker_* schemas
    const { rows } = await pool.query<{ schema_name: string }>(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name LIKE 'test_worker_%'
       ORDER BY schema_name`
    )

    if (rows.length === 0) {
      console.log('No orphaned test schemas found.')
      return
    }

    console.log(`Found ${rows.length} test schema(s):`, rows.map(r => r.schema_name).join(', '))

    for (const { schema_name } of rows) {
      console.log(`Dropping ${schema_name}...`)
      await pool.query(`DROP SCHEMA IF EXISTS "${schema_name}" CASCADE`)
    }

    console.log(`✓ Cleaned up ${rows.length} test schema(s)`)
  } catch (err) {
    console.error('[clean-test-schemas] failed:', err)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error('[clean-test-schemas] fatal:', err)
  process.exit(1)
})

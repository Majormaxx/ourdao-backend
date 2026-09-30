import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // DB-backed tests do real round trips against a local Postgres.
    testTimeout: 10_000,
    hookTimeout: 10_000,
    setupFiles: ['./test/setup.ts'],
    // Issue #204: Re-enabled parallel file execution. Each worker gets its own
    // Postgres schema (test_worker_1, test_worker_2, etc.) set up in
    // test/setup.ts, so TRUNCATE operations no longer race across files.
    fileParallelism: true,

    // Coverage measurement (#79). `npm run test:coverage` writes a per-file
    // report; CI enforces the thresholds below and prints the summary to the
    // job output. v8 instrumentation adds little here because the tests are
    // already run once — with `fileParallelism: false` the observed CI delta
    // is small (see PR).
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts', // process bootstrap, no logic
        'src/worker.ts', // process bootstrap, no logic
        '**/*.config.*',
        'dist/**',
      ],
      // Issue #208: Per-directory thresholds enforce coverage at module
      // granularity rather than one aggregate. Indexer and auth have higher
      // bars due to their risk profile (money-relevant state, authorization
      // boundary). Current levels preserved on adoption (no immediate breaks).
      thresholds: {
        lines: 60,
        functions: 55,
        branches: 70,
        statements: 60,
        // Per-directory thresholds (issue #208)
        'src/indexer/**': {
          lines: 85,
          functions: 80,
          branches: 80,
          statements: 85,
        },
        'src/auth.ts': {
          lines: 75,
          functions: 70,
          branches: 70,
          statements: 75,
        },
        'src/api/**': {
          lines: 70,
          functions: 65,
          branches: 75,
          statements: 70,
        },
      },
    },
  },
})

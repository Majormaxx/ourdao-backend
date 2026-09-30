#!/usr/bin/env bash
# scripts/load-test-stream.sh — issue #295
#
# Thin shell wrapper around scripts/load-test-stream.ts.
#
# Usage:
#   ./scripts/load-test-stream.sh                          # 1000 clients, 100 NOTIFYs
#   LOAD_CLIENTS=200 LOAD_NOTIFIES=20 ./scripts/load-test-stream.sh
#   LOAD_URL=http://staging:4000 ./scripts/load-test-stream.sh
#
# Environment variables (all optional):
#   LOAD_CLIENTS               Number of concurrent SSE clients (default 1000)
#   LOAD_NOTIFIES              Number of NOTIFY broadcasts to send (default 100)
#   LOAD_URL                   Target an already-running server instead of
#                              spinning one up in-process. When set, no
#                              NOTIFY broadcasts are issued (use the server's
#                              own indexer). DATABASE_URL is still required
#                              unless LOAD_URL is set.
#   LOAD_CONNECT_TIMEOUT_MS    Per-client connect timeout (default 10000)
#   LOAD_NOTIFY_INTERVAL_MS    Ms between NOTIFY broadcasts (default 50)
#   LOAD_DELIVERY_TIMEOUT_MS   Per-broadcast delivery window (default 5000)
#   DATABASE_URL               Postgres connection string (required for
#                              in-process mode; can also be set via PG* vars)
#
# Prerequisites:
#   • Node ≥ 20 on PATH
#   • npm install already run (tsx must be available under node_modules/.bin)
#   • A running Postgres reachable via DATABASE_URL (in-process mode only)
#
# The script exits 0 on success (all assertions passed) and 1 on any failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Resolve tsx from node_modules rather than requiring a global install.
TSX="${REPO_ROOT}/node_modules/.bin/tsx"
if [[ ! -x "${TSX}" ]]; then
  echo "[load-test-stream] ERROR: tsx not found at ${TSX}" >&2
  echo "  Run 'npm install' first." >&2
  exit 1
fi

echo "[load-test-stream] Running SSE stream load test (issue #295)..."
echo

exec "${TSX}" "${SCRIPT_DIR}/load-test-stream.ts" "$@"

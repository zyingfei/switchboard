#!/usr/bin/env bash
#
# Launch the ISOLATED test companion.
#
# It runs on a SEPARATE port and a SEPARATE vault from the daily
# companion, so a test instance can never collide with daily use:
#
#   daily companion :  port 17373   vault ~/.sidetrack-vault
#   test  companion :  port 17374   vault ~/.sidetrack-vault-test
#
# SIDETRACK_INSTANCE_LABEL=test makes /v1/version self-identify, so
# the extension's connection identity check (commit fe3dd240) flags
# it loudly if it ever answers on the daily port by mistake.
#
# The test vault is seeded ONCE as an APFS clone of the real vault
# (copy-on-write — instant, ~zero extra disk):
#
#   cp -Rc ~/.sidetrack-vault ~/.sidetrack-vault-test
#   rm -f  ~/.sidetrack-vault-test/_BAC/recall/.lock
#
# Build dist before running:
#   (cd packages/sidetrack-companion && \
#      bunx --bun --no-install tsc -p tsconfig.build.json)
#
# Override port / vault with SIDETRACK_TEST_PORT / SIDETRACK_TEST_VAULT.
set -euo pipefail

COMPANION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../packages/sidetrack-companion" && pwd)"
TEST_VAULT="${SIDETRACK_TEST_VAULT:-$HOME/.sidetrack-vault-test}"
TEST_PORT="${SIDETRACK_TEST_PORT:-17374}"

if [ ! -d "$TEST_VAULT" ]; then
  echo "test vault not found: $TEST_VAULT" >&2
  echo "seed it first:  cp -Rc ~/.sidetrack-vault \"$TEST_VAULT\" && rm -f \"$TEST_VAULT/_BAC/recall/.lock\"" >&2
  exit 1
fi

cd "$COMPANION_DIR"
# SIDETRACK_EVENT_STORE=1        — use the incremental store-backed drain path
#                                  (the efficient steady state; the legacy
#                                  full-log path shrinks the snapshot).
# SIDETRACK_CONNECTIONS_GAP_SEAL=1 — seal provably-permanent event-sequence gaps
#                                  so the frontier can't freeze (and refreeze the
#                                  whole materializer → topics). Default OFF; the
#                                  seal only fires on the store-backed path.
exec env \
  SIDETRACK_INSTANCE_LABEL=test \
  SIDETRACK_HTTP_LOG=1 \
  SIDETRACK_RECALL_PHASE_LOG=1 \
  SIDETRACK_CONNECTIONS_PHASE_LOG=1 \
  SIDETRACK_CONNECTIONS_CHILD=1 \
  SIDETRACK_EVENT_STORE=1 \
  SIDETRACK_CONNECTIONS_GAP_SEAL=1 \
  SIDETRACK_GAP_SEAL_MIN_AGING_DRAINS=1 \
  npx --yes bun@1.3.14 --smol dist/cli.js --vault "$TEST_VAULT" --port "$TEST_PORT"

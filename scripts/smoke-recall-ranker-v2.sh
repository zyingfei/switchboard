#!/usr/bin/env bash
# Phase 7 of the recall+ranker v2 hard-replacement.
# End-to-end smoke test of the new architecture against a running
# companion. Exits non-zero on any failure.
#
# Usage:
#   COMPANION_PORT=17374 \
#   COMPANION_VAULT="$HOME/.sidetrack-vault-test" \
#     scripts/smoke-recall-ranker-v2.sh
#
# Default port matches the test companion (run-test-companion.sh on
# 17374); for the primary daily-driver companion use port 17373.
# COMPANION_VAULT must point at the vault the target companion is
# serving (used only to read the bridge key from
# <vault>/_BAC/.config/bridge.key).

set -euo pipefail

PORT="${COMPANION_PORT:-17374}"
VAULT="${COMPANION_VAULT:-$HOME/.sidetrack-vault-test}"
BRIDGE_KEY_PATH="$VAULT/_BAC/.config/bridge.key"
BASE_URL="http://127.0.0.1:$PORT"

if [[ ! -f "$BRIDGE_KEY_PATH" ]]; then
  echo "smoke: bridge key not found at $BRIDGE_KEY_PATH" >&2
  echo "smoke: set COMPANION_VAULT or start the companion first" >&2
  exit 2
fi

BRIDGE_KEY=$(cat "$BRIDGE_KEY_PATH")

curl_companion() {
  local path="$1"
  shift
  curl -sS \
    -H "x-bac-bridge-key: $BRIDGE_KEY" \
    -H 'content-type: application/json' \
    "$@" \
    "$BASE_URL$path"
}

fail() {
  echo "smoke: FAIL — $1" >&2
  exit 1
}

ok() {
  echo "smoke: ok — $1"
}

echo "smoke: companion = $BASE_URL (vault = $VAULT)"

# ============================================================
# Step 1 — /v1/system/health must surface the new Phase 0/5 fields.
# ============================================================
HEALTH=$(curl_companion "/v1/system/health")

assert_field() {
  local path="$1"
  local expected="$2"
  local actual
  actual=$(echo "$HEALTH" | jq -r "$path")
  if [[ "$actual" != "$expected" ]]; then
    fail "expected $path = $expected, got $actual"
  fi
  ok "$path = $expected"
}

assert_field '.data.recall.retrievalBackend' 'v2'
assert_field '.data.recall.fusionImplementation' 'recall-v2'
assert_field '.data.recall.crossEncoder.enabled' 'true'
assert_field '.data.recall.crossEncoder.rerankTopK' '20'

# impressionLog must exist (counters may start at 0 on a fresh run)
SERVED_BEFORE=$(echo "$HEALTH" | jq -r '.data.impressionLog.servedCount // 0')
ACTION_BEFORE=$(echo "$HEALTH" | jq -r '.data.impressionLog.actionCount // 0')
echo "smoke: starting state — servedCount=$SERVED_BEFORE actionCount=$ACTION_BEFORE"

# Phase 1 invariants — must be 0 on a clean v6 system.
EXPANDED=$(echo "$HEALTH" | jq -r '.data.ranker.expandedNegativeCount // 0')
DRIFT=$(echo "$HEALTH" | jq -r '.data.ranker.labelDriftWithoutFeedback // 0')
if [[ "$EXPANDED" != "0" ]]; then
  fail "expandedNegativeCount = $EXPANDED (expected 0 after Phase 1)"
fi
if [[ "$DRIFT" != "0" ]]; then
  fail "labelDriftWithoutFeedback = $DRIFT (expected 0 after Phase 1)"
fi
ok "Phase 1 invariants: expandedNegativeCount=0 labelDriftWithoutFeedback=0"

# ============================================================
# Step 2 — /v2/recall must respond with servedContextId in meta.
# ============================================================
SMOKE_QUERY="recall ranker hard replacement smoke test query"
RECALL=$(curl_companion "/v2/recall" -X POST -d "$(jq -n --arg q "$SMOKE_QUERY" '{q:$q, limit:5, perSourceLimit:10}')")

SERVED_CONTEXT_ID=$(echo "$RECALL" | jq -r '.data.meta.servedContextId // empty')
if [[ -z "$SERVED_CONTEXT_ID" ]]; then
  fail "/v2/recall did not return meta.servedContextId"
fi
ok "/v2/recall returned servedContextId = $SERVED_CONTEXT_ID"

# Cross-encoder must have fired (default ON in Phase 5).
RERANK_ENABLED=$(echo "$RECALL" | jq -r '.data.meta.rerank.enabled // false')
if [[ "$RERANK_ENABLED" != "true" ]]; then
  # Only warn if there were 0 candidates (nothing to rerank). Otherwise fail.
  RESULT_COUNT=$(echo "$RECALL" | jq -r '.data.results | length')
  if [[ "$RESULT_COUNT" == "0" ]]; then
    echo "smoke: warn — 0 candidates so rerank didn't fire (this is fine)"
  else
    fail "rerank.enabled = $RERANK_ENABLED with $RESULT_COUNT candidates"
  fi
else
  RERANKED=$(echo "$RECALL" | jq -r '.data.meta.rerank.rerankedCount')
  LATENCY=$(echo "$RECALL" | jq -r '.data.meta.rerank.latencyMs')
  ok "cross-encoder fired: rerankedCount=$RERANKED latencyMs=$LATENCY"
fi

# ============================================================
# Step 3 — /v1/recall/action must accept a click on a served candidate.
# ============================================================
FIRST_ENTITY=$(echo "$RECALL" | jq -r '.data.results[0].entityId // empty')
if [[ -z "$FIRST_ENTITY" ]]; then
  echo "smoke: warn — no results to act on; skipping recall.action test"
else
  IDEMPOTENCY_KEY="smoke-$(date +%s)-$RANDOM"
  ACTION_RESP=$(curl_companion "/v1/recall/action" \
    -X POST \
    -H "idempotency-key: $IDEMPOTENCY_KEY" \
    -d "$(jq -n \
      --arg sid "$SERVED_CONTEXT_ID" \
      --arg eid "$FIRST_ENTITY" \
      --arg at "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
      '{payloadVersion:1, servedContextId:$sid, entityId:$eid, actionKind:"click", actionAt:$at}')")
  ACCEPTED=$(echo "$ACTION_RESP" | jq -r '.data.accepted // false')
  if [[ "$ACCEPTED" != "true" ]]; then
    fail "/v1/recall/action did not accept: $ACTION_RESP"
  fi
  ok "/v1/recall/action accepted click on $FIRST_ENTITY"
fi

# ============================================================
# Step 4 — re-poll health and confirm impression counters advanced.
# ============================================================
HEALTH_AFTER=$(curl_companion "/v1/system/health")
SERVED_AFTER=$(echo "$HEALTH_AFTER" | jq -r '.data.impressionLog.servedCount // 0')
ACTION_AFTER=$(echo "$HEALTH_AFTER" | jq -r '.data.impressionLog.actionCount // 0')
if [[ "$SERVED_AFTER" -le "$SERVED_BEFORE" ]]; then
  fail "servedCount did not advance: $SERVED_BEFORE → $SERVED_AFTER"
fi
ok "servedCount advanced: $SERVED_BEFORE → $SERVED_AFTER"

if [[ -n "$FIRST_ENTITY" ]] && [[ "$ACTION_AFTER" -le "$ACTION_BEFORE" ]]; then
  fail "actionCount did not advance after click: $ACTION_BEFORE → $ACTION_AFTER"
fi
if [[ -n "$FIRST_ENTITY" ]]; then
  ok "actionCount advanced: $ACTION_BEFORE → $ACTION_AFTER"
fi

# actionsByKind should show 'click' tallied
CLICK_COUNT=$(echo "$HEALTH_AFTER" | jq -r '.data.impressionLog.actionsByKind.click // 0')
if [[ -n "$FIRST_ENTITY" ]] && [[ "$CLICK_COUNT" == "0" ]]; then
  fail "actionsByKind.click = 0 after recording a click"
fi
if [[ -n "$FIRST_ENTITY" ]]; then
  ok "actionsByKind.click = $CLICK_COUNT"
fi

echo "smoke: PASS — Phase 7 dogfood smoke ($SERVED_AFTER served, $ACTION_AFTER actions)"

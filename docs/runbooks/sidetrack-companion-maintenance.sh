#!/bin/bash
# Nightly Sidetrack maintenance — launchd: com.sidetrack.companion-maintenance
# (runs 04:30 daily; created 2026-08-14).
#
# Why this exists (measured, not guessed):
# 1. The companion's true footprint (top MEM, not ps rss) ratchets to ~8 GB
#    and swap exhausts; /v2/recall degrades from ~1-2s to 5-10s avg within
#    1-2 days of a boot (HTTP-log archaeology, Jul 28-Aug 12). A restart
#    resets the allocator high-water mark. -> Restart when footprint or
#    uptime crosses a threshold.
# 2. Orphan generation dbs + legacy artifacts accumulate; the in-process
#    survey is deliberately report-only, and the proof-gated collector
#    (`gc --storage-retirement`) had no operational cadence. -> Run it
#    nightly: dry-run, then apply the SAME plan id. Apply revalidates every
#    proof and fails closed on any drift, so scripting the pair keeps the
#    designed safety.
# 3. Two unbounded-growth leftovers: the SIDETRACK_HTTP_LOG debug-log pair
#    in /tmp lingers forever once the flag is disabled, and background
#    lanes can leave non-canonical work dirs under the vaults' _BAC/log.
#    -> Age out the /tmp pair (safe); for _BAC/log only REPORT candidates
#    (replica dirs are canonical event data — never delete unattended).
#
# The real fix for (1) is the columnar event tier; this script is the
# containment until that ships.
#
# 4. engagement.interval.observed is ~76% of the canonical JSONL log by line
#    count (Task F1, 2026-08-15) and grows forever. src/gc/compactionPlanner.ts
#    already implements a proof-gated compaction (drops intervals whose visit
#    has a durable engagement.session.aggregated, from sealed shards past
#    retention) with a `compact-engagement` CLI entry point, but nothing ran
#    it. Section 5 below is a nightly REPORT-ONLY survey (plan only, never
#    applies) so the reclaimable-bytes trend is visible before anyone opts
#    into --apply. See docs/runbooks/ (this file) §5 for the sync note.
#
# 5. F2 (Task, 2026-08-16): once a day's events are sealed into the columnar
#    tier (src/analytics/eventSeal.ts) and verify-green, the hot-tail JSONL
#    shard for that day no longer needs to be read/rewritten — but APPLYing
#    that retirement is gated on a soak period (~2026-08-21) and explicit
#    consent, not scripted here. Section 6 below is the nightly REPORT-ONLY
#    eligibility survey (`retire-hot-tail --report`, zero writes — the
#    event-store mirror it reads is opened `{ readonly: true }`), appended to
#    a bounded (last-30) JSONL history under each vault's _BAC/system/ so the
#    trend is visible before APPLY exists.

# *** NOT YET SYNCED to ~/.sidetrack-companion-maintenance.sh — §5 (Task F1,
# *** 2026-08-15) and §6 (Task F2, 2026-08-16) below are new. The coordinator
# *** must copy the new sections into the live launchd script; nothing
# *** outside this repo checkout runs them yet.

LOG="$HOME/.sidetrack-maintenance.log"
exec >>"$LOG" 2>&1
if [ -f "$LOG" ] && [ "$(wc -c <"$LOG" | tr -d ' ')" -gt 1000000 ]; then
  tail -c 200000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
echo "=== $(date -u +%FT%TZ) maintenance start"

COMPANION_DIR="/Users/yingfei/playground/playground/browser-ai-companion/packages/sidetrack-companion"
LAUNCHER="$HOME/.sidetrack-daily-companion-launcher.sh"
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$COMPANION_DIR" || { echo "companion dir missing"; exit 1; }

MEM_LIMIT_MB=3000
MAX_UPTIME_DAYS=2

# --- 1. Restart decision for the daily companion (:17373) ------------------
PID="$(lsof -iTCP:17373 -sTCP:LISTEN -t 2>/dev/null | head -1)"
RESTART=""
if [ -z "$PID" ]; then
  RESTART="not running"
else
  # top MEM = resident+compressed, the honest footprint (ps rss lies once
  # the compressor kicks in). Value like "489M" / "7820M" / "1G".
  MEM_RAW="$(top -l 1 -pid "$PID" -stats mem 2>/dev/null | tail -1 | tr -d ' ')"
  MEM_MB=0
  case "$MEM_RAW" in
    *G) MEM_MB=$(( ${MEM_RAW%G} * 1024 )) ;;
    *M) MEM_MB=${MEM_RAW%M} ;;
    *K) MEM_MB=1 ;;
  esac
  ETIME="$(ps -o etime= -p "$PID" | tr -d ' ')"
  DAYS=0
  case "$ETIME" in *-*) DAYS=${ETIME%%-*} ;; esac
  echo "daily pid=$PID mem=${MEM_MB}M uptime_days=$DAYS"
  if [ "$MEM_MB" -gt "$MEM_LIMIT_MB" ]; then RESTART="mem ${MEM_MB}M > ${MEM_LIMIT_MB}M"; fi
  if [ "$DAYS" -ge "$MAX_UPTIME_DAYS" ]; then RESTART="${RESTART:+$RESTART, }uptime ${DAYS}d >= ${MAX_UPTIME_DAYS}d"; fi
fi

if [ -n "$RESTART" ]; then
  echo "restarting daily companion: $RESTART"
  screen -S sidetrack-companion-main -X quit 2>/dev/null
  if [ -n "$PID" ]; then
    pkill -9 -P "$PID" 2>/dev/null
    kill -9 "$PID" 2>/dev/null
  fi
  pkill -9 -f 'vault --port 17373' 2>/dev/null
  sleep 5
  screen -wipe >/dev/null 2>&1
  screen -dmS sidetrack-companion-main zsh "$LAUNCHER"
  sleep 15
  VERSION="$(curl -s -m 10 http://127.0.0.1:17373/v1/version)"
  case "$VERSION" in
    *buildSha*) echo "restart OK: $(echo "$VERSION" | head -c 240)" ;;
    *) echo "RESTART FAILED — no /v1/version response; check /tmp/sidetrack-daily-companion.log" ;;
  esac
else
  echo "no restart needed"
fi

# --- 2. Proof-gated storage-retirement GC ----------------------------------
for VAULT in "$HOME/.sidetrack-vault" "$HOME/.sidetrack-vault-test"; do
  [ -d "$VAULT" ] || continue
  DRY="$(bun dist/cli.js gc --vault "$VAULT" --storage-retirement --dry-run 2>/dev/null | grep 'storage-retirement dry-run')"
  echo "$VAULT: $DRY"
  PLAN_ID="$(echo "$DRY" | sed -n 's/.*plan \([0-9a-f]\{64\}\).*/\1/p')"
  VERIFIED="$(echo "$DRY" | sed -n 's/.*plan [0-9a-f]*, \([0-9]*\) verified.*/\1/p')"
  if [ -n "$PLAN_ID" ] && [ -n "$VERIFIED" ] && [ "$VERIFIED" -gt 0 ]; then
    echo "$VAULT: applying plan $PLAN_ID ($VERIFIED verified candidates)"
    bun dist/cli.js gc --vault "$VAULT" --storage-retirement --apply --plan-id "$PLAN_ID" 2>&1 | tail -3
  fi
done

# --- 3. /tmp HTTP-debug-log age-out ----------------------------------------
# SIDETRACK_HTTP_LOG=1 writes /tmp/sidetrack-http-debug.log and rotates it
# to a single .1 — bounded while enabled, but nothing cleans the pair once
# the flag is turned off. Delete either file untouched for 14 days.
for F in /tmp/sidetrack-http-debug.log /tmp/sidetrack-http-debug.log.1; do
  if [ -f "$F" ] && [ -n "$(find "$F" -mtime +14 -print 2>/dev/null)" ]; then
    echo "deleting stale debug log: $F ($(stat -f '%z bytes, mtime %Sm' "$F"))"
    rm -f "$F"
  fi
done

# --- 4. Vault _BAC/log stale-dir survey (REPORT-ONLY) -----------------------
# _BAC/log/<replicaId>/<YYYY-MM-DD>.jsonl is CANONICAL event data
# (eventLog.ts) — this script must never delete replica dirs. A dir with
# NO dated .jsonl files that has been untouched for >30 days is a
# non-canonical leftover (e.g. an abandoned lane work dir). Report only:
# deleting from an unattended script needs a supervised pass first.
# Survey 2026-08-14: all ~90 UUID dirs in both vaults DO contain dated
# .jsonl (they are tiny May-11..13 session replicas, canonical) -> zero
# candidates today; this section exists to catch future leftovers.
STALE_DIR_DAYS=30
for VAULT in "$HOME/.sidetrack-vault" "$HOME/.sidetrack-vault-test"; do
  LOGDIR="$VAULT/_BAC/log"
  [ -d "$LOGDIR" ] || continue
  echo "$LOGDIR: stale-log-dir candidates (report-only; delete manually after review)"
  CAND=0
  SHOWN=0
  for D in "$LOGDIR"/*/; do
    [ -d "$D" ] || continue
    # any top-level YYYY-MM-DD.jsonl -> canonical replica dir, skip
    if [ -n "$(find "$D" -maxdepth 1 -name '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].jsonl' -print -quit 2>/dev/null)" ]; then
      continue
    fi
    # dir itself touched within the window -> not stale yet, skip
    if [ -z "$(find "$D" -maxdepth 0 -mtime "+$STALE_DIR_DAYS" -print 2>/dev/null)" ]; then
      continue
    fi
    CAND=$((CAND + 1))
    if [ "$SHOWN" -lt 20 ]; then
      SHOWN=$((SHOWN + 1))
      echo "  candidate: ${D%/} size=$(du -sk "$D" 2>/dev/null | cut -f1)K mtime=$(stat -f '%Sm' -t '%F' "$D") why=no-dated-jsonl,idle>${STALE_DIR_DAYS}d"
    fi
  done
  if [ "$CAND" -gt "$SHOWN" ]; then
    echo "  ... $((CAND - SHOWN)) more not shown (capped at 20)"
  fi
  echo "$LOGDIR: $CAND stale-log-dir candidate(s)"
done

# --- 5. Engagement-interval compaction survey (REPORT-ONLY) -----------------
# *** NEW — Task F1 (2026-08-15). Not yet in the live launchd script; the
# *** coordinator syncs this block into ~/.sidetrack-companion-maintenance.sh.
#
# engagement.interval.observed is ~76% of the canonical log by line count and
# grows forever (measured on this vault: 673MB total, 439MB/65% reclaimable
# once outside the 30-day retention window). src/gc/compactionPlanner.ts
# implements the proof-gated rewrite (aggregate coverage, dense-sequence
# reconciliation, crash-recoverable receipts, no force path); `compact-engagement`
# is its CLI entry point (src/cli.ts). This survey ONLY plans and prints —
# `compact-engagement` with no --apply never touches disk, so it's safe to run
# nightly against a vault a live companion is also serving.
#
# Turning this into an APPLY pass is a deliberate, separate decision: it needs
# (a) SIDETRACK_ENGAGEMENT_COMPACT=1 exported for this script (the planner's
# own arm switch) AND (b) `--apply` added to the command below, AND (c) it
# will refuse by itself if a live companion holds the vault's recall
# process-lock (compaction is a second writer; EventLog.runExclusiveMaintenance
# only serialises writers within one process, so a live companion's in-memory
# append indexes / merged-log memo in ANOTHER process can't be invalidated by
# this script's rewrite — the lock is the cross-process guard for that). Do
# not add --apply here without a supervised pass first.
for VAULT in "$HOME/.sidetrack-vault" "$HOME/.sidetrack-vault-test"; do
  [ -d "$VAULT" ] || continue
  echo "$VAULT: engagement-interval compaction survey (report-only)"
  bun dist/cli.js compact-engagement --vault "$VAULT" 2>&1 | sed 's/^/  /'
done

# --- 6. F2 hot-tail retirement eligibility report (REPORT-ONLY) -------------
# *** NEW — Task F2 (2026-08-16). Not yet in the live launchd script; the
# *** coordinator syncs this block into ~/.sidetrack-companion-maintenance.sh.
#
# `retire-hot-tail --report` (src/cli.ts) computes, per (replica, day)
# hot-tail JSONL shard: events sealed vs unsealed, hot-tail bytes retirable
# once APPLY ships, and the seal-coverage verdict (reusing the columnar
# tier's DuckDB-over-Parquet integrity check, src/analytics/eventScan.ts).
# ZERO writes — the event-store mirror it reads is opened `{ readonly: true }`
# (never created, never caught up), so this is safe to run nightly against a
# vault a live companion is also serving, same as §5 above. There is no
# --apply yet: retiring the hot tail is a separate, consent-gated follow-up
# behind the seal soak period (~2026-08-21) — do not wire one here without a
# supervised pass first.
#
# Each run appends one JSON line to _BAC/system/retirement-reports.jsonl —
# diagnostic history, not a growing log — bounded to the last 30 reports
# (older lines pruned in the SAME run, right after the append).
RETIREMENT_REPORT_RETAIN=30
for VAULT in "$HOME/.sidetrack-vault" "$HOME/.sidetrack-vault-test"; do
  [ -d "$VAULT" ] || continue
  echo "$VAULT: hot-tail retirement eligibility report (report-only)"
  # Human-readable summary in the maintenance log.
  bun dist/cli.js retire-hot-tail --report --vault "$VAULT" 2>&1 | sed 's/^/  /'
  # Machine-readable history: one compact JSON line appended per run.
  REPORT_DIR="$VAULT/_BAC/system"
  mkdir -p "$REPORT_DIR"
  REPORT_FILE="$REPORT_DIR/retirement-reports.jsonl"
  bun dist/cli.js retire-hot-tail --report --vault "$VAULT" --json 2>/dev/null >> "$REPORT_FILE"
  if [ -f "$REPORT_FILE" ]; then
    tail -n "$RETIREMENT_REPORT_RETAIN" "$REPORT_FILE" > "$REPORT_FILE.tmp" \
      && mv "$REPORT_FILE.tmp" "$REPORT_FILE"
  fi
done

echo "=== $(date -u +%FT%TZ) maintenance done"

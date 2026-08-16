# Foundation program — goals, principles, final validation plan

Status: ACTIVE. Owner: coordinator session (Claude) + user (zyingfei).
Started 2026-08-15. This document is the durable source of truth for the
program — conversation context may be compacted; this file may not drift
from reality without being updated in the same PR that changes reality.

## Principles (bind every item)

1. **Don't reinvent wheels.** Before building anything, inventory what
   exists (F1's entire win was wiring machinery that had zero callers).
   An agent that starts writing a new subsystem without an inventory
   step has failed the brief.
2. **Every fix is persistent.** A fix counts only when it is (a) merged
   to main, (b) deployed from a built dist, and (c) any operational
   piece (schedules, launchers, env) lives in versioned files
   (docs/runbooks/*, launchers in $HOME synced from them) — never only
   in a running process or a conversation.
3. **Evidence before conclusions.** Reproduce or measure first; phase
   marks/probes over theories. Retract premises when data disagrees.
4. **User-felt acceptance tests.** Mechanism-level verification is not
   outcome verification. Each item defines the user-observable test up
   front; the coordinator (not the implementing agent) runs it.
5. **One verified change in flight per subsystem.** Ladder: Sonnet
   implements → Opus on failure → coordinator verifies end result.
6. **Rank fixes: unconsulted signals → simple statistics → model
   changes last.** (Not everything is an LLM.)
7. **Lossless by construction.** Canonical-log rewrites only through
   proof-gated machinery; deferrals must carry a reconcile step;
   "conservative" guards may not create livelocks (defer + reconcile,
   never throw-per-chunk).

## Goal register

| ID | Goal | Acceptance (coordinator-verified) | State (2026-08-15) |
|----|------|------------------------------------|--------------------|
| F1 | Engagement compaction runs | Report-only numbers reproduced (done: 439.7MB = 65.3% of 672.8MB reclaimable, 0 uncovered visits); gated `--apply` on test vault shrinks log with post-apply equivalence (event counts, serving probes); nightly report-only scheduled via runbook → live script | CLI + schedule merged-pending (PR #361); apply scheduled idle window |
| F2 | JSONL hot-tail retirement | Report-only enumeration with per-day seal proofs; destructive apply behind flag + soak (~Aug 21); one-command flip documented | Pending (after F1 apply) |
| F3 | No full-log walks on hot paths | Survey complete (see below); foreground-nav overlay migrated to typed reads with equivalence test; phase-log shows no full-log walk during a normal drain + nav burst | Survey done; overlay migration in progress |
| F4 | Blob diet | Accumulator blob + append-index snapshot off pretty JSON (CBOR/compact or incremental); snapshot load <1s (baseline 2.5s); measured before/after | Pending (after F1–F3) |
| F5 | Small-file stores → SQLite | page-content (703 files) + page-evidence (3,741 files) each one SQLite; one transaction per capture; #356/#357 manifest upserts deleted as obsolete; migration + rollback documented | Pending |
| F6 | Leftover bugs | Evidence-manifest staleness on lane writes fixed (done, verified 60/60); AttributionProvenance fallback honesty (done, verified 56/56) | Merged-pending (PR #361) |
| F7 | Top-K similarity flake dead | Root cause with deterministic repro; fix; 200 consecutive green runs | Agent running |

F3 survey highlights (full table in the session transcript; key durable facts):
- Dogfood launchers run SIDETRACK_EVENT_STORE=1 — typed paths are live
  for us; store-off fallbacks matter for default installs.
- Hot walker with NO typed path: foreground-navigation overlay
  (connectionsMaterializer ~7398) — full readMerged per foreground nav.
- `computeSealedIntervals` (gap seal) must NEVER be narrowed to typed
  reads — a typed read could falsely prove absence and permanently seal
  a real gap. Migration means changing what callers pass, not the fn.
- Strategic follow-up: consider SIDETRACK_EVENT_STORE default-ON — the
  "net-negative" measurement predates forEachChunkOfTypes/serve-stale.

## Final validation plan (program exit criteria)

Run after F1–F7 all land, on the TEST companion first, then daily:

1. **Capture latency**: acceptance sampler (60s cadence, 2h window,
   during an induced catch-up): p95 < 3s, max < 15s, zero BANNER lines.
   Real-UI check: 3 CDP-driven "Index page" clicks < 5s each, no banner.
2. **Boot**: restart companion; first capture < 5s; append-index
   snapshot loads (<1s target post-F4); no >15s request in the first
   10 minutes (the old warm-wedge window).
3. **Storage**: canonical log ≤ ~240MB post-compaction and stays flat
   week-over-week (compaction scheduled); `du` deltas recorded in the
   maintenance log; event-store + seal + snapshot artifacts each
   justified (no data stored >2× without a listed reason).
4. **No full-log walks**: SIDETRACK_CONNECTIONS_PHASE_LOG=1 through one
   normal drain + one nav burst + one /v1/system/health poll cycle:
   zero readMerged marks on those paths (allowed: cold boot recovery,
   gap seal, CLI/eval).
5. **Determinism**: F7 test 200× green; visitSimilarity suites 20× green.
6. **Honesty UI**: held fusion shows "No good guess yet" (badge, stats,
   provenance); Page text never shows 'metadata only' for unfetched
   coverage (shows 'checking…' then resolves).
7. **Drain hygiene**: induced 20k-event backlog drains with chunk
   pacing; captures during drain stay under banner; forced
   membership-reconcile runs exactly once; health lastError surfaces
   any failure audibly (console.warn present in log on any injected
   failure).
8. **Persistence audit**: every operational piece diffed against its
   versioned source (live maintenance script == docs/runbooks copy;
   launchers reference committed dist; no orphan /tmp scripts). Daily
   + test companions both on the same main-tip build.

Record results in docs/audits/<date>-foundation-validation.md.

## F5 design note (2026-08-16)

Binding user rule: document the store choice before writing code.
Workload: per-capture small-doc KV writes (page-content record + raw
text + chunks; page-evidence record), point reads by canonical URL /
content hash, aggregate "manifest" counts (byState/byTier), and an FTS
hook later (lexical index already exists in-process via MiniSearch —
SQLite FTS5 is the natural next home for it).

| Candidate | Fit for THIS workload |
|---|---|
| Bespoke SQLite tables (bun:sqlite) | Matches the vault-wide standard already proven in 12+ stores (engagementFactsStore, captureTextFtsStore, recall-v2, connections/snapshot.ts) — same WAL + busy_timeout + atomic-rename crash-safety patterns, zero new runtime, FTS5 virtual tables are a same-engine follow-up. |
| chDB (embedded ClickHouse) | Columnar OLAP engine built for scan-heavy analytical queries over large batches; no maintained Bun-native binding in this stack; would add a second storage runtime with its own crash-safety/WAL surface to audit for a workload that is single-row upserts, not analytical scans. |
| DuckDB (embedded) | Same shape mismatch as chDB — excellent for the F2 columnar/analytics lanes (bulk aggregation over sealed history), but its write path is optimized for batch ingestion, not one-row-per-capture upserts; a second embedded-db handle alongside bun:sqlite duplicates crash-recovery work for no workload benefit here. |
| Workload shape | Point KV writes/reads keyed by canonical URL / content hash + small aggregate counts — squarely SQLite's OLTP sweet spot, not an OLAP engine's. |
| Verdict | Bespoke SQLite tables under bun:sqlite, one file each for page-content and page-evidence. DuckDB/chDB remain live candidates for F2's analytics lanes, not the durable store here. |

## Idle-window checklist (next window, ~04:30 or user-idle)

1. Sync ~/.sidetrack-companion-maintenance.sh from docs/runbooks copy.
2. Stop test companion → `compact-engagement --apply` (env-armed) →
   verify counts + restart → serving probes green.
3. Roll daily companion to main-tip build (one restart; snapshot warm
   makes it cheap).
4. Kick a fresh acceptance-sampler window; record numbers here.

## Landing notes (current state, dated)

**2026-08-16 — resolver hub-subgraph traversal budgets
(perf/resolver-subgraph-budget).** Not an F1–F7 item; filed here per the
"binding plan tracks reality" rule since it hit the same measured symptom
(15s/30s busy-banner class) via a different chokepoint. Root cause:
`#readTraversedSubgraphInner` (connections/snapshot.ts) was an unbounded
BFS with no node/edge ceiling and no per-node fan-out cap — one hub URL
(e.g. an aggregator front page with thousands of inbound links) pulled
2,800 nodes / 46,565 edges into a single synchronous bun:sqlite tick
(5,266ms measured), holding `POST /v1/visits/batch-resolve` and every
other request behind it. Fix: three independent env-gated budgets, all
`0 = unlimited` (kill switch, restores prior unbounded behavior per
knob):
- `SIDETRACK_RESOLVER_SUBGRAPH_NODE_BUDGET` (default `1200`)
- `SIDETRACK_RESOLVER_SUBGRAPH_EDGE_BUDGET` (default `4000`)
- `SIDETRACK_RESOLVER_HUB_DEGREE_CAP` (default `400`) — a frontier node
  whose incident-edge count exceeds the cap is read (capped, included)
  but not expanded through.

Plus: yields threaded through the traversal (setImmediate-based,
between hop levels / chunked reads), `buildEvidenceGraph` memoized per
snapshot object identity (one graph build per batch instead of one per
miss URL), and the attribution reverse-shadow incumbent re-run deferred
off the serve path (`attribution-v1/reverseShadowDefer.ts`, mirrors
`http/resolverCacheDefer.ts`). Truncation is deterministic and reported
via `ConnectionsSnapshot.truncated` + a throttled
`[resolver.subgraph.truncated]` log line for soak observability.

# F8 designs — finish the IVM, demote full rebuild to an offline tool

Source: F8 survey+design agent (2026-08-16), reviewed and amended by the
coordinator. Evidence citations (file:line) are in the agent transcript;
the load-bearing ones are restated here. Companion doc:
2026-08-15-foundation-program.md (goal register).

## Review verdict

APPROVED with two amendments (below). Implementation in four waves,
Sonnet-first, coordinator verifies each wave against its equivalence
test before merge.

## Root causes (verified)

1. **Membership bail** = CRDT register resolved over a truncated window:
   `thread_in_workstream` derives from `projectThread(mergeRegister(...))`
   over `input.events`; a scoped window carries incomplete register
   history, so the resolved value differs from truth regardless of real
   changes. KEY FACT: `thread_in_workstream` has NO cross-thread
   consumer (topic_in_workstream derives from visit attribution, not
   thread membership) — a correct register makes recompute row-local.
2. **Search bail** = two corpus-joins with no index:
   `thread_text_mentions_search_query` (query × all capture/dispatch/
   annotation text) and `same_search_query` ranker candidates (query ×
   all visits). `closest_visit` carry-forward already preserves OLD
   pairs on scoped drains; only NEW-pair minting is missing.
3. **workstreamTree** invalidation = unconditional full rebuild on any
   workstream CRUD; rare but unmitigated. `workstreamPathMemo` is
   aspirational naming with no backing table.

## Waves

W1 — thread register store (kills the membership bail class):
  `_BAC/connections/thread-register-facts.db`, table
  `thread_register_state(bac_id PK, candidates_json, status_json,
  deleted)` + per-replica `ingest_watermark` — REUSE timeline-facts.db's
  watermark/catchUp lifecycle, but store RESOLVED register state (the
  edges_index materialized-index pattern), not raw facts. Fold via the
  SAME `mergeRegister` projection.ts uses. Drain: read register, if
  membership changed push the thread scope into rowLocalScopes (existing
  recomputeScope path). `threadDeltaFullBuildReason` is demoted to an
  offline consistency check. Register under the connections-sidecar-dbs
  GC family. Equivalence: multi-replica out-of-order conflicting
  THREAD_UPSERTED across chunk boundaries; incremental register ==
  projectThread(full log) at every watermark; thread_in_workstream edge
  set byte-identical incremental vs full for reparent/archive/revive.

W2 — search-visit incremental join (kills the search bail class):
  sidecar `search_query_index(query_key, visit_key, observed_at)` (the
  edges_index trigger idiom) + `capture_text_fts` FTS5 over capture/
  dispatch/annotation text (the docs_fts idiom, recall-v2 sqlite store).
  On a new search visit: select same-query visits from the index (feeds
  the existing same_search_query→closest_visit path) + FTS match for
  thread_text_mentions_search_query; also the reverse join (new capture
  text × existing queries). AMENDMENT 1: the equivalence test MUST pin
  tokenizer parity — FTS5's tokenizer vs the current JS whole-word
  matcher (unicode, punctuation, case). If FTS5 cannot reproduce the JS
  semantics exactly, put the candidate set through the JS matcher as a
  post-filter (FTS as recall-only prefilter) so edges stay
  byte-identical.

W3 — demotion (all remaining bails → repair queue):
  Every remaining skip branch: progress-only write (existing pattern) +
  mark `scopedTimelineDelta.demoted reason=` + enqueue {scope, reason,
  dot} in a persisted repair-queue table. AMENDMENT 2: no new worker
  process — the repair queue is drained BY THE EXISTING reconcile child
  at the start of each drain (bounded N scopes/drain through
  recomputeScope/replaceScopeRows), preserving the single-writer
  invariant and sidestepping the flagged locking question entirely.
  Full rebuild becomes offline-only: `connections rebuild` /
  `connections verify` CLI (audit = diff full vs served, alert on
  divergence; recovery keeps the existing Layer-0
  similarityRecoveryNeedsBaseRebuild path untouched). Health gains
  repairQueueDepth so backlog is visible (never silent-stale).

W4 — workstreamTree subtree scoping: materialize
  `workstream_parent(bac_id, parent_id)`; a CRUD invalidates only the
  affected subtree's workstream+thread scopes via bounded walk.

## Interim state (already live)

The hot-rebuild suppressor (#364) caps ALL bail classes at one healing
rebuild per SIDETRACK_FULL_REBUILD_COOLDOWN_MS (dogfood 6h) with a
sticky heal; boot inherits the on-disk snapshot as recently-built; the
child is CPU-reniced (#354) and I/O-throttled (#363). The suppressor is
deleted by W3 (demotion supersedes it).

## Exit criteria (feeds the program's final validation)

Steady-state week: zero `buildConnectionsSnapshot base` marks outside
boot-cold-start/recovery/CLI; repairQueueDepth returns to 0 within one
drain cycle of any enqueue; equivalence suites green in CI.

## W5 — incremental topics (added 2026-08-16, user directive: no global recompute anywhere)

Replace the scheduled global leiden-cpm recompute with a fully
incremental producer:
1. Assignment: the existing incremental topic-membership overlay
   (flag-off today) attaches new visits to existing topics via
   similarity neighbors — flip on as the primary path.
2. Structure: local refinement only — on edge/neighborhood change,
   re-run community optimization on the BOUNDED perturbed subgraph
   (affected topic ∪ boundary; DynaMo-style local Leiden). Splits and
   merges emerge locally; a per-topic modularity-degradation trigger
   bounds quality drift. The global pass is removed from every
   scheduled path.
3. Inventory to reuse before building: the overlay, hot-topics/hdbscan
   dormant candidates, churnP90 metric (acceptance metric: incremental
   must not exceed the cadence producer's churn), retired union-find's
   incremental component substrate.
4. Audits: SAMPLED — random bounded subgraphs recomputed from stores
   and diffed; per-scope checksums. No full-graph audit.

## Binding rule (supersedes W3's audit clause)

NO operational or scheduled path may construct any artifact by reading
the log (or store) from the beginning. Full replay survives in exactly
one place: catastrophic-loss disaster recovery (`connections rebuild`
CLI), which nothing schedules. W3's offline audit becomes the sampled
audit of W5.4. Fact-store `rebuildFromJsonl`-style functions are
recovery-only.

## Recovery consent rule (added 2026-08-16, user directive)

Catastrophic-loss recovery is USER-INITIATED, never automatic. When the
system detects a condition whose only remedy is a full replay/rebuild
(missing/corrupt generation with no successor, lost fact stores on a
non-empty vault, Layer-0 similarity corruption, materializer version
bump on a large vault):
1. DO NOT run the rebuild. Serve degraded (whatever stores remain,
   serve-stale doctrine) and mark the affected surfaces honestly.
2. Surface the condition: health tier 'needs-repair' + a side-panel
   callout naming the exact command to run
   (`sidetrack-companion connections rebuild --vault <path>`), reusing
   the existing health/callout surfaces — no new UI concepts.
3. The CLI performs the replay with a progress report and the same
   process-lock discipline as compact-engagement (refuses a live
   companion; the callout tells the user to quit the companion first or
   the CLI offers --stop-companion).
Exemption: a genuinely EMPTY/fresh vault (no prior generations, log
below a small threshold) may build automatically — first-run setup is
not recovery. Materializer version bumps on a large vault prompt too:
an upgrade may not silently rewrite hundreds of MB.
W3 owns implementing the detection→degrade→callout path and removing
every auto-invocation of full rebuilds from recovery branches.

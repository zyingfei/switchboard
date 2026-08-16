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
| F3 | No full-log walks on hot paths | Survey complete (see below); foreground-nav overlay migrated to typed reads with equivalence test; phase-log shows no full-log walk during a normal drain + nav burst | Overlay migration done; remaining hot readMerged callers (health/§15/ingestor/retrain-worker) migrated + equivalence-tested (PR TBD, 2026-08-16); default-ON flip evaluated and NOT shipped (test-fixture blocker, see landing note) |
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

**2026-08-16 — F3 residual readMerged callers migrated; default-ON flip
evaluated and NOT shipped (perf/f3-store-off-readmerged).** Closes the F3
survey's remaining named callers (`connectionsMaterializer.ts`'s
foreground-nav overlay, done earlier, is out of scope here and untouched).

*Migrated / verified (all already degrade to the typed store when
`SIDETRACK_EVENT_STORE=1`, and now carry an equivalence test proving the
store-backed and readMerged-backed results are identical on a synthetic
fixture):*
- `system/workGraphHealth.ts:353` (`readEventsForHealth`, feeding
  `readFeedbackEvents` at :375 and the recall.served/action read at
  :1322) — was already store-aware; added
  `system/workGraphHealth.test.ts`'s "F3: readFeedbackEvents is
  store/readMerged equivalent".
- `system/section15Collector.ts:36` (`readSection15Events`) — was
  already store-aware; added `system/section15Collector.test.ts`'s "F3:
  readSection15Events is store/readMerged equivalent".
- `recall/ingestor.ts:142-143` (`ingestIncremental`'s fresh-events +
  tombstone-scan branches) — was already store-aware; added
  `recall/ingestor.test.ts`'s "F3: ingestIncremental is store/readMerged
  equivalent".
- `ranker/retrain.worker.ts:72` — genuinely NOT store-aware before this
  PR (unconditional `eventLog.readMerged()`). New
  `ranker/retrain.ts:1268` `readRetrainEventSources(vaultRoot, eventLog)`
  factors the sourcing out of the worker (worker-thread code is hard to
  unit-test directly) and gives it two fields: `readTrainingEvents`
  (narrow trainable-types subset — indexed `forEachChunkOfTypes` when the
  store is on, the existing O(labels)
  `trainableEventsShard.ts:readTrainableEventsFromShard` when it's off —
  never `readMerged()`, on OR off) and `merged` (full history, no narrow
  index exists for the legacy candidate-generation fallback's broad event
  types — full ordered `store.forEachChunk` when the store is on,
  `eventLog.readMerged()` only when it's off). Equivalence test:
  `ranker/retrain.test.ts`'s "F3 — readRetrainEventSources" describe
  block.

*Default-ON flip: evaluated, NOT shipped.* The code side is ready — every
caller above (plus `attribution-v1/artifact.ts`'s
`readAttributionV1SourceEvents`, discovered during this evaluation) already
falls back correctly when the store is off, and both live companions have
run `SIDETRACK_EVENT_STORE=1` for days with no regression. But flipping the
process default on this branch and running the full `bun test` suite (356
files) turned **67 assertions across 19 files red** — concentrated in
`sync/contract/connectionsMaterializer.*.test.ts` +
`connectionsHnswReconcileIntegration.test.ts` (29 of the 67), a file this
PR is scoped not to touch. Root cause, confirmed by `git stash` isolating
the one-line flag change and turning the same failures green: a repeated
test-fixture shape — a real `mkdtemp` vaultRoot paired with a STUB
`EventLog` (only `readMerged`/`streamFiltered` implemented) on the
assumption "the store path is unused for a bare vault root" (verbatim,
`attribution-v1/armedResolve.test.ts`), true only while the store defaults
off. With it on, `getCaughtUpSharedEventStore` opens a REAL empty sqlite
store against that real temp dir instead of no-op'ing, and typed readers
silently read the empty store instead of the seeded stub. Fixing this
needs either a way to stub the shared event store itself (not just
`EventLog`) or an audit pinning `SIDETRACK_EVENT_STORE=0` on every affected
fixture — real work, out of scope for a readMerged-migration PR, and
partly inside the frozen `connectionsMaterializer.ts` test ecosystem.
`eventStoreEnabled()` stays opt-in (`=== '1'`); the doc comment in
`sync/eventStore.ts` and the `sync/lineage.ts` `event-store` node both
record this decision + the measurement so a future flip starts from
evidence, not the flip-and-see this evaluation just ran. The seeding
bootstrap a future flip depends on is proven safe independent of the
flag's default: `sync/eventStore.test.ts`'s "F3: event-store bootstrap —
first-boot seed, incremental reopen" (no `event-store.db` present → one
full `catchUpFromJsonl` pass → a second `createEventStore` open against
the same on-disk db is a zero-row incremental catch-up, not a rescan).
**2026-08-16, round 2 — index-backed event-candidate resolve
(perf/event-candidate-resolve).** Not an F1–F7 item; filed here per the
"binding plan tracks reality" rule — same measured symptom family
(multi-second `POST /v1/visits/batch-resolve`), a chokepoint specific to
the panel's per-navigation "focused tab" resolve. Baseline measured on
build bc862f1d: single fresh URL 3.1s, same URL warm (resolver-cache hit)
1.5s, same URL passed via `eventCandidateUrls` 6.4s AND **never cached** —
every focused-tab poll paid the full cost, forever, because the route
unconditionally forced event-candidate URLs into the miss path and skipped
both the cache read and the cache write for them (server.ts guard was
`if (batchCacheRevision !== undefined && !expandEventCandidates)`).

Measurement (item 1): a probe instrumented on a copied vault (never the
live companion) plus a coordinator-supplied macOS `sample` profile from a
real browsing burst agreed on the actual dominant cost: NOT the two
per-candidate `.filter()` calls the original hypothesis named (cheap even
on ~19K in-scope events, <25ms), but the WINDOW READ itself —
`readEventsFromStoreOrLog`'s type-scoped SELECT materializing and
JSON-decoding every `BROWSER_TIMELINE_OBSERVED`/`USER_FLOW_REJECTED`-family
row before any per-URL work started (sqlite3_step/VdbeExec/
BtreeFinishMoveto dominated the sample; the local probe showed this single
read alone costing seconds, occasionally 10s+ under machine contention).
The warm/cache-hit path additionally paid a full connections-subgraph read
(`readResolverSubgraphForUrls`) on EVERY poll for the content lane's
workstream join, even when every URL was a resolver-cache hit and no
attribution work ran at all.

Fix (four independent pieces, same PR):
- **Maintained index**: `sync/eventStore.ts` gained a `resolver_url`
  column + `events_resolver_url_idx` (migrated in-place with a one-time
  ALTER+backfill on first open of a pre-existing store) and a
  `events_type_accepted_at_idx`, plus `readByResolverUrls` /
  `readMostRecentByType` store methods. Per-URL signal/timeline events for
  the resolve now come from these indexed reads
  (`resolverSignalEventsForCanonicalUrlsIndexed` /
  `resolverTimelineEventsForCanonicalUrlsIndexed` in
  `http/routes/visitsRoutes.ts`) instead of filtering the window read —
  and the window read itself now DROPS the `BROWSER_TIMELINE_OBSERVED` /
  `USER_FLOW_REJECTED` types entirely whenever the typed store is
  available, since nothing downstream needs them from it anymore. The one
  read that still needs breadth (candidate-generation's same-domain/
  opener-chain/navigation-chain discovery, `resolverExpandedCandidateUrls
  ForCanonicalUrls`) is now a BOUNDED most-recent-N read
  (`SIDETRACK_RESOLVER_CANDIDATE_TIMELINE_WINDOW`, default 20,000, `0` =
  kill switch back to unbounded), mirroring the hub-subgraph budget
  pattern above, instead of the full type-scoped history.
- **Candidate-keyed cache**: `eventCandidateCacheRevision` folds a stable
  hash (FNV-1a) of the batch's sorted, deduped `eventCandidateUrls` into
  the resolver-cache revision string. Event-candidate targets now get a
  real cache read (folded key) before falling to the miss path, and a real
  cache write (folded key, never the plain key) after computing — same
  `(visit_id, revision)` table, same deferred-write path
  (`resolverCacheDefer.ts`) as every other entry. A changed candidate set
  is a different key, i.e. a correct miss, not a stale hit. SWR priming
  stays excluded for these entries (an event-candidate resolve is still
  never served merely-stale) — only the persisted sqlite cache backs a
  repeat.
- **All-hit fast path**: the initial per-URL loop now checks the folded
  cache BEFORE pushing an event-candidate URL into `misses`, so a repeat
  poll with an unchanged candidate set never reaches the window
  read/candidate-generation/subgraph code at all.
- **Join-snapshot memo**: the content lane's subgraph read
  (`readResolverSubgraphForUrls` for the workstream join) is now memoized
  per `(snapshotRevision, sorted URL set)` — revision-gated, not
  TTL-gated, so a cache hit is exactly as fresh as a re-read (same trust
  boundary the resolver cache itself already relies on). This was paying a
  fresh subgraph read on EVERY all-cache-hit batch before this fix.

Acceptance (serve-path): focused-URL re-resolve warm <300ms; fresh
event-candidate <1.5s; resolver-cache rows grow during browsing
(event-candidate results included, verified via
`visitsRoutes.test.ts`'s cache-read/cache-write assertions with the folded
key). Absolute wall-clock numbers from the local copied-vault measurement
were NOT clean enough to cite as a before/after table — the shared dev
machine had a live companion + its own reconcile child + (at times) a
concurrent full test-suite run contending for CPU, producing 10x swings
between identical requests. The structural claims (index used, cache
folded and hit, window read narrowed, subgraph read memoized) are verified
by call-count assertions in the touched test suites instead of wall-clock
deltas; see PR #368 for exact numbers and caveats.

Tests added:
`src/http/routes/visitsRoutes.test.ts` (new) — `stableHash` /
`eventCandidateCacheRevision` unit tests (deterministic, sorted-set- and
duplicate-invariant, distinct sets → distinct keys); events-prep
equivalence test (indexed path vs. the O(merged) JS-filter reference on a
synthetic fixture covering exact-vs-normalized URL matching, order-
insensitive compare); store-unavailable fallback parity.
`src/http/visitsRoutes.test.ts` — updated/added HTTP-level event-candidate
cache tests (folded-key write, repeat-hits-cache, changed-set-misses).

**CI follow-up (same day):** CI failed the "can expand focused URL event
candidates" test on two consecutive runs; unreproducible locally (any
single file, the whole `src/http/` dir, or a clean worktree of the branch
all green). Root cause not pinned with certainty without CI log access,
but the test's OWN assertions were genuinely fragile: three assertions
reconstructed the expected folded resolver-cache key by calling
`resolverCacheRevision(...)` a SECOND time at assertion time, which
re-reads `attributionArm()` (env-backed) — any full-suite ordering
difference (CI's Linux file-discovery order vs. local macOS, per the
existing `TMPDIR=/dev/shm` COW-timing precedent in `ci.yml`) that leaves a
DIFFERENT arm value active between the server's request-time computation
and the test's assertion-time reconstruction breaks an exact-string match
that was never actually part of the behavior under test. Fixed by
asserting on the RECORDED call's actual revision string instead (shape:
`{prefix}|arm=...|ec:{hash}`, where the `|ec:` hash portion — a pure
function of the URL set, zero env dependency — is still checked exactly).
Also closed a resource leak in the new equivalence test file: the typed
event store's sqlite handle was never `.close()`d before its tmpdir was
`rm -rf`'d, leaving a dangling handle in `sync/eventStore.ts`'s
process-lifetime `sharedEventStores` map — a plausible source of the
unattributed "3 errors" CI reported alongside the one named failure.

**CI follow-up 2 (same day, confirmed root cause).** The arm-mismatch fix
above was necessary hardening but NOT sufficient — CI failed again with
the actual mechanism visible in the log this time: `cacheWriteCall` was
`undefined` (the mock was never called at all with the target URL) and,
separately, a recorded call's `|ec:` suffix didn't match the expected
one. Real cause: the per-URL resolver-cache WRITE is deferred off the
request path (`resolverCacheDefer.ts`, default ON) — queued during the
request, drained on a `setImmediate` scheduled AFTER the response is
already sent. The new tests asserted on the write immediately after
`response.json()`, before the drain tick had necessarily run — a genuine
scheduling race, not env pollution, that a slower/more-contended CI
runner loses far more often than a quiet local Mac. The file already had
a documented, working pattern for this exact problem ("persists the
resolver cache AFTER responding", a poll-with-deadline) that the new
tests should have reused and didn't. Fixed properly instead: awaited the
module's own deterministic drain (`flushResolverCacheWrites()`, already
exported and used by `resolverCacheDefer.test.ts`) at each checkpoint —
no sleep/poll — and switched from "first matching call" to "last
matching call" per URL (the deferred-write queue is keyed on
`(visitId, revision)`, so two genuinely distinct writes for the same URL
under different folded revisions can both be pending at once if not
individually flushed+cleared between requests). Also added
`__resetResolverCacheDeferQueue()` to the describe block's
`beforeEach`/`afterEach` — the queue is process-lifetime module state,
so a write still pending from a prior test could otherwise bleed into a
later one's flush. A third, unrelated failure appeared in the same CI
run — `connections incremental ranker frontier > forces a full ranker
augmentation...` timed out at the bun:test default 5000ms. Proven
pre-existing and load-related, not a regression: the test (real
`connectionsMaterializer` work, no event-store/typed-store dependency at
all) passed 6/6 in isolation on BOTH the pre-PR base commit and this
branch, ~1s each, across 8 total runs; the SAME CI run that timed it out
also logged an unrelated embedding-model load taking 6.9s (normally
under 1s) and a 637ms event-loop stall immediately before the timeout —
independent evidence the runner itself was heavily contended that pass,
not that anything in this PR slowed the materializer down.

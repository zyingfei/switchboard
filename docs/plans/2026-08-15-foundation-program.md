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
| F2 | JSONL hot-tail retirement | Report-only enumeration with per-day seal proofs; destructive apply behind flag + soak (~Aug 21); one-command flip documented | DONE — apply shipped (feat/f2-retire-apply, 2026-08-21): move-not-delete `retire-hot-tail --apply` + `event-store-vacuum`, same safety bar as compact-engagement (arm env + recall process-lock + per-shard fail-closed re-validation + crash-safe atomic rename + bounded receipt log); soak window executed by the coordinator |
| F3 | No full-log walks on hot paths | Survey complete (see below); foreground-nav overlay migrated to typed reads with equivalence test; phase-log shows no full-log walk during a normal drain + nav burst | Overlay migration done; remaining hot readMerged callers (health/§15/ingestor/retrain-worker) migrated + equivalence-tested (PR TBD, 2026-08-16); default-ON flip evaluated and NOT shipped (test-fixture blocker, see landing note) |
| F4 | Blob diet | Accumulator blob + append-index snapshot off pretty JSON (CBOR/compact or incremental); snapshot load <1s (baseline 2.5s); measured before/after | Pending (after F1–F3) |
| F5 | Small-file stores → SQLite | page-content (703 files) + page-evidence (3,741 files) each one SQLite; one transaction per capture; #356/#357 manifest upserts deleted as obsolete; migration + rollback documented | Pending |
| F6 | Leftover bugs | Evidence-manifest staleness on lane writes fixed (done, verified 60/60); AttributionProvenance fallback honesty (done, verified 56/56) | Merged-pending (PR #361) |
| F7 | Top-K similarity flake dead | Root cause with deterministic repro; fix; 200 consecutive green runs | Agent running |
| F9 | Idle I/O floor | Root cause instrumented (not guessed): a real forked child's own rusage, measured against a real vault; idle-pattern fixture (10 trickle events) → at most 1 child spawn; single-trivial-event drain write volume reported | DONE — perf/idle-drain-overhead; see landing note below |

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

## F2 design note (2026-08-16) — OLAP candidate comparison, analytics side

Binding user rule (2026-08-16): compare candidates before writing retirement
code. Scope: the ANALYTICS reads only (retirement eligibility report,
reclaimable-bytes accounting, seal-coverage queries over the columnar
tier) — NOT a new storage engine; the columnar tier already exists
(`src/analytics/eventSeal.ts`, `src/analytics/eventScan.ts`,
`docs/design/2026-08-01-columnar-event-tier.md`) and already answered this
exact question with a measured PoC gate (2026-08-01, real vault shard, Bun
1.3.14, macOS arm64): DuckDB embeds cleanly under Bun (25× open/close, zero
crashes), seals 14.2MB JSONL → 0.6MB Parquet (22.9×), and — the decisive
number — **DuckDB over raw JSONL was SLOWER than a plain JS loop (98ms vs
34ms) while DuckDB over sealed Parquet was 17× faster than that same JS
loop (2ms)**; chDB was evaluated and rejected as unnecessary (DuckDB
suffices, no maintained Bun-native chDB binding). `@duckdb/node-api` is
already a production dependency (`package.json`), imported by both
`eventSeal.ts` (sealing) and `eventScan.ts` (the sealed-vs-store integrity
A/B this PR's proofs reuse).

| Candidate | Fit for THIS workload (retirement report / seal-coverage) |
|---|---|
| Bespoke JS scan of raw hot-tail JSONL | Wrong tool per the PoC's own number (98ms DuckDB vs 34ms JS on raw JSONL — DuckDB adds engine overhead for zero benefit on ungrouped raw text); the report's hot-tail byte accounting is one `stat()` per shard file (already O(shard count), not O(events)), so this candidate is moot for that part and actively worse for anything that DOES need to scan (segment verification). |
| chDB (embedded ClickHouse) | Rejected 2026-08-01 (design doc): no maintained Bun-native binding; not a dependency; would add a second embedded-analytics runtime for zero measured benefit over the already-proven DuckDB path. |
| DuckDB over sealed Parquet (existing facade) | **Already the answer.** The columnar tier's format (zstd Parquet, `_BAC/seal/<replica>/<day>.parquet`) is DuckDB-native; `eventScan.ts`'s `read_parquet(...)` aggregate query is the exact seal-coverage primitive this report needs (manifest rows vs parquet aggregate vs store day-stats) — reused directly (`readSealedParquetDayStats`, exported from `eventScan.ts` for this PR), not reimplemented. |
| Verdict | Wire the retirement report through the existing DuckDB-over-Parquet facade (reuse `eventScan.ts`'s reader), not bespoke JSONL scanning. The only NEW read this PR adds is a readonly `bun:sqlite` query against the event-store mirror for live per-day row counts (`{readonly: true}` — see CLI process-lock discipline below) and `stat()` calls for hot-tail JSONL byte sizes; neither is an OLAP workload, so neither needed DuckDB. |

**Spike (this PR, 2026-08-16), re-verifying under today's Bun/toolchain
before committing to the design in code:** `bun /tmp/f2-duckdb-spike.mjs`
against a REAL sealed segment from the test vault
(`~/.sidetrack-vault-test/_BAC/seal/c4205c0c-.../2026-05-12.parquet`,
read-only, zero vault mutation) — `DuckDBInstance.create(':memory:')` →
`connect()` → `read_parquet(...)` grouped aggregate: **SUCCESS**, 8.9ms,
correct row/seq/type counts
(`{"replica":"c4205c0c-...","n":2,"lo":1,"hi":2,"distinctTypes":1}`), Bun
1.3.14. Confirms the 2026-08-01 PoC gate still holds on this machine/Bun
version; no regression to report. chDB was not re-spiked (never a
dependency, no code path to verify).

## Storage-tier incremental publish — design note (2026-08-16)

Not an F1–F7 item; filed here per the "binding plan tracks reality" rule.
Binding user motivation: SMART shows +410GB host writes/day on the daily
machine; the connections generation db is copied whole on every publish.
Binding constraint: no full write built from the beginning of the log
anywhere in the design (this item is about the STORAGE tier, not the
compute tier — `sync/contract/connectionsMaterializer.ts` is out of
bounds and untouched by this work; the compute layer already emits
scoped deltas — see F8/IVM history above).

**Measured baseline (`~/.sidetrack-vault-test/_BAC/connections/`,
read-only, live companion never restarted/contacted).** Two full
generation files resident simultaneously:
`current.1786920603311-826290F7X5KN4.db` and
`current.1786920641023-82629Y4EW8ZW7.db`, each exactly 437,288,960 bytes,
minted 37,712ms apart (mtimes 15:50:03 and 15:50:41 during the same
active-browsing window) — an on-disk, present-tense instance of "sometimes
twice in one minute." The live companion (pid 75314) had been up only 37
minutes at measurement time (fresh boot), so a same-boot 24h steady-state
count isn't directly observable without restarting it (out of bounds
here); extrapolating this single fresh-boot rate (874,577,920 bytes / 37
min) across a full day projects **~34 GB/day** from connections-generation
copy-on-publish churn alone, on this one vault. That is a lower bound on
the real contribution — it does not include any slower background-hours
cadence separately, and every one of these copies is 100% write
amplification: the actual row-level delta each publish applies is
routinely tens to low-thousands of SQL upserts (`replaceScopeRows` /
`#applyOverlayOnDb`), not 437MB of new content.

**Investigation — where the copy happens and why (`connections/
generationBuffer.ts`, `connections/snapshot.ts`).** M4's double-buffer
design (2026-07-29, header comments in `generationBuffer.ts`) made every
publish a **generation-pointer flip**: `current.gen` names one
`current.<genId>.db` file; every writer — the fork-per-drain child
(`role: 'child-writer'`) doing a scoped delta, AND the long-running
parent process (`role: 'parent-reader'`) doing either a foreground-nav
scoped delta (`replaceScopeRows`) or a single-event metadata overlay
(`applyProjectionEventOverlay`) — clones the ENTIRE currently-published
generation file (`createShadowGeneration`'s `copyFileSync`, APFS
clonefile-optimized but still a full logical copy that becomes a full
physical copy the instant either file diverges by even one page), applies
its (already O(delta)) SQL mutation inside `BEGIN IMMEDIATE` on the
clone, `PRAGMA wal_checkpoint(TRUNCATE)`s it, then CAS-flips the pointer
under a cross-process lock (`withPublishLock`/`casPublish`). The
**"overlay twin"** the task asked about is exactly this: the parent's own
`#overlayViaShadowPublish` (generation id shape
`overlay<pid><rev6>`) mints an independent full clone for a
SINGLE folded event — the second 437MB file measured above. The **TOCTOU
generation-open retry** (`#openHandleForRole`, both the child-read and
parent-reader branches) exists because the GC that runs after every
CAS-won publish can retire a generation between a reader's `readPointer`
and its `open()` call; unrelated to the copy cost itself, and left
untouched by this change (still correct: it recovers by re-reading the
pointer once).

The three reasons the M4 header gives for the clone+flip design, verified
against the actual code:
1. Renaming a file OVER a path an open readonly handle names throws
   "disk I/O error" on APFS (vnode swap) — so publish can never rewrite
   the SERVED PATH in place via rename. (Still true; irrelevant to this
   change — in-place publish never renames anything.)
2. Every published generation is checkpoint-TRUNCATE'd BEFORE the
   pointer names it, believed necessary so a readonly reader never needs
   to coordinate with a live writer via the WAL shared-memory index.
   **This premise is the one this change overturns — see the empirical
   verification below.**
3. Unlinking a generation while ANY handle still has it open throws
   "disk I/O error" on that handle's next query — so GC must never
   remove a generation a live handle holds. (Still true and still
   enforced by `#liveHeldGenIds()`/the in-flight markers; irrelevant here
   because in-place publish never unlinks the file readers hold — it's
   the SAME file before and after.)
4. Two writers on the SAME file collide (`SQLITE_BUSY` on `BEGIN
   IMMEDIATE`) — real, and still handled: `withPublishLock`'s
   cross-process O_EXCL lockfile already serializes every writer
   (parent overlay queue, parent scoped-delta, child-writer) today: this
   change keeps using the exact same lock for the exact same reason, just
   around a cheaper critical section (no `copyFileSync` of 437MB inside
   it — lock hold time goes DOWN).

**Empirical WAL snapshot-isolation verification (this task's explicit
ask, bun:sqlite 1.3.14, this machine, throwaway spike at
`/tmp/wal-spike/spike.mjs` + `spike2.mjs`, not committed).** Two
questions had to be answered before trusting an in-place design instead
of relying on the M4 authors' (untested) assumption that a reader needs a
fully quiescent file:
- **Does a reader block or see torn data while a writer holds a
  transaction on the same WAL file?** No, and no. A `BEGIN
  DEFERRED`-pinned reader held its OLD snapshot throughout a concurrent
  writer's 999-row `BEGIN IMMEDIATE` insert AND after that writer's
  `COMMIT`, until the reader's own transaction ended. A plain
  autocommit `SELECT` (no explicit transaction — exactly
  `#readCurrentAttempt`'s existing H6 pattern) issued mid-writer-transaction
  also correctly saw the pre-write snapshot. **Zero `SQLITE_BUSY` was ever
  thrown at any reader**, despite the writer holding `BEGIN IMMEDIATE`
  open for the whole insert loop — WAL readers never block on writers,
  confirmed directly rather than assumed. A brand-new reader opened
  immediately after `COMMIT` saw the fresh data instantly.
- **Does ONE long-lived reader connection (matching the store's cached
  `#db`, reused across many HTTP requests) keep picking up EVERY
  subsequent writer commit, or does it cache a stale wal-index
  snapshot?** Tested across 5 rounds of 100-row `SAVEPOINT`/`RELEASE`
  writer commits against the SAME already-open reader connection: the
  reader's plain `SELECT COUNT(*)` tracked the writer exactly
  (100/200/300/400/500), every round, whether the writer's own commits
  used `SAVEPOINT ...; RELEASE ...;` (spike2, no enclosing `BEGIN` —
  confirmed a bare savepoint genuinely commits standalone: a second,
  independent writer connection could immediately acquire the write
  lock right after a `RELEASE`) or `BEGIN IMMEDIATE; COMMIT;` (spike,
  and the shape actually shipped — see the "SAVEPOINT per publish"
  deviation note below). The isolation guarantee this section verifies —
  a long-lived reader connection correctly tracks every writer commit —
  is a property of WAL + a top-level transaction, not of which spelling
  (`SAVEPOINT` vs `BEGIN`) opened it, so it holds for whichever this
  design ends up using.

Conclusion: reason (2) above does not hold. A readonly bun:sqlite
connection on a live (non-checkpointed) WAL file, read with the store's
EXISTING read pattern (plain autocommit statements, no held transaction
across `await` — `#readCurrentAttempt`'s own comment already explains why
it avoids a long-held read transaction: "BEGIN DEFERRED with awaits would
hold a SHARED lock across event-loop turns — bad"), gets correct MVCC
isolation with zero risk of `SQLITE_BUSY`, whether or not a writer is
mid-transaction on the same file. The existing H6 write_seq pre/post
check is not just compatible with in-place publish, it is *already*
exactly the right mechanism for it (it exists to catch a writer's commit
straddling a paged multi-statement read; that hazard is unchanged whether
the straddled writer changed the file's identity or wrote it in place).

**Design.** Introduce `SIDETRACK_INPLACE_PUBLISH` (absent/non-`0` = ON).
When enabled, both scoped-delta writes (`replaceScopeRows`) and
single-event overlay writes (`applyProjectionEventOverlay`) — from
EITHER writer role, child-writer or parent-reader, since both call the
same store methods — apply their mutation **in place** on the CURRENTLY
PUBLISHED generation file instead of cloning it:
1. `await loadSqlite()` (async, one-time module resolution) OUTSIDE the
   lock, then acquire the cross-process publish lock
   (`generationBuffer.ts` gains `acquirePublishLock`/`releasePublishLock`,
   the blocking-acquire half of `withPublishLock` factored out so a
   caller can hold it across more than one synchronous callback —
   `withPublishLock` itself becomes a thin wrapper over the pair, so
   `casPublish`/`sweepOrphanGenerations` are unchanged).
2. Re-read `current.gen`; open THAT file `{ readwrite: true }` directly
   (no `copyFileSync`). Run `#initSchemaOn` (idempotent `CREATE TABLE/
   INDEX IF NOT EXISTS`) so a generation from before this change (or the
   self-healing `idx_edges_index_src_dst` index from the 2026-08-16
   watchdog-loop fix) is brought current — free, since the DDL is a
   no-op on an already-current schema.
3. Hand the fresh connection back to the caller with NO transaction open
   yet — same contract `#acquireGraphWriteHandle` already has. The
   caller's existing, already-O(delta) row mutations
   (`replaceScopeRows`'s temp-table diff/upsert block or
   `#applyOverlayOnDb`'s single-row fold) run **completely unchanged**,
   including their own `db.exec('BEGIN IMMEDIATE')` /
   `COMMIT`/`ROLLBACK` — bumping `write_seq` exactly as today.
   **Deviation from the task's literal "SAVEPOINT per publish" wording,
   flagged here rather than silently substituted:** the natural reading
   was "wrap the whole open→mutate→finalize span in one named
   `SAVEPOINT`," but that is empirically impossible without ALSO rewriting
   every touched call site's transaction verbs — a bare `SAVEPOINT`
   followed by the existing code's `BEGIN IMMEDIATE` throws SQLite's
   "cannot start a transaction within a transaction" (verified,
   `/tmp/wal-spike/spike3.mjs`). Rewriting `replaceScopeRows`'s and
   `#applyOverlayOnDb`'s internal transaction verbs to `SAVEPOINT`/
   `RELEASE` was rejected as unjustified extra surface area on
   already-tested, shared code (both methods are ALSO used by the
   unchanged clone+flip fallback path, and `#applyOverlayOnDb` is called
   with a `db` that may later host a nested `#bootstrapScopeMembershipOn`
   `BEGIN IMMEDIATE` from a sibling call site on the same connection) for
   zero additional crash-safety benefit: a top-level `BEGIN
   IMMEDIATE`/`COMMIT` is transactionally equivalent to a top-level bare
   `SAVEPOINT`/`RELEASE` (both are ordinary WAL transactions; SQLite does
   not persist an uncommitted transaction as visible/committed under
   either spelling), and `BEGIN IMMEDIATE`/`COMMIT` is the exact,
   already-proven primitive every other writer in this class already
   uses. The atomicity guarantee the task cares about (kill mid-publish →
   reopen shows fully-old or fully-new, never torn) holds identically
   either way and is exactly what the crash-kill test proves.
4. On success: the caller's own `COMMIT` already ran; close this
   short-lived writable connection (opened fresh per publish call — no
   persistent writer handle is kept between publishes, trading a
   sub-millisecond open/close for a much simpler crash/lifecycle story:
   nothing in `close()` or the retired-handle bookkeeping needs to
   change, and there is no long-lived writable handle whose staleness
   after a pointer flip would need separate reasoning). On failure, the
   caller's own `ROLLBACK` already ran. Either way, release the publish
   lock after closing the connection.
5. **No pointer flip, no new generation file, no GC.** `current.gen`
   keeps naming the SAME file across an unbounded run of scoped/overlay
   publishes; `#swapCount`/`residentGenerations()` are unaffected because
   nothing new was ever minted.

**What still uses clone+flip (unchanged).** A FULL graph write
(`putCurrent`/`writeSnapshotAndProgress` when the S1 strong content
signature doesn't match — i.e. a genuine full rebuild, not a scoped
delta) keeps the existing shadow-clone-then-CAS-flip path. So does
`migrateLegacyToGeneration` (first boot), `reconcileLegacyToPublished`
(kill-switch downgrade), and any future schema migration that needs a
structural (non-`IF NOT EXISTS`) DDL change — those get to choose a fresh
generation deliberately rather than mutating a live file's schema under
readers. `vacuum()` also stays a no-op for the graph generation (VACUUM
rewrites the whole file and is incompatible with concurrent readers
regardless of WAL; full compaction remains a rare, explicit,
consent-gated maintenance path, not something this PR touches). This is
the "partial adoption" the task's own contingency allows for: in-place
for the high-frequency scoped/overlay channel, clone+flip preserved for
the low-frequency structural channel — because the two have different
correctness requirements (a structural change legitimately needs
readers to keep serving the OLD schema until they're ready to move,
which the pointer-flip model exists for; a scoped delta does not).

**Revision / `write_seq` semantics — unchanged, and why that's provably
safe.** `write_seq` and `snapshotRevision` are pure row content living in
the `metadata` table; both are already generation-file-identity-agnostic
(bumped/computed identically by `#bumpWriteSeq`/`computeSnapshotRevision`
regardless of which physical file they're written to). The ONE thing
that IS keyed on generation identity is the S1 progress-checkpoint
sidecar (`progress.checkpoint.json`, `generationId`-bound,
`progressCheckpoint.ts`) — in-place publish makes generation identity
change LESS often, which can only make that sidecar's
`checkpoint.generationId !== input.generationId` staleness check fire
LESS often (strictly more often valid), never introduce a new failure
mode. F4's derive-memo (`#cachedDerivedProjections`, keyed on
`write_seq`) and the resolve-cache's `snapshot_revision` keying are
likewise untouched: both already treat write_seq/snapshotRevision as the
sole trust boundary, never the generation filename. An equivalence test
(mandatory test 4) proves the row-level output is byte-identical whether
a given input sequence of scoped-delta writes is applied via the legacy
clone-per-write path or the new in-place path.

**WAL checkpoint policy (measured).** `PRAGMA wal_autocheckpoint` stays
at SQLite's default (1000 pages, ~4MB) — unchanged, and still fires
automatically (PASSIVE) after each commit once crossed, reclaiming frames
no open reader still needs. Measured empirically (spike2.mjs, 501 rows /
5 SAVEPOINT rounds): WAL stayed at 57,712 bytes, well under the 4MB
auto-checkpoint threshold, so PASSIVE auto-checkpoint had nothing to do
yet in that run — expected at this row count, not a sign it's inert.
Because in-place publish no longer gets a "free" checkpoint-TRUNCATE on
every publish (that step belonged to the clone+flip path, run once per
NEW file before the pointer named it), this PR adds an explicit **idle
checkpoint**: after `SIDETRACK_INPLACE_CHECKPOINT_IDLE_MS` (default
30,000ms) with no further in-place publish, run one
`PRAGMA wal_checkpoint(TRUNCATE)` on the graph generation — same idle-timer
shape as the class's existing `#scheduleCachedSnapshotSweep`. A count-based
safety net (`SIDETRACK_INPLACE_CHECKPOINT_EVERY_N`, default 50 publishes)
also forces a TRUNCATE checkpoint independent of idle timing, so a vault
under continuous activity (idle timer never fires) still bounds WAL
growth. TRUNCATE is more disruptive to a reader that happens to hold an
old snapshot mid-checkpoint than PASSIVE (it must wait for the last
reader of the oldest still-needed frames to finish before it can fully
reclaim), which is exactly why it's reserved for idle/periodic moments
rather than run on every publish — documented here per the task's
"measure, don't guess" bar; the write-volume test asserts per-publish
bytes stay O(delta) with this policy active.

**Env gate.** `SIDETRACK_INPLACE_PUBLISH`, default ON (absent/non-`0`).
`=0` reverts scoped/overlay writes to EXACTLY today's clone+CAS-flip
code path, byte-for-byte — the existing `#acquireGraphWriteHandle`
parent-reader shadow-clone branch and `#overlayViaShadowPublish` are kept
intact, not deleted, specifically so this is a genuine zero-risk kill
switch for one soak cycle, not a one-way door.

**Deferred / explicitly out of scope.** GC (`gcOldGenerations`,
`surveyGenerations`, `sweepOrphanGenerations`) needs no functional
change — a vault under steady-state in-place publishing simply stops
minting new generations to collect, which those functions already handle
correctly (0 orphans is a valid, already-tested state). Full `VACUUM`
page-level compaction (distinct from WAL checkpointing) is left as a
future consent-gated maintenance op, matching F1/F2's existing
consent-gated destructive-op pattern — this PR does not add one.
`connections/contract/connectionsMaterializer.ts` is untouched, per this
task's binding constraint; every change is confined to
`connections/snapshot.ts` and `connections/generationBuffer.ts`.

## Learned per-node aggregator stats — design note (2026-08-16)

Not an F1–F7 item; filed here per the "binding plan tracks reality" rule
because it replaces load-bearing machinery (`ranker/aggregatorProfiles.ts`)
consumed by two serving guards. Binding user directive: replace the
hand-maintained per-domain registry (ycombinator/reddit/twitter/… profiles,
hand-written `isItemUrl` predicates + title-chrome patterns) with LEARNED
per-node behavioral statistics — no domain list, no URL-shape special-casing
in the replacement. First shipped as a SHADOW (observe-only); the registry
keeps deciding until shadow-agreement evidence justifies a follow-up flip.

**Why the registry rots.** One label per domain cannot capture: HN
(categories + item pages), postgres.org/openai/clickhouse blogs
(single-source, every page is a distinct object), and Uber/Cloudflare eng
blogs (multi-source-WITH-preference — categorized but each post still a
stable object). The registry's `isItemUrl` predicates are per-domain regexes
that must be hand-added for every new site.

**What the two guards actually consume** (read from their source, not
inferred): both call sites need exactly `AggregatorPageType` ('feed' |
'item' | 'not-aggregator') per URL, nothing else from the classification
surface. `candidates.ts`'s `suppressCoarseGrouping`/`repoOrDomainKeys` uses
it to decide whether a URL contributes a bare `domain:` grouping key
(suppressed for feed pages) or participates normally; `titlePathTokenKeys`
suppresses ALL title/path lexical tokens for any aggregator host
unconditionally (not gated on feed/item). `tabsession/similarity.ts`'s
`isAnyAggregatorVisit` (feed OR item, ignoring item-narrowing — see the
file's own 2026-07-24 comment on why) drops two chrome-derived signal
classes between any two aggregator pages: raw `embedding_neighborhood`
candidates and `title_only`-tier persisted resemblance edges. `isAggregatorHost`
is the same classifier collapsed to a boolean (domain has ANY profile).
Both guards exist because of the 2026-07-10 false-friend (a feed page's
shared site-chrome title/path tokens filed an AI-video HN post next to
unrelated linux-security items at 82% confidence) — any replacement must
default to quarantining unknown/ambiguous shapes on a known-hub domain: the
guard is allowed to be wrong by over-suppressing (an item briefly loses
signal), never by under-suppressing (a feed page's chrome links two
unrelated stories). `stripSiteTitleSuffix` (site-chrome title stripping,
`visitSimilarity.ts`) and `aggregatorCommunityKey` (subreddit/author
grouping, `candidates.ts`) are NOT part of this replacement — they
inherently encode per-site chrome/community knowledge (a literal " | Hacker
News" suffix, a subreddit path segment) a behavioral classifier has no basis
to reconstruct; only `AggregatorPageType` is in scope.

**Known scope limit, resolved during implementation.** The live shadow row
reads a BOUNDED most-recent-N window via the typed event store's
`readMostRecentByType(type, limit)` (`sync/eventStore.ts:107`,
`events_accepted_at_ms_idx`) for `NAVIGATION_COMMITTED` and
`BROWSER_TIMELINE_OBSERVED` — the same bounded idiom `http/server.ts`'s
`timelineEventsForCandidateGeneration` already established for
`SIDETRACK_RESOLVER_CANDIDATE_TIMELINE_WINDOW` (see the 2026-08-16
"index-backed event-candidate resolve" landing note above) —
`SIDETRACK_LEARNED_AGGREGATOR_WINDOW`, default 20,000 per type, `0` = kill
switch back to the unbounded type-scoped `forEachChunkOfTypes` read.
`readMostRecentByType` returns most-recent-first, not causal order, so the
health-collection adapter sorts by `acceptedAtMs` ascending before folding —
required for `NAVIGATION_COMMITTED`'s opener-chain resolution, which needs
an opener's own commit event folded before its child's. When the typed
store is unavailable, this diagnostic falls back to `eventLog.readMerged()`
filtered by type — the SAME fallback cost class `readEventsForHealth`'s
other callers in this exact file already accept (`readFeedbackEvents`, the
recall.served/action read), not a new regression class. The full-history
fold (no window) is reserved for the offline measurement CLI, matching the
F3 exit-criteria's own carve-out ("allowed: cold boot recovery, gap seal,
CLI/eval").

**Signals available without touching `connectionsMaterializer.ts`** (out of
bounds for this work), per the actual data model: `NAVIGATION_COMMITTED`
carries `{visitId, canonicalUrl, openerVisitId, previousVisitId,
commitTimestamp}` — opener/navigation-chain edges, the same data
`ranker/candidates.ts`'s `opener_chain`/`navigation_chain` generators use.
`BROWSER_TIMELINE_OBSERVED` carries `{canonicalUrl, title, observedAt}` —
one discrete observation per ~30s dwell window, per that file's own doc
comment. Both are typed events, readable via the existing
`readMostRecentByType`/`forEachChunkOfTypes` indexed idiom
(`system/workGraphHealth.ts:353`), never a full-log scan for the live
shadow row (see "Known scope limit" above). `PAGE_EVIDENCE_EXTRACTED`
(`page-evidence/types.ts`) additionally carries a `contentHash` per capture
— a stronger churn signal than title alone, deliberately NOT wired into
this PR's counters (title churn is sufficient for a first shadow cut and
keeps the event surface this PR reads to exactly two types); adding a
content-hash channel later does not change `AggregatorVisitObservation`'s
shape, only adds a field to it.

**Design: per-node + per-domain counters, incrementally maintained.**
Per-URL (`UrlAggregatorCounters`): `captureCount` (distinct timeline
observations carrying a title), `titleChangeCount` (adjacent-capture title
deltas — content churn across captures of the SAME url: a feed URL is
revisited and re-extracted with a changing title each time; an item URL's
title is stable once captured), `outlinkTargets` (bounded set, capped 64, of
distinct same-domain canonical URLs this URL was observed opening or
navigation-chaining to — degree = set size; "hub-ness is behavior" made
concrete as fan-out, not a URL shape), `inboundSources` (bounded set, capped
32, of distinct URLs that opened/chained INTO this one — the "reached from a
hub" signal).

Per-domain (`DomainAggregatorCounters`): `distinctUrlCount`,
`maxQualifyingOutlinkFanout` and `hubCandidateCount` — but a URL's fan-out
only counts toward these once it *also* clears a revisit/churn bar
(`captureCount >= 2 OR titleChangeCount >= 1`), so a single-visit
table-of-contents page on an otherwise single-source blog doesn't alone
flip the domain into "hub" (ties fan-out to the revisit-cadence and churn
signals explicitly called for, not fan-out alone). Both fields are updated
on the same write that changes the qualifying URL's own counters (O(1)) —
never recomputed by scanning the domain's URL set, so reads
(`isLearnedAggregatorHost`) are O(1) too.

Domain qualifies as a **hub** (replaces `isAggregatorHost`) when
`distinctUrlCount >= 5 AND maxQualifyingOutlinkFanout >= 8` (both thresholds
named, tunable constants — never a domain-specific override). Below that
bar → `not-aggregator`, matching the registry's default for everything it
doesn't list — this is what lets postgres.org/openai/clickhouse-shaped
domains classify as `not-aggregator` (never observed fanning out) while
HN/Reddit/GitHub-shaped domains classify as hub-like from behavior alone.

Within a hub domain, per-URL (replaces `isItemUrl`):
1. No observations yet for this URL → **feed** (cold start, conservative;
   binding requirement).
2. URL's own qualifying outlink fan-out ≥ 8 → **feed** (it IS a listing/hub
   page).
3. Title churn rate ≥ 0.34 over ≥2 captures → **feed** (content keeps
   changing under a stable URL — the listing signature).
4. Reached from a same-domain hub URL (an `inboundSources` member whose own
   qualifying fan-out ≥ 8) AND this URL's own fan-out ≤ 3 → **item** (the
   one positive signal, works even on a single visit — most real items are
   visited once, so requiring revisits to prove "item" would silently
   revert to the pre-2026-07-24 blanket-feed behavior for the majority of
   real items).
5. Otherwise (hub domain, ambiguous URL, no positive item evidence) →
   **feed** (conservative default; binding requirement).

**Signals considered and NOT used as gates (documented, not silently
dropped).** Domain-level path-prefix entropy ("distinct path-prefixes /
authors proxy") is tracked as a diagnostic metric only — HN normalizes path
shape (`/item` for every story), so a hub's path entropy can be as low as a
single-author blog's; it doesn't reliably separate the two in isolation. URL
depth/param count were considered and rejected as gates for the same reason:
HN items are shallow (`/item?id=`), code-forge items are deep
(`/owner/repo/pull/N`) — no depth threshold is consistent across observed
platform shapes without becoming a per-platform special case, which is
exactly what this replacement must not do.

**Known limitation to resolve with shadow evidence, not a priori.** A
genuinely single-source, multi-post blog (the user's "postgres.org/openai/
clickhouse" example) can still have an index/category page that fans out to
8+ of the *same author's* posts, which the fan-out-only heuristic cannot
distinguish from a true multi-author hub without an authorship signal this
vault doesn't capture. This is exactly what the real-vault measurement
(agreement on registry domains + spot-check plausibility on 5+ non-registry
domains, single-source blogs included) is for — reported honestly in the PR
body rather than hidden. Confirmed live on the real vault: a personal
docs/cheat-sheets site (8 distinct URLs total, name withheld here —
see PR body) crossed the domain hub bar — root plus a couple of category
pages fan out to enough of the site's own other pages via ordinary
nav-menu clicks — and EVERY page on the domain, including clearly
single-author content leaves like a `/cheat-sheets/big-o-complexity`-style
page, classified `feed`. Root cause: on a domain this small, no single
page can ever accumulate the `inboundSources`-side fan-out (`>= 8`)
`classifyLearnedAggregatorPage`'s positive item signal (step 4) requires,
so step 5's conservative default always wins. Sample size (7 of 8
non-registry spot-check domains classified plausibly as `not-aggregator` —
an encyclopedia, an audiobook storefront, a crypto textbook site, an AI
console/settings surface, two docs sites, and one multi-author-style blog)
suggests this is a narrow, small-site edge case rather than the common
case, but it is real, not hypothetical.

**Second limitation, found BY the real-vault measurement (not predicted up
front).** Agreement varies enormously by domain: news.ycombinator.com
80.6% (537 URLs), but github.com/reddit.com/claude.ai 0% and
chatgpt.com/gemini.google.com under 15% (see PR body for exact counts). Root
cause: `isLearnedAggregatorHost` requires OBSERVING a page whose own
qualifying fan-out clears the bar — but this vault's captured navigation
history rarely contains a same-domain "hub" page as the `openerVisitId`/
`previousVisitId` source for a repo/thread/comments visit (real visits to
these arrive via external links, bookmarks, or typed URLs, not by clicking
through the platform's OWN listing page). The domain-level hub gate never
clears, so the whole domain falls to the conservative `not-aggregator`
default — safe (never falsely groups two unrelated items by chrome), but it
means the shadow currently reproduces much LESS of the registry's coverage
than hoped on exactly the platforms the registry protects hardest. This is
the real, load-bearing reason registry-replacement stays a gated follow-up:
the counters need either a corroborating signal that doesn't require
observing the launch page directly, or accept a materially different
(narrower) protection surface than the registry — a decision for the
follow-up, made from this evidence, not before it.

**Shipping shape.** New module `src/ranker/learnedAggregatorStats.ts`
(counters + classifier, mutating accumulator, no I/O) and
`src/ranker/learnedAggregatorStatsEvents.ts` (the one place that resolves
`NAVIGATION_COMMITTED`'s opener/previous visitId chain to a canonical URL,
keeping the stats module itself free of event-log/visitId bookkeeping).
Shadow wiring in `system/workGraphHealth.ts` adds one new
`DiagnosticCandidate` (`aggregator.learned-stats-shadow`, family
`similarity`, lane `shadow`, servingImpact `observe-only` — the existing
Experiments-row pattern, `topic.incremental-shadow`'s sibling) computed
INSIDE `collectWorkGraphHealth`, never touching `connectionsMaterializer.ts`.
It classifies every distinct canonicalUrl observed in the bounded window
against BOTH the registry (`classifyAggregatorPageForUrl`) and the learned
classifier, and reports agreement/disagreement counts via
`buildAggregatorShadowAgreement` — overall, and split into registry-only
(learned under-reaches), learned-only (learned finds hubs the hand list
doesn't cover — the entire point of this replacement), and feed-vs-item
disagreement. Behind `SIDETRACK_LEARNED_AGGREGATOR` (absent/non-`0` = ON,
matching `aggregatorGroupingGuardEnabled`'s call-time style — shadow is
opt-OUT since it only ever observes). This PR changes zero serving
decisions; the registry keeps deciding both guards. Registry-replacement is
a follow-up PR gated on shadow-agreement evidence from the real vault (see
PR body for the actual numbers).

### Follow-up: opener-independent hub signals — task #22 (2026-08-21)

Closes the "Second limitation" above, using the SAME evidence-first
discipline: measured before writing a line of new logic
(`scripts/measure-learned-aggregator-stats.ts`, extended to a per-domain
breakdown + a keyword-index/keyword-concepts join for entropy), THEN
implemented, THEN re-measured on the same vault snapshot. See the PR body
for the full before/after table and the disagreement-sample classification;
summary below.

**Root cause, confirmed by measurement (not assumption).** The blind-spot
domains (github.com, reddit.com, chatgpt.com, claude.ai) had
`hubCandidateCount: 0, maxQualifyingOutlinkFanout: 0` on the real vault —
not "low", literally zero qualifying same-domain opener evidence, no matter
how many times the domain was visited. Confirms the prior note's hypothesis
exactly.

**Three new signals, all opener-independent, all structural** (no domain
list — see `learnedAggregatorStats.ts`'s own header for the exact gates and
thresholds):
- **(a) URL-population shape** — `deepSingleVisitUrlCount` (distinct
  `DEEP_PATH_MIN_SEGMENTS`-or-deeper paths seen exactly once) +
  `shallowHighRevisitUrlCount` (distinct `SHALLOW_PATH_MAX_SEGMENTS`-or-shallower
  paths revisited). Both required — this is what tells a hub-shaped
  population apart from a single-source blog with deep dated permalinks
  (many single-visit deep URLs, but nothing shallow ever gets revisited).
  The dominant fix for github.com/reddit.com/claude.ai's is-aggregator
  recognition.
- **(b) Keyword-concept entropy** — PR #385's counter, previously
  diagnostic-only, now consulted as a VETO (can turn a structurally
  hub-shaped domain into `not-aggregator` given low entropy + enough
  samples; can never manufacture a hub call on its own — see
  `MIN_KEYWORD_CONCEPT_SAMPLES_FOR_VETO`). Measured coverage on the real
  vault is thin (65 pages tagged; 5 on github.com, 0 on
  reddit.com/chatgpt.com/claude.ai) — this signal did NOT move the
  blind-spot domains' numbers directly, but is wired in correctly for when
  keyword coverage grows, and is unit-tested on synthetic fixtures either
  way.
- **(c) Shallow-path title churn** — the existing per-URL churn signal,
  aggregated across a domain's shallow paths specifically. Closed
  chatgpt.com's is-aggregator recognition (chatgpt.com already had
  `hub: true` from the original fan-out signal in some vault snapshots, but
  this signal is what qualifies domains — x.com in this vault's case —
  that have neither fan-out nor population-shape evidence).

**Opener-independent per-URL item inference, added alongside the domain gate.**
Once a domain is hub-qualified by ANY gate (fan-out OR population-shape OR
shallow-churn), a URL with a DEEP path and low self-fan-out is presumptively
an `item` even with zero opener/inbound evidence — the same reasoning signal
(a) uses at the domain level, applied per-URL. This is what actually
resolves individual github/reddit/chatgpt/claude.ai items that arrived via
external link or bookmark.

**Measured result (per-domain, registry-covered, real vault, 2026-08-21).**
Collapsed is-aggregator (feed|item vs. not-aggregator) agreement on
registry-covered domains: **73.3% → 98.7%**. `registryOnlyAggregatorCount`
(registry protects, learned doesn't — the dangerous under-protection
direction): **628 → 30** (95% reduction); the residual 30 are domains below
`MIN_DOMAIN_URLS_FOR_HUB` (medium.com: 3 URLs; gitlab.com/stackexchange.com/
stackoverflow.com: 1 URL each) or below the population/churn bars
(substack.com, t.co) — correctly conservative, and still fully protected via
the registry-fallback OR-combine (see below), never a regression.

**Disagreement-sample classification (the task's explicit bar: learned-wrong
≈ 0, not blind 100% agreement).** Sampled and attributed every remaining
`item→feed` disagreement on the four named blind-spot domains
(github.com 71, reddit.com 29, chatgpt.com 208, claude.ai 4): 96-100% of
each domain's disagreements trace to ONE cause — the PRE-EXISTING per-URL
title-churn-as-feed heuristic (not a new signal from this PR) misfiring on
platforms that inject volatile metadata into a page's `<title>` across
captures (reddit vote/comment counts, GitHub notification-count title
prefixes, ChatGPT/Claude.ai auto-renaming a new conversation after its first
exchange). This IS a genuine "learned-wrong" pattern, but it fails in the
SAFE direction the module's own binding cold-start rule explicitly allows
("wrong by over-suppressing... never wrong by under-suppressing") — it
quarantines a real item like a feed page, costing it some content-similarity
signal, never resurrecting the 2026-07-10 false-friend. A handful of other
disagreements (google.com's `/search` pages, ycombinator.com's `/item?id=`
pages, youtube.com's `/watch?v=` pages — all query-string-identity URLs, not
introduced or worsened by this PR) share a known, documented limitation:
`DEEP_PATH_MIN_SEGMENTS` is a PATH-segment count and is blind to
query-string identity. Left as a follow-up, not fixed here (fixing it
generically without a per-domain query-param allowlist is a harder problem
than this PR's scope).

**Serving flip — SCOPED, not a full replacement.** Per the measurement:
the IS-AGGREGATOR (hub) boolean is now consulted at serving time
(`ranker/candidates.ts`, `tabsession/similarity.ts`), OR-COMBINED with the
registry behind `SIDETRACK_LEARNED_AGGREGATOR_SERVE` (default ON, `=0` kill
switch reverts to byte-identical pre-task-#22 behavior). OR-combine means
this is STRICTLY ADDITIVE — quarantine protection can only be GAINED
(closing the blind spot: 677 hostnames on the live vault the registry has no
profile for at all), never lost (the registry's own 'feed'/'item' call
alone still fully quarantines, unconditionally). The FEED-VS-ITEM
sub-classification — which only matters when the separately-gated,
default-OFF `SIDETRACK_AGGREGATOR_ITEM_SIGNALS` narrowing is on — stays
REGISTRY-ONLY: the title-churn false-negative above means it is not yet
replacement-grade, and flipping it would have zero effect on default-flag
serving anyway (both call sites treat feed and item identically until that
separate flag is turned on). `aggregatorProfiles.ts` is NOT deleted or
deprecated — it is the fallback for every OR-combine and the sole decider
for feed-vs-item; a follow-up soak-and-measure PR is the earliest point to
revisit that.

## Columnar scan routing — design note (2026-08-18)

Binding user rule: design before code. Task #35, follow-up to
`perf/read-amplification` (2026-08-18 landing note above): PRAGMA cache/mmap
tuning gave the long-lived parent 2.4x (up to 3.35x) but cannot help the
reconcile CHILD — it forks fresh per drain (`SIDETRACK_CONNECTIONS_CHILD`
default `'1'`), so it never accumulates warm SQLite cache/mmap pages across
drains; under system memory pressure its window scans re-fault mmap'd
SQLite from disk every single time (measured 264MB/30s during one child
cycle vs 16MB/30s idle, per this task's brief). The structural fix: sealed
history already lives in zstd Parquet (`_BAC/seal/<replica>/<day>.parquet`,
`src/analytics/eventSeal.ts`, gated `SIDETRACK_EVENT_SEAL=1`, default OFF,
soak-pending per F2), and DuckDB-over-Parquet is a proven, already-
production read path (`src/analytics/eventScan.ts`'s `runSealIntegrityCheck`
— the sealed-vs-store integrity A/B that already runs after every sealer
pass — plus the 2026-08-01 PoC: 17x faster than a JS loop over sealed data,
22.9x compression). Columnar reads are also byte-cheap for reasons cache
tuning can't touch: column pruning (only `type`/`payload`/... columns
touched, not the SQLite row-store's full-row pages) + zstd compression, so
even a COLD read costs far fewer bytes than a cold SQLite page fault.

### API shape: watermark-split scan router

New module `src/analytics/sealedScan.ts` (columnar tier, stage 3 — the scan
router; stage 1 = `eventSeal.ts`, stage 2 = `eventScan.ts`). One exported
function following `EventStore.forEachChunkOfTypes`'s exact signature so it
is a drop-in replacement at call sites:

```
forEachChunkOfTypesSealAware(vaultRoot, store, types, cb, chunkSize, { consumer })
  -> Promise<{ sealedDays: number; hotDays: number; bytesEstimate: number }>
```

Per (replica, day) the router classifies using the SAME contract
`eventScan.ts`'s production integrity check already uses —
`store.sealDayStats(replica)` (existing, cheap aggregate) compared against
the seal manifest via `entryMatches` (exported from `eventScan.ts`, reused
verbatim, not reimplemented):

- **sealed-trusted** (manifest entry present AND `entryMatches` true against
  the LIVE store day-stats): read from Parquet, one DuckDB connection per
  call, ONE batched `read_parquet([...paths]) WHERE type IN (...)` query
  (not one query per file — amortizes DuckDB open/query overhead across
  however many sealed days match, per the brief's "must not cost more than
  it saves"; the 2026-08-16 spike measured 8.9ms open+query on a real sealed
  segment, negligible next to a multi-hundred-MB re-fault). On any DuckDB
  read failure (corrupt/truncated segment), the WHOLE call falls back to
  the pure-store path — correctness over performance, matching
  `eventScan.ts`'s own "a single corrupt segment must not hide a healthy
  one" posture but resolved conservatively (fail closed to the proven-correct
  path) rather than with per-file isolation, since this is a serving-path
  read, not an audit.
- **hot** (no manifest entry, OR entry present but stale/drifted — the
  benign `store-drift` case `eventScan.ts` already names): read from the
  store, day-bounded, via a NEW additive `EventStore.readEventsForDay`
  method (`src/sync/eventStore.ts`) — same `accepted_at_ms` index
  `readSealRows`/`sealDayStats` already use, so this never widens to a full
  scan; unlike `readSealRows` (which mirrors exactly what a seal WRITES —
  no `deps`/`target`/`hlc`, by design, since that's what the sealer needs)
  this returns FULL `AcceptedEvent` objects (real `deps`/`target`/`hlc`)
  so only the sealed portion pays the fidelity cost below, never the hot
  tail. Purely additive to `EventStore`'s interface — no existing method's
  behavior changes.

Both branches feed one shared row→event builder; results are merged,
sorted by `(replicaId, seq)` (matching `forEachChunkOfTypes`'s existing
order contract), and delivered to `cb` in `chunkSize` pieces with the same
`setTimeout(0)` yield the original method uses. `columnarScansEnabled()` —
`process.env['SIDETRACK_COLUMNAR_SCANS'] !== '0'` (kill switch, default ON,
per the brief) — is checked FIRST but gated behind `eventSealEnabled()`
(default OFF): on a default install nothing changes regardless of the kill
switch's value, because there is no sealed data to route to — the routing
function degrades to a byte-identical passthrough (`store.forEachChunkOfTypes`)
whenever the seal tier is off or the manifest is empty for the requested
scope. Every call that reaches the routing logic (seal on, manifest
non-empty) prints `[scan.columnar] consumer=<name> sealedDays=N hotDays=M
bytesEstimate=<parquet bytes actually stat()'d>`, throttled 30s per consumer
(mirrors `server.ts`'s `logResolverCandidateWindowTruncated` idiom — an HTTP
route consumer can fire many times a second under a request burst).

### The `deps`/`target`/`hlc` correctness finding (binds the consumer list)

`AcceptedEvent` (`src/sync/causal.ts`) carries three fields the sealed
Parquet schema does NOT: `deps: VersionVector` (required), `target?:
TargetRef`, `hlc?: Hlc`. `eventSeal.ts`'s `SEAL_TABLE_SQL` / `seal_rows`
table is 7 columns — `replica_id, seq, type, accepted_at_ms, aggregate_id,
client_event_id, payload` — no `deps`/`target`/`hlc`, by design (that's
also exactly what `readSealRows`/`SealRow` mirror). A row reconstructed
from a sealed segment can only ever produce `deps: {}` (empty
VersionVector — required by `isAcceptedEvent`'s structural check) and
`target`/`hlc` omitted. Extending the seal schema to carry these three
fields is a WRITE-path/versioning change (new columns, re-seal of any
already-sealed history, a verify-or-abort format bump) — out of this read-
routing task's scope, and its own soak story on top of F2's still-pending
soak.

This is not academic: grepping the whole package (not just the connections
subtree) for `.deps`/`.target`/`.hlc` on `AcceptedEvent`-typed values found
**exactly two consumers outside `sync/`'s own causal/anti-entropy
internals**, both load-bearing:

- `src/sync/contract/connectionsMaterializer.ts:3304` —
  `timelineObservedEventFromNavigation` synthesizes a NEW
  `BROWSER_TIMELINE_OBSERVED` event from a `NAVIGATION_COMMITTED` event and
  copies `deps: event.deps` / `hlc: event.hlc` FORWARD into the synthesized
  event (the foreground-navigation overlay memory note references this same
  code path, ~line 7398 pre-refactor numbering). This event gets ingested;
  a deps-stripped source would silently mint a synthetic event with wrong
  causal-dependency metadata — a lossless-by-construction violation.
- `src/threads/threadRegisterStore.ts` — persists `deps: event.deps` into
  `StoredThreadEvent` on ingest (`:263`) and round-trips it back via
  `toAcceptedEvent` (`:156`) for `projectThread` to fold; the header comment
  says the round-tripped event must be one `projectThread` "will classify
  and fold exactly as it would the original" — `deps` is read for real, not
  carried along inertly.

Both are reachable only from `connectionsMaterializer.ts`'s own drain logic
(the protected file's inlined `storeBackedEvents.readSince(...)` /
`typedEventSource.forEachChunkOfTypes(...)` calls at e.g. `:3788`,
`:2538/:2573/:3070/:6998/:7030/:7984/:8940`) — **never** from
`readEventsFromStoreOrLog` (`http/routeSupport.ts`) or from
`workGraphHealth.ts`'s health/feedback folds. A second full-package grep for
`.hlc` outside `sync/` returned ZERO hits; `.target` outside `sync/`
returned zero hits on `AcceptedEvent.target` (every match was an unrelated
`target` — payload fields, graph-edge `.target`, a systemd unit line).

**Consequence: (b) is NOT routed.** The reconcile child's catch-up window
read (`connectionsMaterializer.ts:3788`,
`storeBackedEvents.readSince(effectiveLastFrontier ?? {})`) is the read this
task's brief calls "the big one," and there is genuinely no external read-
layer helper for it to hook — the call is inlined directly on the
`EventStore` object obtained from `ensureEventStore()` inside the protected
file (confirmed: no `readEventsFromStoreOrLog`-style indirection exists for
this call site). The only way to route it without editing
`connectionsMaterializer.ts` would be to change `EventStore.readSince`'s
(and `forEachChunk`'s) OWN implementation in `sync/eventStore.ts` (not
protected) — but that method is shared by every caller in the codebase, and
at least two of those callers are confirmed to read `.deps` off objects it
returns. Routing it wholesale would silently corrupt `deps` for the
protected file's own foreground-navigation-synthesis and thread-register
paths the moment either reads a sealed day — exactly the kind of invisible,
hard-to-catch corruption "Lossless by construction" exists to forbid. This
is reported honestly rather than routed: the fix that WOULD make (b) safe
(add `deps`/`target`/`hlc` columns to the seal schema, re-seal, bump the
verify-or-abort format) is a real, identifiable follow-up, filed here for a
future task — not attempted in this one.

### Consumer table

| Consumer | Read | Routed? | Why | Sealed-day benefit |
|---|---|---|---|---|
| (a) candidate-generation timeline window (`server.ts`'s `timelineEventsForCandidateGeneration`, `SIDETRACK_RESOLVER_CANDIDATE_TIMELINE_WINDOW`, default 20,000) | `store.readMostRecentByType(BROWSER_TIMELINE_OBSERVED, window)` — DESC LIMIT, most-recent-N | **NOT routed** | Structural, not a safety call: most-recent-N by definition lands in the newest days first, which are by construction never sealed (today is never sealed; `runEventSealPass` explicitly skips `day >= today`). The bounded default path essentially never reaches back into sealed history on an active vault. | Measured (below): ~0 sealed-day bytes touched in the default-window harness run — confirms the brief's own "maybe NO benefit" hint honestly rather than routing for symmetry. The unbounded `window<=0` kill-switch branch (`forEachChunkOfTypes`, no day bound) is a real full-history scan and WOULD benefit the same way (c) does, but is an operator-opt-in edge case, not the default path — left unrouted, noted as a trivial follow-up (same helper, one more call site) if that branch ever matters in practice. |
| (b) reconcile child catch-up window (`connectionsMaterializer.ts:3788`, `readSince`, plus its other inlined `forEachChunk*` calls) | `EventStore.readSince` / `forEachChunk` / `forEachChunkOfTypes`, called directly on the raw store object | **NOT routed** — see finding above | Only interceptable by changing the SHARED `EventStore` method implementations, which would corrupt `deps` for two confirmed protected-file consumers (`timelineObservedEventFromNavigation`, `threadRegisterStore`) the moment they touch a sealed day. Real fix needs a seal-schema change (deps/target/hlc columns), out of scope. | Not implemented; this is the consumer the brief called "the big one" and the harness (below) reports the real, unrouted number for the record. |
| (c) health/aggregate full-history folds — `workGraphHealth.ts`'s `readEventsForHealth` (feedback / recall.served / recall.action probes, `readFeedbackEvents` etc.) | `store.forEachChunkOfTypes(types, cb, 2000)`, UNBOUNDED — the exact "full type-scoped history" shape sealed history helps most | **ROUTED** | Grep-verified: every caller of `readEventsForHealth` (lines 170/177/261/581/1681) feeds a projection/counter fold that only reads `.type`/`.payload`/`.acceptedAtMs`/`.dot`/`.aggregateId` — never `.deps`/`.target`/`.hlc`. Runs in the PARENT process (`runtime/companion.ts:1442` periodic tick, `http/routes/systemRoutes.ts:1021` `/v1/system/health` route) — never the reconcile child — so it does not inherit (b)'s risk profile at all. | Grows with vault age (this is the one probe the comment at `workGraphHealth.ts:550-554` already says blew the 5s health budget as a full `forEachChunk` before the type-index fix; a growing fraction of that type-scoped history is now sealed as F2 soak progresses). |
| `learnedAggregatorObservationEvents` (`workGraphHealth.ts:164`, `SIDETRACK_LEARNED_AGGREGATOR_WINDOW`, default 20,000) | `store.readMostRecentByType(...)`, most-recent-N (same shape as (a)) — only falls to `readEventsForHealth` when the window kill-switch is 0 | **NOT routed** (same reasoning as (a)); the `window<=0` fallback already routes for free once `readEventsForHealth` is routed, since it calls that same function. | Same recency-bound argument as (a). | Same as (a) — near-zero in the default-window case. |
| `readEventsFromStoreOrLog` (`http/routeSupport.ts`, 24 HTTP-route call sites: threads/dispatches/privacy/visits/feedback/recall/connections/annotations/tabsession/workstreams routes) | `store.forEachChunkOfTypes(types, collect, 2000)` when a type hint is given (every real call site supplies one) | **ROUTED** (the `types`-provided branch only; the untyped `forEachChunk` fallback branch is dead code today — zero call sites omit `types` — left as pure passthrough, not worth routing for a branch nothing exercises) | Grep-verified across all 24 call sites plus their route-layer projection functions (`projectFeedback`, `projectPrivacy`, `projectDispatches`, `distinctVisitDaysForUrl`, etc.): none read `.deps`/`.target`/`.hlc`. Runs in the PARENT process (HTTP request path), same as (c). | Type-scoped, so bounded by matching-row count already (per the module's own header comment); benefit scales with how much of that type's history is sealed. Not explicitly named in the brief's (a)-(d) list but is the same "scan-shaped serving-path read" class the task's own framing opens with — routed for the same proven-safe reason as (c). |
| keyword backfill (`enrichment/keywordBackfillLane.ts`) / sentence-embedding backfill (`enrichment/sentenceVectorBackfillLane.ts`) | `keywordBackfillCandidatesFromGistLookup` iterates an in-memory `GistLookup` Map; `gatherSentenceBackfillCandidates` iterates the connections snapshot's URL projection | **N/A — not event-store consumers** | The brief's premise (these enumerate populations via raw event scans) does not hold: both lanes walk already-materialized derived state (a gist-enrichment lookup, a snapshot projection), never `readEventsFromStoreOrLog` or the typed store directly. Reported honestly rather than routing something that doesn't exist. | None — no event-store read to route. |
| (d) analytics (`eventScan.ts`, `hotTailRetirement.ts`) | `read_parquet` directly | Already columnar | Nothing to do. | N/A |

The "Sealed-day benefit" column above is the PRE-MEASUREMENT expectation.
See "Measured" further below for the honest, post-measurement verdict:
both routed consumers (c, `readEventsFromStoreOrLog`) are implemented and
tested correctly, but do NOT show a reliable end-to-end byte reduction on
the one real vault available to test against today — ship gated behind an
opt-in flag, not the default-on this table's reasoning originally expected.

### Equivalence

Every routed consumer's correctness rests on the SAME proof
`eventScan.ts`'s production integrity A/B already runs continuously
post-sealer-pass: a sealed segment's `(rows, seqLo, seqHi)` triple, verified
at write time (`eventSeal.ts`'s verify-or-abort: written, re-read via
DuckDB, unlinked+aborted on any mismatch) and re-checked live on every
`runSealIntegrityCheck` pass, is compared against the live store's
`sealDayStats` for that day — the router uses that exact `entryMatches`
predicate to decide sealed-vs-hot per day, so it can only ever read a
sealed day the production integrity check would ALSO call `match`. New
test coverage (`sealedScan.test.ts`) adds one more layer on top: a
synthetic vault with sealed AND unsealed (open "today") days, verifying
`forEachChunkOfTypesSealAware`'s merged output deep-equals
`store.forEachChunkOfTypes`'s pure-store output on the fields every routed
consumer actually reads (`dot`, `aggregateId`, `type`, `payload`,
`acceptedAtMs`, `clientEventId`), plus an explicit per-source assertion:
sealed-day events come back with `deps: {}` and no `target`/`hlc` (the
Parquet schema gap, unavoidable), while hot-tail events keep FULL fidelity
(real `deps`/`target`/`hlc`, via a new additive `EventStore.readEventsForDay`
that reads real `AcceptedEvent` rows day-bounded, unlike `readSealRows`
which mirrors exactly what a seal WRITES) — the router does not degrade
more than the sealed portion structurally requires. Documenting the
fidelity cost precisely, per source, rather than hiding it inside a
loosened deep-equal. Also covered: kill switch (`SIDETRACK_COLUMNAR_SCANS=0`
→ byte-identical passthrough), seal-tier-off passthrough, corrupt-segment
fallback (whole call degrades to pure store, never partial/wrong data), and
store-drift (a late arrival after sealing is read from the hot path, not
the stale segment — same benign case `eventScan.ts` already names).

### Fallback

Three independent layers, each sufficient alone: (1)
`SIDETRACK_COLUMNAR_SCANS` default OFF (see the "Measured" section below —
revised from the brief's suggested default-on shape after real-vault
measurement showed default-on is not reliably a win today) — `=1` required
to opt in, `=0` or unset both revert every routed consumer to
`store.forEachChunkOfTypes` wholesale; (2) `SIDETRACK_EVENT_SEAL` default
OFF — on any install that hasn't opted into sealing, routing is a
structural no-op (empty manifest → passthrough) regardless of (1); (3)
per-call DuckDB read failure — falls back to the pure-store path for that
call, never partial data. No behavior change is possible without BOTH env
flags explicitly set to their non-default `1` value AND a non-empty seal
manifest.

### DuckDB connection lifecycle

Follows `eventScan.ts`'s own precedent exactly: short-lived,
`DuckDBInstance.create(':memory:')` → `connect()` → run → `closeSync()` in
a `finally`, one connection per call (not cached/pooled), batched into ONE
query per call (a path LIST, not one query per file) so a call spanning
many sealed days pays file-open overhead once, not once per file. This
task does NOT route the reconcile child's per-drain path (see the `deps`
finding above), so (c) and the `readEventsFromStoreOrLog` route-layer both
run in the long-lived PARENT process. **Revised after measurement (see
below): the DuckDB connection/query itself is cheap (8.9ms per the
2026-08-16 spike; confirmed again below), but the CLASSIFICATION step that
decides which days are sealed-trusted — `EventStore.sealDayStats` per
replica, needed to cross-check every day against the manifest — is NOT
cheap on a real vault (measured 200-300MB of kernel read per call,
dwarfing the DuckDB read it exists to gate). A per-vaultRoot classification
cache (`sealedScan.ts`'s `classificationCache`, invalidated on
watermark-or-manifest change) was added specifically to amortize this —
see "Measured" below for the full story, including why it still isn't a
clean win end-to-end on this vault today.**

### Measured (2026-08-18, real ~2.8GB test vault, 231 real sealed segments)

Two bugs found and fixed by measuring against `~/.sidetrack-vault-test`
(read-only clones only — the live companions were never touched), both real
and both worth keeping regardless of the final ship decision below:

1. **Missing compound index (fixed).** `readEventsForDay` (this task's new
   hot-tail read) and the PRE-EXISTING `readSealRows` (the sealer's own
   per-day read, used every sealer pass) both filter `WHERE replica_id = ?
   AND accepted_at_ms >= ? AND accepted_at_ms < ?`. With no
   `(replica_id, accepted_at_ms)` compound index, the planner falls back to
   `events_accepted_at_ms_idx` alone — a scan of EVERY replica's rows in
   that day's timestamp range, not just the requested replica's. Measured:
   227.7MB / 1054.5ms kernel read for one 4,766-row "today" (a live-
   capturing replica sharing the day with the harness's synthetic seed
   replica). Added `events_replica_accepted_at_idx` to
   `sync/eventStore.ts`'s `SCHEMA` (additive `CREATE INDEX IF NOT EXISTS`,
   builds once on next open, no migration risk) — same query afterward:
   0.00MB / 10.0ms. This fixes the sealer's OWN per-day read too, not just
   this task's new method — a pre-existing cost this task's measurement
   happened to surface.
2. **Uncached per-call classification (fixed).** The sealed-vs-hot split
   calls `store.sealDayStats(replicaId)` for every replica on every router
   call — an O(replica's total row count) aggregate (no index can avoid
   touching every row when bucketing by day). Measured 200-310MB per
   UNCACHED call on the real vault (dwarfing the ~20-40MB DuckDB read it
   gates). Added a per-vaultRoot memo (`classifySealedVsHot`'s
   `classificationCache`) keyed on a cheap signal —
   `store.watermark()` (a small single-table read) plus the seal
   manifest's line count (already read fresh every call) — that's cheap to
   check and only recomputes the expensive split when either changes.
   Measured: first call after store-open still pays ~200-310MB (unavoidable
   — this is the SAME cost `runEventSealPass` already pays once per hour
   for its own planning, just now also paid once per classification-
   generation instead of once per call); every repeat call with an
   unchanged watermark/manifest: 0.05MB. This directly answers the brief's
   "must not cost more than it saves" for the read-router's own overhead,
   not just the DuckDB connection (which was never the expensive part).

**End-to-end, honest result: on this vault, routing is a WASH, not a win.**
`scripts/read-amplification-harness.ts` extended with `seed --days-back N
--seal` (spreads synthetic backlog across closed days + pre-seals via the
built `seal --run` CLI) and a `healthPoll` phase (N `/v1/system/health`
calls BEFORE settle, so no drain-time artifact exists yet to short-circuit
a live `collectWorkGraphHealth` compute — isolates `readEventsForHealth`,
the routed consumer). Against the REAL vault (already had 231 sealed
segments from live F2/columnar activity — no synthetic seeding needed for
this comparison), both fixes applied, `SIDETRACK_COLUMNAR_SCANS=1` vs
unset (new default, see below):

| config | boot | healthPoll | settle | resolves | TOTAL |
|---|---|---|---|---|---|
| columnar on (`=1`) | 1283.8MB | 1135.3MB | 563.8MB | 451.3MB | **3434.1MB** |
| columnar off (default) | 1514.0MB | 818.9MB | 680.5MB | 440.5MB | **3453.9MB** |

0.6% smaller with routing on — within this machine's own documented noise
band (PR #400's report: >2x spread between nominally-identical trials on
this same loaded, shared dev machine). Earlier paired trials (before the
index/cache fixes, and again after, at smaller settle windows) swung
between "9.8% smaller" and "18.3% larger" run to run — no reliable
direction. The mechanism-level number IS real and reproducible (231/233
replica-days route to a deterministic ~20.3MB Parquet read instead of
whatever the store read would have cost), but it does not show through
cleanly end-to-end here, for three understood reasons: (a) this vault's
sealed segments are many SMALL daily files (237 files, avg 89KB) — DuckDB
pays real per-file overhead reading all of them in one query, and for a
RARE type (the exact shape `readEventsForHealth`/`readEventsFromStoreOrLog`
route) that overhead is comparable to or worse than PR #400's already-
mmap-tuned SQLite index scan for the same query (measured 4-11MB); (b) the
classification cache's benefit depends on a quiescent store between calls,
which does not hold during the post-boot window this harness's `healthPoll`
phase deliberately targets (background catch-up is often still draining);
(c) DuckDB-over-Parquet's proven win (F2 design note: 17x vs a JS loop) is
for AGGREGATE queries served largely from row-group statistics, or BROAD
scans that would otherwise touch most of a table — not a narrow, rare-type
row-fetch PR #400's mmap tuning already serves cheaply.

**Ship decision: `SIDETRACK_COLUMNAR_SCANS` defaults OFF (`=== '1'`
required), not the brief's originally-suggested `!== '0'` kill-switch
shape.** This is a deliberate deviation from the literal instruction,
justified by the measurement above: default-on would ship a feature that,
today, is a coin-flip on the one real vault available to test against —
not the honest "additive, proven win" bar this program's own principles
set. `SIDETRACK_COLUMNAR_SCANS=0` (and unset) both still revert to the
pure-store path, so the brief's specific claim about `=0` remains literally
true; `=1` is now required to opt in, matching `eventSealEnabled`'s own
"additive-only until proven" idiom exactly — the same reasoning
`SIDETRACK_EVENT_STORE` itself already uses (production-ready code,
conservative default) is the direct precedent. The code, equivalence
tests, and both fixes are real and worth keeping regardless: they are
correct today and become a clean win once either follow-up lands (segment
consolidation on the sealer side so a query touches fewer, larger Parquet
files; or a genuinely broad/unbounded consumer is found safe to route —
none qualified in this task's `deps`/`target`/`hlc` audit).

## Idle-window checklist (next window, ~04:30 or user-idle)

1. Sync ~/.sidetrack-companion-maintenance.sh from docs/runbooks copy.
2. Stop test companion → `compact-engagement --apply` (env-armed) →
   verify counts + restart → serving probes green.
3. Roll daily companion to main-tip build (one restart; snapshot warm
   makes it cheap).
4. Kick a fresh acceptance-sampler window; record numbers here.

## Landing notes (current state, dated)

**2026-08-21 — task #22: opener-independent hub signals, learned aggregator
to replacement grade on the IS-AGGREGATOR boundary
(feat/aggregator-shadow-close).** Closes PR #373's named blind spot: three
new opener-independent signals in `learnedAggregatorStats.ts` (URL-population
shape, keyword-concept-entropy veto, shallow-path title churn — see the
design note above for the exact gates) plus an opener-independent per-URL
item inference. Measured before AND after on the same real-vault snapshot
(`scripts/measure-learned-aggregator-stats.ts`, extended with a per-domain
breakdown + keyword-index/keyword-concepts join): collapsed is-aggregator
agreement on registry-covered domains **73.3% → 98.7%**;
`registryOnlyAggregatorCount` (the dangerous under-protection direction)
**628 → 30**. Sampled every remaining disagreement on the four named
blind-spot domains (github/reddit/chatgpt/claude.ai, 312 total
`item→feed` disagreements) and attributed 96-100% of each domain's count to
ONE pre-existing (not introduced by this PR) cause: the per-URL
title-churn-as-feed heuristic misfiring on platforms with volatile
in-`<title>` metadata — a safe-direction ("wrong by over-suppressing")
failure per the module's own binding cold-start rule, never a false-friend.
Serving flip is SCOPED: the is-aggregator boolean is now consulted at
serving time (`candidates.ts`, `tabsession/similarity.ts`), OR-combined with
the registry (`SIDETRACK_LEARNED_AGGREGATOR_SERVE`, default ON, `=0` kill
switch is byte-identical to before) — additive-only by construction, so it
cannot regress the registry's existing protection. The feed-vs-item
sub-classification stays registry-only (not yet replacement-grade, and
inert under today's default `SIDETRACK_AGGREGATOR_ITEM_SIGNALS=off` anyway).
`aggregatorProfiles.ts` is NOT deleted — it is the OR-combine fallback and
the sole feed/item decider. See PR body for the full per-domain table.

**2026-08-21 — F2 apply: hot-tail retirement (move-not-delete) + event-store
vacuum, CLOSES F2 (feat/f2-retire-apply).** The soak window named in the F2
row ("real-vault run: 185 shards, 178 eligible... APPLY still pending soak
(~Aug 21)") is now open (user-consented); this PR implements `--apply` to
the same safety bar as `compact-engagement --apply`, without touching
`connectionsMaterializer.ts`.

**Apply semantics (binding: no data loss).** Retirement is a MOVE, never a
delete: each eligible day's `_BAC/log/<replica>/<day>.jsonl` shard is
`rename()`'d to the sibling mirror `_BAC/retired/log/<replica>/<day>.jsonl`
— same filesystem, atomic, one syscall per shard. History for a retired day
stays served by the two sources already required `sealed-verified` before a
day is ever eligible: the typed event-store mirror (F3's hot read source)
and the sealed Parquet segment (`eventSeal.ts`). New exports on
`analytics/hotTailRetirement.ts`: `hotTailRetireArmed` (env arm switch),
`applyHotTailRetirement` (the apply loop), `retiredEventLogRoot` /
`retiredShardPath`, and `listCanonicalEventShards`.

**Reader-regression audit (the task's explicit ask — "verify what still
reads the hot JSONL for retired days").** Grepped every `_BAC/log` walker in
the package:
- `sync/eventLog.ts`'s `readMerged`/`readReplica`/`listReplicaIds` already
  tolerate an absent day file (ENOENT → `[]` / skip) — no code change
  needed, only a new test proving it (`hotTailRetirement.test.ts`, "readers
  still serve the full history after retirement"). `_BAC/retired` is a
  SIBLING of `_BAC/log`, not a subdirectory, so every `_BAC/log`-rooted
  walker excludes it BY CONSTRUCTION, not by an added filter.
- **Two live regressions found and fixed.** `gc/storageRetirement.ts`'s
  event-store-mirror retirement proof and `gc/ingressRetention.ts`'s
  ingress-spool-day proof each hand-rolled their own `_BAC/log`-only shard
  walk to reconstruct "the complete canonical event set" — both wired into
  the live `gc --storage-retirement` CLI command. Without a fix, the first
  F2-retired day would make both proofs see fewer canonical events than
  exist and (fail-closed, but WRONGLY) refuse candidates they used to
  verify — no data-loss risk, but a real regression of an already-shipped
  feature. Fixed by extracting `listCanonicalEventShards` (walks BOTH
  `_BAC/log` and `_BAC/retired/log`) into `hotTailRetirement.ts` and having
  both modules call it instead of duplicating the old helper. Regression
  tests added to both files' existing suites (move a canonical shard to the
  retired mirror out-of-band, confirm the proof still verifies).
- **One documented-but-dormant risk, not fixed.** `rebuildFromJsonl(logRoot)`
  / `catchUpFromJsonl(logRoot)` exist on 7 typed stores (event store,
  engagement-facts, timeline-facts, search-query-index, capture-text-fts,
  thread-register, workstream-parent) and each only walks the single
  `logRoot` it's handed. `grep -rn '\.rebuildFromJsonl\('` across the
  package (excluding tests) found ZERO production call sites — so no LIVE
  regression today — but `sync/lineage.ts` documents each as its store's
  cold-repair entrypoint. Flagged in both `hotTailRetirement.ts`'s header
  comment and `lineage.ts`'s `event-log` node: any future wiring (or an
  operator invoking one by hand) must catch up from BOTH roots, retired
  root FIRST (these stores gate re-ingestion below their own per-replica
  watermark as "out of order", so ingesting the newer hot root first would
  cause the older retired root's rows to be silently skipped).

**Safety rails (mirrors `compact-engagement --apply`).** Two independent
confirmations before anything moves: (1) `SIDETRACK_HOT_TAIL_RETIRE=1` —
`hotTailRetireArmed()`, the module's own arm switch, not a CLI-only gate;
(2) the vault's recall process-lock (`acquireRecallProcessLock`), refused
outright if a live companion owns it — same reasoning as compact-engagement
(a second process moving shard files while a live companion holds warm
append indexes / a merged-log memo over the same files would desync those
caches from disk). `applyHotTailRetirement` re-runs
`buildHotTailRetirementReport` FRESH at the top of every apply — never
trusts a caller-supplied report — and is fail-closed PER SHARD: one
tampered seal / drifted store / uncovered-events day is skipped, every
other still-eligible day in the same run still retires. Crash-safety:
each shard's move is one `rename()`, so a crash mid-run leaves some shards
retired and some not — both are valid states, and re-running recognises an
already-moved shard (source absent, destination present) as a no-op
success rather than an error. A found-during-implementation edge case, not
in the original brief: a late peer arrival can re-open a hot shard for an
already-retired day (`eventSeal.ts`'s own "late arrivals... re-sealed" note
documents this at the store level); if BOTH the hot and retired paths exist
for a day, apply refuses to `rename()` (which would silently overwrite the
retired file) and skips with reason `retired-destination-exists`, leaving
both files exactly as found — a deliberate reconcile pass, not a blind
move, was judged the only safe response, and is covered by its own test.
Receipts append to `_BAC/system/retirement-receipts.jsonl` (schema:
replica/day/before-after bytes+sha256/eventsSealed/eventsLive/movedAt),
bounded to the newest 20,000 lines via the same append-then-truncate-tail
idiom as `attribution-v1/shadow.ts`'s on-disk shadow log.

**Vacuum subcommand.** `event-store-vacuum --vault <path>` (new
`gc/eventStoreVacuum.ts`): opens `_BAC/connections/event-store.db`
read-write, runs `VACUUM`, reports bytes before/after. Same arm+lock
discipline (`SIDETRACK_EVENT_STORE_VACUUM=1` + recall process-lock refusal).
Separate from `connections/snapshot.ts`'s own VACUUM path, which is for the
CONNECTIONS GRAPH generation only and is a documented no-op under in-place
publish (see "Storage-tier incremental publish" design note above) — the
event-store mirror never had a dedicated maintenance entrypoint before this.
A clean no-op (not an error) when the file doesn't exist.

**Tests (all new, all green).** `hotTailRetirement.test.ts`: 7 apply cases —
moves eligible shards byte-identically + leaves a never-sealed day
untouched + excluded from next report's discovery; readers (readMerged +
typed store + sealed Parquet) still serve full history after retirement;
second run is a clean no-op; drift-fail-closed (tampered seal skips only
that shard); crash-resume (pre-moved shard recognised, remaining shard
completes); never-clobber guard (both paths existing → skip, both files
intact). `gc/eventStoreVacuum.test.ts`: arm-switch default-off, clean no-op
on an absent file, freelist reclaimed on a bloated fixture with a surviving
canary row proving no data loss. `gc/storageRetirement.test.ts` +
`gc/ingressRetention.test.ts`: one regression test each proving their
canonical-readback proofs still verify once a day has been F2-retired.
`cli.test.ts`: arm-refusal, lock-refusal (mirrors the existing
`compact-engagement`/`connections-rebuild` lock tests), happy-path +
idempotent re-run for both `retire-hot-tail --apply` and
`event-store-vacuum`. `npm run build` clean.

**Deviations from the brief.** (1) The retired-destination-exists guard
above — not specified in the original task, discovered while designing
crash-safety around `eventSeal.ts`'s documented late-arrival re-seal
behavior; judged necessary to hold the "never overwrite" invariant. (2) The
`rebuildFromJsonl` dormant-risk item above is flagged/documented rather than
fixed across 7 modules with zero production call sites — fixing unwired
code speculatively was judged out of proportion; it is now visible in two
places (`hotTailRetirement.ts` header, `lineage.ts`'s `event-log` node) for
whoever wires one next.

PR: feat(store): F2 apply — hot-tail retirement (move-not-delete) +
event-store vacuum (branch `feat/f2-retire-apply`). Not merged — coordinator
review pending per this task's "one PR; do not merge" instruction.

**2026-08-21 — F9 idle I/O floor: drain gating + child self-rusage
(perf/idle-drain-overhead, closes F9).** Task framing named
`engagement.interval.observed` as the idle-trickle culprit; instrumented
root-cause (not guessed) found a DIFFERENT, more precise offender.

**Root cause, code-verified in `src/sync/contract/connectionsMaterializer.ts`
(read-only — off limits for edits per this task).** `BROWSER_TIMELINE_OBSERVED`
(`src/timeline/events.ts`) is in the materializer's `HANDLES` set (graph-
affecting) AND is stamped `urgent: true` in `onAccepted`'s
`requestDrain({urgent: event.type === NAVIGATION_COMMITTED || event.type ===
BROWSER_TIMELINE_OBSERVED})`. Urgent bypasses `DEFAULT_DRAIN_MIN_INTERVAL_MS`
(30s) entirely (`startDrainWhenIntervalElapsed`'s urgent branch calls
`startDrain()` unconditionally) and forces `progressOnlyDirty = false`, which
rules out the cheap in-process `tryAdvanceNoGraphBacklog` path — so `drain()`
falls to `shouldUseWorker()` → `drainViaWorker()` and forks a full reconcile
child (`SIDETRACK_CONNECTIONS_CHILD` defaults `'1'`). At idle, an open tab
emits one `BROWSER_TIMELINE_OBSERVED` per ~30s dwell window even when nothing
about the page changed since the last observation — each one independently
forks a child. `ENGAGEMENT_INTERVAL_OBSERVED` (`src/engagement/events.ts`) is
already correctly routed through `CONTENT_LANE_ONLY_HANDLES` in that same
file — a cheap in-process progress advance, never a fork — so it was never
the dominant cost; it is still included in the fix below (batching it also
cuts its own small progress-write frequency) since the task named it
explicitly.

**Instrumented measurement (real forked child, real vault copy — the
`connectionsInPlaceChildDrainIntegration.test.ts` harness pattern, driven by
a throwaway spike script, not committed).** A COPY (`cp -Rc`, APFS clonefile)
of the live test companion's vault (`~/.sidetrack-vault-test`, 2.7GB,
read-only source, companion never contacted/restarted) with ONE new trivial
`BROWSER_TIMELINE_OBSERVED` event appended, then one real
`runReconcileInChild` pass, measured two independent ways that agreed: the
child's own `proc_pid_rusage` self-read at exit (new — see below) and an
outside poller (`createProcessTreeRusageTracker`) rooted at the test
process. **Result: 78.75s wall time, ~4.6GB read, ~663MB written, for ONE
event.** Per-file deltas identify WHERE: the connections generation db's WAL
grew **+328.76MB** (`[publish.in-place] channel=child bytes=328759520`), and
the visit-similarity HNSW index was rewritten **WHOLESALE** —
`visit-similarity-hnsw.v767.bin` (89.43MB) deleted, `v768.bin` (89.43MB)
written — for a single new visit, i.e. that derived artifact is NOT
delta-scoped. Two SQL statements in `replaceScopeRows`
(`connections/snapshot.ts`) also showed up as slow:
`deleteScopeEdges` 6.664s, `deleteOrphanEdges` 8.834s — both are
`DELETE FROM <116k/114k-row table> WHERE EXISTS (correlated on a
2-3-row temp table)`, which forces SQLite to `SCAN` the LARGE table (verified
via `EXPLAIN QUERY PLAN` against the same real generation-db copy). This is
NOT the historical #378 incident (that was the O(n×m) trigger bug, already
fixed by `idx_edges_index_src_dst`, confirmed present here) — it is a
SEPARATE, smaller, and — per `queryPlanLint.test.ts`'s own
`allowScanTables: ['connections_scope_edges' | 'edges']` entries for these
exact statements — an EXPLICITLY, DELIBERATELY accepted cost ("`edges`
itself has no usable equality predicate here … the accepted cost", that
test's own comment). A spike (`EXPLAIN QUERY PLAN` + timing against the same
real generation-db copy, `sqlite3` CLI, not committed) found a rowid-driven
rewrite (`DELETE FROM t WHERE rowid IN (SELECT c.rowid FROM small_temp s JOIN
t c ON …)`) cuts `deleteScopeEdges` from 0.701s to 0.013s — **54× faster**,
same row count deleted (SQLite's Bloom-filter join optimization lets it skip
non-matching big-table rows instead of visiting every one) — verified correct
on real data, NOT applied in this PR: changing it means revising a pinned,
incident-scarred regression test's stated policy
(`queryPlanLint.test.ts`'s `allowScanTables`), which deserves its own
reviewed PR, not a drive-by change bundled into a scheduling-gate PR. Filed
here as a concrete, ready-to-implement follow-up with the exact rewrite
pattern and measured number. `temp_store` tuning (suspect (a) in the task
brief) was audited and ruled out: every TEMP table in this hot path
(`temp_replace_scopes` etc.) holds a handful of rows per single-event drain,
far below where `temp_store` would matter; the ~330MB WAL growth and the 89MB
HNSW rewrite are the real, structural, measured causes. WAL-checkpoint-on-open
of OTHER writers' dbs (suspect (b)) was not confirmed as a factor — the read
volume is plausibly explained by the HNSW similarity corpus scan +
`replaceScopeRows`'s two big-table scans without invoking a separate
checkpoint-on-open mechanism.

**Fix layer 1 (primary, shipped): the idle drain gate,
`src/runtime/drainIdleGate.ts`.** Sits at the sync-contract-runner
registration boundary in `src/runtime/companion.ts` (NOT inside the protected
file — the only place reachable): wraps `connectionsMaterializer` before
`syncContractRunner.register(...)`, intercepting `onAccepted`. Trickle types
(`BROWSER_TIMELINE_OBSERVED`, `ENGAGEMENT_INTERVAL_OBSERVED`) are buffered —
never dropped — and replayed to the inner materializer's real `onAccepted`,
in original order, the moment EITHER a non-trickle event arrives OR
`SIDETRACK_DRAIN_IDLE_INTERVAL_MS` (default 15 min) elapses since the first
buffered event. This satisfies `materializer.ts`'s own contract rule #8
("a missed in-memory notification is always recoverable via `catchUp`'s
durable-state scan") — withholding the wake-up signal is not a drop, since
the durable event log already has the event the moment `EventLog.appendClient*`
accepted it. **Regression found and fixed mid-task:** a blanket type-based
defer broke `companion.test.ts`'s resolve-canary boot test, which seeds
exactly ONE `BROWSER_TIMELINE_OBSERVED` and expects a graph node within
seconds — a real, load-bearing freshness requirement, not incidental. Fix: a
**novelty-key exception** — the FIRST observation of a given `canonicalUrl`
is always forwarded immediately (exactly like today), regardless of type;
only REPEATS of an already-seen key are deferred. This is the behavior that
actually matches the root cause (a REPEAT dwell-ping on an already-open tab
carries zero new graph content; the first sighting of a genuinely new page
does). Bounded novelty-key cache (`DEFAULT_MAX_NOVELTY_KEYS = 20_000`,
FIFO-evicted) keeps this from becoming a second memory ratchet. Kill switch
`SIDETRACK_DRAIN_IDLE_GATE` (absent/non-`0` = ON, `=0` reverts to today's
behavior byte-for-byte — every event forwards immediately, same as no gate).

**Fix layer 2 (audible mark, shipped): child self-rusage report.** The
child's own `proc_pid_rusage` counters can only be read from INSIDE the
child, right before it exits — a dead pid can no longer be queried.
`src/process/procRusage.ts` (new; Darwin-only, best-effort, mirrors
`scripts/lib/procRusage.ts`'s proven offsets but lives under `src/` since
`tsconfig.build.json`'s `rootDir` excludes `scripts/`, and the child entry
script IS shipped in `dist/`) adds `readOwnDiskIoRusage()`.
`connectionsReconcileChild.entry.ts` calls it right before both its
success and failure exit points and `console.warn`s
`ioRead=<bytes> ioWrite=<bytes>` — the parent's existing stdout/stderr relay
(`connectionsReconcileChildClient.ts`) already prefixes every child line with
`[reconcile.child] `, so the combined line reads
`[reconcile.child] ioRead=… ioWrite=…`, matching the task's ask, with zero
double-tagging. `procRusage.ts`'s `createProcessTreeRusageTracker` (also new,
reused by the acceptance fixture below) had a real bug found while writing
that fixture: it originally reported a tracked root pid's RAW CUMULATIVE
rusage, which is correct for a freshly-spawned root (the harness's own usage)
but wildly wrong for a long-lived shared root (e.g. `bun test`'s own runner
process after hundreds of prior tests) — fixed by baselining the root's
counters at tracker-creation time and reporting a delta, covered by a new
regression test that inflates the process's own cumulative write count
before creating the tracker and asserts the tracker doesn't see it.

**Fix layer 3 (NOT attempted, per findings): the two structural per-cycle
costs found above (HNSW full rewrite, `replaceScopeRows`'s accepted-cost O(n)
scans) are NOT delta-gated in this PR.** The HNSW persist-on-every-graph-
touching-drain decision lives inside the protected materializer file — not
reachable. The `replaceScopeRows` rewrite is reachable (not protected) and
verified 54× faster, but changing `queryPlanLint.test.ts`'s explicit
`allowScanTables` policy is a deliberate, separate decision this task did not
have the mandate or review bandwidth to make safely — filed as a concrete
follow-up with the exact fix and measured number, not silently skipped.

**Acceptance fixture, committed (`src/sync/contract/
connectionsIdleDrainRusage.test.ts`).** Runs against a SYNTHETIC (small,
fast, CI-portable) vault, not a copy of a real developer vault, so it is a
permanent, reproducible regression guard — the real-vault numbers above are
the one-time investigation this fixture does not attempt to reproduce (a
synthetic vault's tiny tables make the same code paths cheap by
construction). Drives the REAL forked `connectionsReconcileChild.entry.js`
(same harness pattern as `connectionsInPlaceChildDrainIntegration.test.ts`,
requires a built `dist/`) through one real single-trivial-event drain,
asserts the child's self-report and the outside tracker agree, and asserts
total generation-db file growth for that one event stays **<5MB** (measured:
**0.054MB**). `drainIdleGate.test.ts` (new, 14 cases, fake timers) proves the
gate mechanism directly: 10 trickle events fired in quick succession
coalesce into **at most 1 flush** to the inner materializer — the unit-level
proof of the task's "10 trickle events → at most 1 child spawn" acceptance
criterion (a real end-to-end fork-counting test was considered and NOT built
— see Deviations).

**Full verification.** `bun test`: 3855 pass / 8 skip / 0 fail across 418
files (was 3833/8/0/415 files pre-PR — +3 new files, +22 new tests, zero
regressions; the new idle-drain fixture flaked once under full-suite load
before the tracker baseline fix above, reproduced and fixed, then reran
green both in isolation ×3 and inside the full suite). Root `bun run build`
clean across companion/extension/mcp. `tsc --noEmit` unchanged at 152
pre-existing errors before and after (verified via `git stash`), none in any
touched file. `eslint` clean (0 errors, 0 warnings) on every touched/new
file.

**Deviations from the task brief, stated plainly.** (1) The root cause is
`BROWSER_TIMELINE_OBSERVED`, not `ENGAGEMENT_INTERVAL_OBSERVED` as named in
the brief — reported honestly per "evidence before conclusions"; both are
included in the gate's trickle-type set regardless. (2) Fix layer 2's
per-cycle overhead fix (temp_store/checkpoint tuning) was audited and found
NOT to be the dominant cause here — the real structural cause (HNSW
full-rewrite, protected-file-only) and a real-but-deliberately-unshipped fix
(replaceScopeRows rowid rewrite) are reported instead, per "retract premises
when data disagrees." (3) The novelty-key exception was not in the original
design — found by a real regression (companion.test.ts), fixed, and is now
load-bearing; without it the gate would silently break "a genuinely new page
shows up promptly." (4) No real end-to-end fork-counting test was built
(would require spying on `child_process.fork` across an ESM module boundary
under `bun test`, or a slow real-companion-boot harness); the acceptance
criterion is instead proven at the mechanism level (drainIdleGate.test.ts,
deterministic, fast) plus one real single-event fork (connectionsIdleDrainRusage.test.ts)
— reported as a scope choice, not hidden.

**2026-08-18 — columnar scan routing (perf/columnar-scan-routing, task #35,
follow-up to read-amplification below).** New `src/analytics/sealedScan.ts`
routes type-scoped scans through DuckDB-over-Parquet for sealed days + a
day-bounded store read for the hot tail, gated by a full `deps`/`target`/
`hlc` consumer safety audit (design note above, "Columnar scan routing").
Routed: `http/routeSupport.ts`'s `readEventsFromStoreOrLog` (24 HTTP-route
call sites) and `system/workGraphHealth.ts`'s `readEventsForHealth`
(full-history feedback/recall fold). NOT routed: the reconcile child's
catch-up window (`connectionsMaterializer.ts:3788` — a shared-`EventStore`-
method change would silently corrupt `deps` for two confirmed protected-
file consumers; would need a seal-schema change, out of scope) and the
two recency-bounded consumers (candidate-generation timeline window,
`learnedAggregatorObservationEvents` — structurally never reach sealed
history). Two real bugs found and fixed while measuring against
`~/.sidetrack-vault-test` (read-only clones only): a missing
`(replica_id, accepted_at_ms)` compound index (227.7MB→0MB for one hot-day
read; also fixes the pre-existing sealer's own per-day read) and an
uncached per-call sealed/hot classification (`store.sealDayStats` per
replica, 200-310MB uncached → 0.05MB on repeat via a new watermark+
manifest-keyed cache). Despite both fixes, END-TO-END the routing is a WASH
on this real vault (3434.1MB routed vs 3453.9MB default — 0.6%, within this
machine's own documented noise band) — root cause: 231 real sealed segments
are small daily files (avg 89KB), and DuckDB's per-file overhead reading
all of them in one query is comparable to or worse than PR #400's already-
mmap-tuned SQLite index scan for the RARE-type queries these two consumers
happen to need. Shipped anyway (code correct, equivalence-tested,
low-risk-additive) but **`SIDETRACK_COLUMNAR_SCANS` defaults OFF** (`=1`
required to opt in) — a deliberate deviation from the task brief's
suggested default-on kill-switch shape, justified by the measurement:
default-on would ship a not-reliably-a-win feature, contradicting this
program's "additive, proven" bar. Follow-ups identified, not attempted:
segment consolidation (fewer/larger sealed files) on the sealer side; a
seal-schema extension (deps/target/hlc columns) to make the reconcile-child
path safely routable. `scripts/read-amplification-harness.ts` extended
(`seed --days-back N --seal`, a `healthPoll` phase) for reuse by future
columnar-routing measurement. Full `bun test` 3833 pass / 8 skip / 0 fail
(415 files); root `bun run build` clean across companion/extension/mcp;
`tsc --noEmit` unchanged (152 pre-existing errors before and after, `git
stash`-verified, none in touched files). PR: perf(store): columnar scan
routing — sealed-history reads via DuckDB-over-Parquet (branch
`perf/columnar-scan-routing`).

**2026-08-18 — read-amplification: SQLite cache/mmap tuning on the three
hot stores (perf/read-amplification).** Not an F1–F7 item; filed here per
the "binding plan tracks reality" rule. Responds to kernel-counter LIVE
EVIDENCE (proc_pid_rusage, the same ops/proc-rusage-telemetry methodology
already landed in docs/runbooks/sidetrack-diskwear-hourly.sh): the daily
test companion read 46.2 GB in ~45 min of boot catch-up + topic pass +
embed backlog (writes were already fixed at 1.5 GB).

**Audit (before this change) — grepped `cache_size`/`mmap_size` across every
`PRAGMA journal_mode = WAL` block in src/: zero hits anywhere.** Every store
module (sync/eventStore.ts, connections/snapshot.ts ×3 DDL blocks,
recall-v2/store/sqlite.ts, page-content/store.ts, page-evidence/store.ts,
search-index/*, engagement/engagementFactsStore.ts,
threads/threadRegisterStore.ts, workstreams/*, timeline/timelineFactsStore.ts,
connections/repairQueueStore.ts, enrichment/keywordConceptStore.ts) sets only
`journal_mode = WAL` (+ `busy_timeout = 2500` on most) — bun:sqlite's
built-in default `cache_size = -2000` (2 MiB) and `mmap_size = 0` (mmap off)
apply everywhere. Real test-vault sizes (2026-08-17): event-store.db 956MB,
connections generation db 436MB, recall-v2 index.sqlite 153MB (+21MB WAL),
capture-text-fts.db 131MB, page-content.db 57MB, page-evidence.db 38MB.

**Fix — `src/storage/sqliteCachePragmas.ts`** (new module; pure, unit-tested
env→PRAGMA-SQL resolution, no I/O): a shared `SIDETRACK_SQLITE_CACHE_MB`
total heap budget (default 192MB, hard-clamped ≤256MB) split by on-disk-size
weight — eventStore 50%, connectionsGeneration 32%, recallV2Index 18%,
floored at 8MB/store — plus an independent `SIDETRACK_SQLITE_MMAP_MB` lever
(per-store defaults eventStore 1536MB, connectionsGeneration 768MB,
recallV2Index 256MB; env scales all three proportionally; 0 disables).
mmap is NOT drawn from the cache_size budget — mmap pages are OS-page-
cache-backed, not process heap, so they don't count against the ratchet
ceiling the same way and are reclaimable under memory pressure. MEASURED
(not assumed) during test-writing: this machine's linked libsqlite3
(Homebrew's, via setup-sqlite.ts's `setCustomSQLite`) enforces a hard
`SQLITE_MAX_MMAP_SIZE` ceiling of exactly 1073741824 bytes (1 GiB)
regardless of what's requested — so the 1536MB eventStore default is
honored as ~1GiB in practice here, still full coverage of the 956MB file.
Applied at 7 long-lived open sites in connections/snapshot.ts's
`#openHandleForRole`/`#reopenIfPointerChanged` (legacy current.db,
parent-reader, single-buffer — deliberately NOT the child-writer shadow or
any of the file's short-lived one-shot handles: in-place publish,
checkpoint, shadow-publish overlay, resolver-cache.db, which stay default
per the module's own scoping rule), 1 site in sync/eventStore.ts, 1 site
in recall-v2/store/sqlite.ts. page-content.db / page-evidence.db /
capture-text-fts.db were audited (see sizes above) but left untuned —
out of the task's explicit 3-store scope; capture-text-fts.db (131MB) is a
follow-up candidate given it's close in size to the connections generation
db.

**Harness — `scripts/read-amplification-harness.ts`** (new; `seed` then
`run` subcommands): seeds a real, valid AcceptedEvent JSONL backlog
directly into a synthetic replica's log shard (no companion involved),
then boots a REAL companion process (`child_process.spawn`, not an
in-process import) against a fresh APFS clone (`cp -Rc`) of that seeded
vault, attributing kernel disk-IO bytes (bun:ffi `proc_pid_rusage`,
RUSAGE_INFO_V4, offsets verified against the local macOS SDK's
`sys/resource.h`, not guessed) to three phases: **boot** (spawn → first
`/v1/version` 200), **settle** (fixed wall-clock window, background
catch-up/topic/embed-lane), **resolves** (N stratified `/v1/visits/:url/
resolve` calls). A process-TREE tracker (`scripts/lib/procRusage.ts`)
sums the companion's pid AND all live descendants, folding an exited
child's last-known counters into a running total — required because the
connections reconcile materializer runs in a FORKED CHILD by default
(cli.ts: `SIDETRACK_CONNECTIONS_CHILD` defaults to `'1'`); a parent-pid-only
measurement would silently drop most of the connections-generation-db read
volume every drain cycle.

**Methodology trap found and fixed mid-measurement:** the harness initially
pointed at `src/cli.ts` (raw TS source, matching scripts/resolver-
acceptance.ts's own convention). This silently broke the reconcile child
— its fork target (`connectionsReconcileChildClient.ts`'s
`defaultEntryPath()`) resolves a `.js` sibling next to the COMPILED file,
which only exists under `dist/`, not next to the `.ts` source — producing
an audible-but-easy-to-miss `[connections] catchUp failed: reconcile child
entry not found at .../connectionsReconcileChild.entry.js` on every
catch-up. The FIRST baseline run under this bug measured only 1747.8MB
read (livePids=1, no descendant ever observed) — a ~5× undercount of the
real number below. Fixed by pointing the harness at the built
`dist/cli.js`, matching this repo's OWN existing CI contract
(`.github/workflows/ci.yml`, companion job: "Typecheck + build dist
(child-process tests need it)" runs before `bun test`) — not a new
convention, just one this new script had missed. All numbers below are
post-fix (confirmed via a tight 50ms-interval `ps` probe showing the real
reconcile child's pid, plus its `[reconcile.child]` progress log lines,
once dist/ was used).

**Measured (workload: 4000-event seeded backlog + boot + 45s settle + 40
stratified resolves, on a fresh clone of the real ~2.8GB test vault; both
trials cloned from the SAME seed-base so the backlog is byte-identical):**

| config | replicate bytes read | mean | vs. baseline |
|---|---|---|---|
| baseline (no tuning) | 8764.3MB, 4135.9MB | 6450.1MB | — |
| tuned (cache+mmap, defaults) | 2618.0MB, 2792.3MB | 2705.2MB | **2.4×** (range 1.48×–3.35× across pairings) |
| cache_size only (`SIDETRACK_SQLITE_MMAP_MB=0`) | 4282.6MB | — | ~2.05× (1 rep) |

Tuned replicates were also visibly MORE stable (6.6% spread) than baseline's
(>2× spread between two otherwise-identical runs) — real value beyond the
top-line ratio on a shared, loaded dev machine (the live daily + live test
companions ran throughout this measurement session on the same host, per
this task's own "loaded machine" framing). The cache-only isolation trial
confirms mmap_size does real, additional work beyond cache_size alone
(architecturally expected: once mmap_size covers a file, SQLite serves
those pages directly from the mapping, bypassing its own pcache and the
read() syscall path entirely).

**Did not reliably clear the >5× target — reporting the real number, not
the aspiration.** Root cause understood, not hand-waved: the `boot` phase
reads ~830–930MB of genuinely NEW data (the seeded backlog materializing
for the first time) in EVERY trial regardless of tuning — cache/mmap only
pay off on repeated reads of a working set already touched, and first-touch
cost is a large, fixed fraction of this harness's 45s-settle workload. A
150s-settle spot-check (1 run each, not replicated) compressed the ratio
further rather than improving it (baseline 6742.6MB vs tuned 5466.7MB,
~1.23×) — most plausibly explained by non-determinism in exactly when the
reconcile child's cyclic work lands inside the settle-vs-resolve phase
boundary (baseline's own `resolves` phase varied 1532MB/18.9s to
5668.6MB/62.4s between two otherwise-identical 45s-settle runs) rather than
tuning failing — but it wasn't replicated enough to separate signal from
machine noise with confidence, so it is reported as inconclusive rather
than folded into a headline number.

**RSS cost:** cache_size's heap contribution stays within the declared
≤256MB-total budget (verified by pragma read-back tests — see below).
Combined-config peakPhysFootprint rose to ~5.9–6.7GB vs baseline's
~4.4–6.9GB; the delta is dominated by RESIDENT MMAP PAGES for the full
event-store + connections-generation files while actively read — OS-page-
cache-backed and reclaimable under memory pressure (not permanent heap
growth the way an equivalent cache_size increase would be, which is why
mmap carries most of the tuning weight for the "memory ratchet" concern),
but real resident memory while the process works through a big backlog —
stated plainly rather than only citing the reclaimable/heap distinction.

**Redundant-scan check:** log-line attribution from a kept working copy of
a tuned run identified the settle phase's two dominant costs, neither a
miss requiring a fix: (1) page-evidence/store.ts's per-record `ensure`
loop (~line 611) processing ~4000 records — proportional to the seed's
genuinely-new page-evidence rows (its own 2026-07-29-incident comment
documents when this loop pathologically widens to a full-store scan; this
run's count, ~4005, matches the seed count, not a full-store size,
confirming the normal path); (2) connections/snapshot.ts's
`deleteOrphanEdges` (~line 7462, `[sql.slow] ms=1060`) — a scope-bounded,
temp-table-driven DELETE already hardened by the 2026-08-16 #378 incident
response (SQL-budget-wrapped, indexed, alarm-monitored). Neither lives in
connectionsMaterializer.ts (both are in files this PR was free to edit);
neither showed evidence of re-reading the same data more than once per
drain. No fix applied — documented per the task's "if it's already
correct, say so" framing rather than manufacturing a change.

**Tests:** `src/storage/sqliteCachePragmas.test.ts` (16 tests) — pure
env-resolution coverage (defaults, clamping, malformed-env fallback, 0 as a
valid "disable" value, per-store split/floor) PLUS pragma-actually-applied
coverage on REAL handles: a raw bun:sqlite `Database` (same API sync/
eventStore.ts and connections/snapshot.ts use) and the recall-v2
`SqliteDriver` (same API recall-v2/store/sqlite.ts uses), reading `PRAGMA
cache_size`/`PRAGMA mmap_size` back on the SAME live connection — the only
way a connection-scoped setting can be observed at all (a second connection
to the same file shows its OWN default, proving nothing about the first).
Neither `EventStore` nor `ConnectionsStore` nor `RecallStore` expose their
raw db handle (deliberate encapsulation), so these tests exercise the exact
underlying primitive each store calls `hotCachePragmaSql`'s output against,
not the class itself — the full existing suites for all three stores
(3817 pass / 8 skip / 0 fail package-wide) are the "does it work inside the
real store" check. `scripts/read-amplification-harness.test.ts` (6 tests):
pure `seedBacklog`/`stratifiedSample` coverage (JSONL validity checked
against the REAL `isAcceptedEvent` production validator) + one end-to-end
smoke test (real `seed` then `run` subprocesses, tiny empty-vault fixture,
300ms settle) asserting a well-formed 3-phase JSON report.

Verification: companion `bun test` 3817 pass / 8 skip / 0 fail (414 files,
`dist/` rebuilt first); full connections suite 549/549; `bun run build`
clean across all three packages (companion/extension/mcp); companion
`tsc --noEmit` unchanged at 150 pre-existing errors (confirmed identical
via `git stash` before/after — bun:test module-resolution + strict-mode
fixture gaps in files this task never touched, none in the 4 touched/new
files).

**Deviations from the brief:** (1) reduction target (>5×) not reliably
met — reported honestly above (2.4× mean, up to 3.35× best-case observed)
with the mechanism understood; mmap's clamp to a 1GiB ceiling on this
build's linked libsqlite3 is documented but not fixable from this codebase
(a libsqlite3 compile-time constant). (2) page-content.db / page-evidence.db
/ capture-text-fts.db audited but left untuned — out of the task's explicit
3-store scope, flagged as follow-up. (3) redundant-scan check found nothing
needing a fix in reachable code (see above) rather than the one-fix-found
outcome the brief anticipated as a live possibility.

PR: perf(store): kill read amplification — measured SQLite cache/mmap
tuning (branch `perf/read-amplification`).

**2026-08-17 — single lane registry: derived unions/allowlists/labels + all-
lanes render contract test (feat/lane-contract-registry, task #29).** Not an
F1–F7 item; filed here per the "binding plan tracks reality" rule. Closes a
validated review finding: adding guess-lane 9 ('prototype', PR #377) required
FOUR manual hand-edits across the two packages (companion's `GuessLane` union,
extension's `VALID_LANES` parse whitelist, `OPTIONAL_LANE_ORDER` +
`LANE_SHORT_LABEL` in PipelineStrip.tsx, `LANE_LABEL` in GuessLanes.tsx) with
ZERO compile/test guarantee tying them together — the lane shipped
server-side and was silently dropped TWICE (parse allowlist, then render
order) in one day, both times a live bug report rather than a build failure.

Registry location: no build-shared package exists between the companion
(Node/Bun server bundle) and the extension (WXT/browser bundle) — they ship
as fully separate bundles with zero cross-package imports today (checked).
Rather than introduce a new shared workspace package for nine constant
objects, the fix keeps ONE canonical file per package —
`packages/sidetrack-companion/src/tabsession/laneRegistry.ts` and
`packages/sidetrack-extension/src/sidepanel/tabsession/laneRegistry.ts` —
each exporting an identical `ATTRIBUTION_LANES` object (`{ order, shortLabel,
longLabel, behavior: 'decision'|'observe', alwaysVisible }` per lane) plus a
generated snapshot at `docs/contracts/lanes.json`
(`scripts/generate-lanes-contract.ts`, run from the companion's copy — the
source of truth) that BOTH packages' test suites (`laneRegistry.test.ts` in
each) assert deep-equality against. Drift on either side — or a hand-edited
JSON that no longer matches the companion — now fails at least one suite
immediately, at commit time, not in a live build.

Derived, no longer hand-listed: companion's `GuessLane` type + `GUESS_LANE_
ORDER` (the `alwaysVisible` lanes, `order`-sorted); extension's `GuessLane`
type (`keyof typeof ATTRIBUTION_LANES`), `VALID_LANES` parse whitelist
(`Object.keys`), PipelineStrip's `BASE_LANE_ORDER` / `OPTIONAL_LANE_ORDER`
(alwaysVisible split, `order`-sorted) and `LANE_SHORT_LABEL`, GuessLanes'
`LANE_LABEL` — all derived from the local registry copy. Zero behavioral
diff: `GUESS_LANE_ORDER`'s runtime value, the six-then-three render order,
and every label string are byte-identical to the prior hand-written
versions (asserted by the pre-existing suites, unmodified, all green).

New producer-to-render contract test
(`packages/sidetrack-extension/tests/unit/laneRenderContract.test.tsx`,
`describe.each(ALL_LANE_IDS)`): for EVERY registered lane, builds a
synthetic wire payload (untyped, as JSON — not a type-checked fixture) and
asserts (a) the real `parseGuessLanes` keeps it, (b) `GuessLanes`' disclosure
renders a labeled row with the candidate's workstream + why text, (c)
`PipelineStrip` renders a FILLED, correctly-labeled chip. This is the test
that would have caught both the 'ai' and 'prototype' incidents the day each
lane shipped, not after. 9 lanes × 3 assertions = 27 new tests, plus 4 mirror
tests per package.

Apple FM wire shapes (#377, task item 4): checked —
`appleFmEngine.ts`/`.test.ts` and its request/response types are
companion-only (`grep -rl appleFm packages/sidetrack-extension/src` → 0
hits, before and after this change). No extension-side duplication exists to
mirror; no action needed.

Verification: companion `bun test` 3702 pass / 8 skip / 0 fail (408 files,
rebuilt `dist/` first — the reconcile-child integration suite needs it and
was otherwise a false pre-existing-looking failure on a fresh worktree, not
a regression); extension `vitest run tests/unit` 1492 pass / 0 fail (164
files, includes the 31 new lane tests); both packages' `tsc --noEmit` clean
(the companion's own top-level `tsc --noEmit -p tsconfig.json` has ~50
pre-existing unrelated errors — `bun:test` module-resolution + a handful of
strict-mode fixture-type gaps in files this task never touched — confirmed
identical on a clean `origin/main` checkout before this branch existed);
both `bun run build` / `wxt build` clean. Deviations: none from the task
brief; the one implementation snag was Vite's static rewrite of
`new URL('../relative', import.meta.url)` into an `http://localhost/@fs/...`
dev-server URL (its asset-import special case), which broke
`fileURLToPath` in the extension's mirror test — worked around by resolving
`import.meta.url` to a path first, then joining with `node:path`, which
Vite doesn't intercept.

PR: feat(contracts): single lane registry — derived unions/allowlists/labels
+ all-lanes render test (branch `feat/lane-contract-registry`).

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

**2026-08-16 — SIGTERM shutdown watchdog + bounded recomputeScopes
(fix/shutdown-watchdog-and-scope-batch).** Not an F1–F7 item; filed here
per the "binding plan tracks reality" rule — two independent
post-restart operational-reliability bugs found live today, same PR/goal
(operator recovery after a restart).

*Item 1 — SIGTERM hang (root-caused, fixed, watchdog added).* Observed
twice live: SIGTERM closed the HTTP listener, then graceful shutdown
hung FOREVER — the process stayed alive (body-evidence lane cycles kept
logging), held `_BAC/recall/.lock`, and the next boot refused to start
("Another companion (pid N) already owns the recall index"). Operator
recovery both times required SIGKILL.

Root cause, confirmed by reading the exact call chain: `close()` in
`runtime/companion.ts` closed the HTTP listener then awaited
`syncContractRunner.awaitIdle()` — but never stopped the background
lanes that can append NEW accepted events (the R3 body-evidence
materialization lane, the background content-embedding lane, the
collector framework's promotion path). Each materialized item's
`onMaterialized` hook calls `eventLog.appendServerObserved(...)`, which
synchronously feeds `syncContractRunner.onAcceptedEvent` and re-marks
`connectionsMaterializer` dirty. `connectionsMaterializer.awaitIdle()`
is a bare `while (running || dirty) await sleep(5)` with no deadline —
as long as a lane keeps producing dirty-triggers faster than a drain
settles, the loop never sees both conditions false at once. The
`teardown[]` array these lanes' `.stop()` calls were registered on is
ONLY drained on the startup-FAILURE rollback path (`catch` block, never
reached once boot succeeds) — nothing had ever called `lane.stop()` on a
normal SIGTERM shutdown.

Fix (a), root cause: `close()` now stops every background lane/scheduler
(body-evidence lane, background-embedding lane, collector framework,
anti-entropy, derived-revision GC, event-seal loop, SQLite VACUUM GC,
event-loop monitor, the four drain-triggered health-artifact schedulers)
BEFORE closing the HTTP listener / draining the contract runner, and
stops the recall indexer + embedder child processes AFTER
`recallLifecycle.waitForRebuild()` (preserving the pre-existing,
deliberate ordering comment: drain → dispose materializer → wait
rebuild → release lock).

Fix (b), watchdog: `runtime/shutdownWatchdog.ts` (new). SIGINT/SIGTERM
now start `close()` under a bounded grace timer
(`SIDETRACK_SHUTDOWN_GRACE_MS`, default 15000; non-finite/≤0 falls back
to the default — 0 is NOT "unbounded"). If `close()` hasn't resolved
when the timer fires, it logs one line naming the stuck stage
(`companion.ts` now tracks a coarse `shutdownStage` string) and every
pending materializer (from `syncContractRunner.health()`), then
force-exits(1). A second SIGINT/SIGTERM while a shutdown is already in
flight skips the grace period entirely and force-exits(1) immediately.
`cli.ts` switched from `process.once` to `process.on` for both signals
so this state machine (not Node's default per-signal-once behavior)
owns the double-signal path.

Tests: `runtime/shutdownWatchdog.test.ts` (13 cases, dependency-injected
timers — no real `setTimeout`/`process.exit`) proves the watchdog
contract in isolation: grace resolution/fallback, clean-exit-0,
timeout-force-exit-1-with-diagnostics, double-signal-immediate-exit,
rejecting-close-force-exits, SIGINT/SIGTERM sharing one gate.
`page-evidence/bodyEvidenceLane.test.ts` gained a case proving the
mechanism `close()` now depends on: `stop()` called mid-cycle lets the
in-flight batch finish but schedules no further cycle. And a REAL
full-boot regression test, `runtime/companion.test.ts`'s "SIGTERM
shutdown drain" — real `startCompanion()` (real child processes, same as
production; `useChildProcesses` untouched), 6 real seeded body-evidence
queue items (>batchCap so the lane's own scheduler re-arms a second
cycle ~5s out, mirroring a SIGTERM landing on a still-backlogged lane),
asserts `close()` resolves <20s, the recall lock file is gone, AND — the
load-bearing check — that the lane's scheduled second cycle never fires
even 6s after `close()` resolves. Verified this test actually catches
the regression: temporarily disabling the two `stop*Lane()` calls made
it fail (`cycleLogCount` 1→2, a second cycle fired) in 6.1s; restoring
them made it pass. A true separate-OS-process `SIGTERM` (vs. calling
`close()` in-process) was evaluated and skipped as impractical within
budget — signal delivery/exit-code wiring is covered by the
dependency-injected watchdog unit tests instead; `close()` is the exact
function both paths call.

*Item 2 — recomputeScopes cost (root-caused, fixed; chunk-bound NOT
reachable, flagged).* Measured live during backlog catch-up:
`scopedDelta.recomputeScopes n=4781 nodes=4614 edges=81046 dt=723004ms`
— ~151ms/scope, 12 minutes inside one catch-up chunk (child process;
doesn't block serving but stretches post-restart catch-up to ~an hour).

Profile: the implementation (`recomputeScope`/`rowsForScope` in
`connections/scopeRecompute.ts` — NOT
`sync/contract/connectionsMaterializer.ts`, which this PR does not
touch) called `scopesForGraphRows` — a full O(nodes) pass plus TWO
O(edges log edges) sorts — from scratch on EVERY SINGLE scope, then
linearly filtered the whole nodes/edges arrays again to extract that
one scope's rows. `connectionsMaterializer.ts` calls `recomputeScope`
once per dirty scope, in a loop, against the SAME snapshot object,
across (at least) four independent call sites — so the whole operation
was O(scopes × (nodes + edges log edges)) when it only needs to be
O(nodes + edges log edges) once, shared across every scope.

Fix: build a per-scope node/edge index once per snapshot
(`buildScopeMembershipIndex`) and cache it in a `WeakMap` keyed on
snapshot object identity. `ConnectionsSnapshot.nodes`/`.edges` are
`readonly` and each drain constructs a genuinely new snapshot object, so
the cache is automatically correct (a new object is always a cache
miss — nothing can serve a stale index for mutated content) and
automatically bounded (entries are GC'd once a drain's snapshot goes
out of scope; no manual eviction, no size cap, no env gate needed). No
call-site signature changed — `connectionsMaterializer.ts` is
byte-identical.

Synthetic-scale measurement (`bun test`, ring-topology fixture,
`nodes=scopes`, `edges=scopes*edgesPerNode`):

| scopes | nodes | edges | uncached (old) | cached (new) | speedup |
|-------:|------:|------:|----------------:|--------------:|--------:|
| 400 | 400 | 2,000 | 513.8ms | 2.0ms | 252× |
| 1,200 | 1,200 | 9,600 | 7,192.9ms | 7.1ms | 1,011× |
| 2,400 | 2,400 | 28,800 | 42,783.3ms | 22.1ms | 1,939× |

Growth confirms the analysis (old ≈ quadratic-plus in scope count, new ≈
linear, dominated by the one-time index build). Extrapolating the old
curve toward the live incident's scale (4,781 scopes / 81,046 edges)
lands in the same tens-of-seconds-to-minutes order of magnitude as the
measured 723s (the synthetic ring topology and the real graph's degree
distribution differ, so this is a sanity check, not a precise
prediction) — same mechanism, same order of magnitude.
`connections/scopeRecompute.perf.test.ts` (new) carries this
measurement plus a byte-identical-output correctness proof against the
original filter-based implementation (kept inline in the test as
`rowsForScopeUncached`) and two cache-identity proofs (`WeakMap` build
count stays 1 across repeated queries of one snapshot; a fresh snapshot
object always triggers exactly one fresh build, never a stale hit).

*Chunk-bound (`SIDETRACK_SCOPE_RECOMPUTE_BATCH`, part (b) of the ask):
NOT implemented — genuinely not reachable without touching
`connectionsMaterializer.ts`.* "Cap scopes per chunk, carry the
remainder to the next chunk" is a property of the catch-up/drain loop
that calls `recomputeScope` in a `for`/`.map()` (which chunk a scope
belongs to, when "the next chunk" runs, where a carried-forward
remainder would be persisted so a crash mid-chunk doesn't drop it) —
all of that state lives inside the forbidden file, not in
`scopeRecompute.ts`. Given the caching fix above turns the per-scope
cost from ~151ms into microseconds (dominated by one O(nodes+edges)
build shared across the whole chunk), the specific 12-minute/4,781-scope
symptom this item was filed for should already be closed by item (a)
alone — a chunk bound would only still matter for a single snapshot
large enough that even the ONE index build is slow, which is a
materially different (and so far unmeasured) failure mode. Flagging per
the task's own contingency: everything reachable is implemented; the
chunk-bound is not, and should be revisited only if post-fix telemetry
(`scopedDelta.recomputeScopes` mark) still shows multi-second chunks.

PR: fix(runtime): SIGTERM shutdown watchdog + bounded recomputeScopes
chunks (branch `fix/shutdown-watchdog-and-scope-batch`).

**2026-08-16 — F2 hot-tail retirement report, report-only
(perf/f2-hot-tail-report).** OLAP candidate comparison done FIRST (see "F2
design note" above): the columnar tier already answered DuckDB-vs-chDB with
a measured PoC gate; this PR reuses that facade (`eventScan.ts`'s
`readSealedParquetDayStats` + `entryMatches`, newly exported) rather than
writing a second scan. New `src/analytics/hotTailRetirement.ts`:
`buildHotTailRetirementReport(vaultRoot)` computes, per (replica, day)
hot-tail JSONL shard, one of six verdicts (`sealed-verified`, `store-drift`,
`segment-corrupt`, `segment-missing`, `never-sealed`, `open`), events
sealed/live/uncovered, hot-tail bytes retirable (one `stat()` per shard —
never a line scan), and rolls up totals (shards eligible, bytes retirable,
segment alarms). Zero writes: the event-store mirror is opened
`new Database(dbPath, { readonly: true })` directly (bun:sqlite's readonly
open mode) — NOT `getCaughtUpSharedEventStore` (read-write, does catch-up) —
so the report never mutates the mirror and is safe alongside a live
companion (WAL readers don't block on a concurrent writer). Deliberately
does NOT gate on `eventSealEnabled()`/`eventStoreEnabled()` at CLI-invocation
time (unlike `runSealIntegrityCheck`, which is a live-companion health check
by design) — a report tool must read whatever is already on disk regardless
of the invoking process's own env, or an operator who forgets to export a
flag gets a silently useless report.

CLI: `retire-hot-tail --report --vault <path> [--json]` (src/cli.ts,
dispatch + help text). `--apply` does not exist — an explicit `--apply`
invocation is refused with a message naming the soak gate, rather than
silently no-op'ing or falling back to `--report`. `--json` emits ONE compact
line (no pretty-print, unlike sibling subcommands) because §6 of the
maintenance runbook appends it straight to a `.jsonl` history file.

Compaction-aware proof (the specific ask): a new describe block runs the
REAL F1 compaction pipeline (`planEngagementCompaction`/
`applyEngagementCompaction`) against a sealed day and proves three things in
one test: (1) before compaction, `sealed-verified`/eligible; (2) immediately
after compaction rewrites the JSONL (dropping receipt-covered interval
rows), the report reconciles via the manifest + parquet + store day-stats —
never a raw JSONL rescan — and classifies the day `store-drift` (benign,
blocked pending re-seal), with `segmentAlarms` staying 0 (the parquet
segment itself is untouched by compaction, so its own manifest-agreement
proof "still passes" — no false corruption alarm); (3) re-sealing restores
`sealed-verified`/eligible at the smaller, post-compaction byte size.
Tampered-seal counterpart (`eventScan.test.ts`'s existing pattern, mirrored
here): overwriting/deleting a sealed segment flips that day to
`segment-corrupt`/`segment-missing` — proof fails as designed, alarm
counted, sibling days unaffected.

Real-vault verification (`~/.sidetrack-vault-test`, read-only, zero
mutation confirmed by byte-identical `event-store.db` md5 before/after):
185 shards, 178 eligible, ~244MB (244,173,905 bytes) retirable, 0 segment
alarms, 6 `store-drift` shards (one replica, six days in
2026-06/2026-07 — plausibly the F1 engagement-compaction test run on this
vault dropping those days' interval rows to zero in the store mirror before
those days were re-sealed; consistent with the "benign, self-heals on
re-seal" design, not investigated further as it's outside this PR's scope),
1 open (today). ~3.6s wall time (includes bun/recall-v2 sqlite-lib startup).

Nightly wiring: docs/runbooks/sidetrack-companion-maintenance.sh gained §6
(report-only, ENABLED — not commented out, matching §5's compact-engagement
report-only precedent, since this is genuinely zero-write): human-readable
summary to the maintenance log, plus one compact JSON line appended to
`_BAC/system/retirement-reports.jsonl` per vault per run, pruned to the last
30 lines in the same run. Per the "*** NOT YET SYNCED" convention, §6 is
repo-only until a coordinator copies it into the live
`~/.sidetrack-companion-maintenance.sh` at deploy time —
`src/gc/vaultLedger.ts` and `connectionsMaterializer.ts` were not touched.

PR: perf(store): F2 report-only — hot-tail retirement report + compaction-
aware seal proofs (branch `perf/f2-hot-tail-report`).

**2026-08-16 — reconcile-child watchdog-loop KILLED
(fix/child-index-migration-loop).** LIVE INCIDENT, not an F1–F7 item —
filed here per the "binding plan tracks reality" rule. Since build
00601ff8, the test companion's connections reconcile child (forked per
drain, `SIDETRACK_CONNECTIONS_CHILD_NOPROGRESS_MS=1800000`) stalled with
its main thread 100% inside one `sqlite3_step`
(sqlite3VdbeExec → sqlite3BtreeNext → moveToChild → readDbPage → pread)
every time a scoped delta touched a large edge batch — sometimes
surviving just under the 30-minute watchdog (barely: one observed round
took `dt=1803371ms`, 3.4s OVER 1,800,000ms, saved only because a later
phase's per-row `.run()` loop happened to interleave enough JS-event-loop
turns for the child's 30s heartbeat to keep resetting the parent's
no-progress timer), sometimes not (pid 41415 was SIGKILLed after
exactly 1,800,000ms with no progress). A killed child's `BEGIN IMMEDIATE`
transaction rolls back completely, so the next forked child re-attempts
the identical expensive work from the identical starting state — for a
vault with enough backlog to need several large scoped-delta rounds, this
reads as "catchingUp never completes," matching the incident report.

PRIME HYPOTHESIS ENTERED AS: PR #368's `resolver_url` index +
`events_type_accepted_at_idx` migration in `sync/eventStore.ts`, on the
theory that a SIGKILL mid-`CREATE INDEX` rolls back and loops forever.
REFUTED with direct evidence: a `sqlite3 ... .backup` copy of the LIVE
`_BAC/connections/event-store.db` (957MB; copy took 2.6s, no live-process
disruption) showed both new indexes already present in `sqlite_master`,
`resolver_url` populated, migration fully complete. The hang is not there
— `getSharedEventStore`/`ensureEventStore` runs once at the START of
`buildAndWrite` (mark `w6 keys=N`), and the live phase log's last mark
before every stall was always `scopedDelta.carryForwardSimilarity`, deep
into the SAME `buildAndWrite` call, long after the event store had
already opened cleanly.

ACTUAL ROOT CAUSE (confirmed by reproducing the exact SQL against an
offline copy of the vault's connections snapshot db — `current.db`  via
`.backup`, isolated from the live process throughout): the next store
call after `carryForwardSimilarity` is `replaceScopeRows`
(`connections/snapshot.ts`). Its `edges_index` table (`edge_id ->
(src, dst, kind)`, used for O(1) edge lookups) is kept in sync by
`trg_edges_index_au`/`trg_edges_index_ad`, both of which run
`DELETE FROM edges_index WHERE src = OLD.src AND dst = OLD.dst` once PER
ROW touched on `edges`. `edges_index` had no index covering `(src, dst)`
— only a PK on `edge_id` and an index on `kind` — so that DELETE resolved
to `SCAN edges_index`: a full table scan, per trigger firing.
`deleteOrphanEdges` in one large scoped delta deletes tens of thousands
of `edges` rows; at this vault's live scale (edges_index ~107,007 rows)
that is O(deletes × 107,007) row comparisons — billions — comfortably
past the watchdog. Measured on the offline copy: the unmodified
`deleteOrphanEdges` statement was still running after 5+ minutes (killed,
never finished) against an 18,966-node/106,664-edge/107,007-edges_index-
row copy; after adding the missing index, the SAME statement completed in
2.279s. `EXPLAIN QUERY PLAN` confirmed the mechanism directly: before,
`SCAN edges_index`; after, `SEARCH edges_index USING INDEX
idx_edges_index_src_dst`. The same missing index also taxes the
per-row upsert loop later in `replaceScopeRows` (`trg_edges_index_au`
fires there too), just less catastrophically since that loop's many
small `.run()` calls interleave with the heartbeat — which is exactly
why some rounds survived the watchdog by a hair and others didn't.

Fix (one line, two locations — both of `snapshot.ts`'s schema-init
blocks: `#openDatabaseSerialized`, used by legacy/child-writer/
single-buffer opens, and `#initSchemaOn`, used for a parent-reader's
private write shadow):
```
CREATE INDEX IF NOT EXISTS idx_edges_index_src_dst ON edges_index(src, dst);
```
`IF NOT EXISTS` + running on every writable-handle open makes this
self-healing for every existing generation file (including the
per-drain shadow clones the child-writer/parent-reader roles create) the
next time it is opened writable — no separate backfill/migration path
needed, and the one-time index BUILD over existing rows is itself cheap
(sub-second at this vault's scale, confirmed on the offline copy).
`src/sync/eventStore.ts` was NOT touched — the prime hypothesis's target
was already correct and is a decoy for this incident, not a red herring
in general (it's a real, working migration for a different feature).
`connectionsMaterializer.ts` was NOT touched — the fix is entirely
inside `snapshot.ts`'s schema.

Deviations from the task's pre-written fix list (written against the
prime hypothesis, before it was refuted): items 1–3 (move migration to
the parent, make it resumable, guard `readByResolverUrls`/
`readMostRecentByType` against a missing index) do not apply — there is
no eventStore.ts migration bug to guard against. Item 4 (PRAGMA tuning)
was not needed — the index alone took the measured cost from "still
running after 5+ minutes" to 2.3s.

957MB event-store.db bloat, investigated per the task's ask (own copy
only, live db never touched): `PRAGMA freelist_count` on the copy is
99,202 of 244,756 total pages (4096-byte pages) — 40.5% free space,
~406MB reclaimable by `VACUUM`, which would bring the file to ~596MB.
That still isn't 236MB (the compacted JSONL log) — `dbstat` shows why
the remainder is mostly legitimate structure, not waste: the db holds
BOTH the raw `events` table (269MB) AND a separate `compacted_events`
mirror table (139MB) AND six maintained indexes on `events` plus two on
`compacted_events` (~155MB combined) — a raw+compacted dual-table design
plus index overhead, not a single 1:1 mirror of the JSONL. VACUUM to
reclaim the 406MB freelist is a legitimate, measured follow-up; NOT run
against the live db (CLI-gated, operator's call, outside this PR).

Tests: `connections/snapshot.replaceScopeRows.perf.test.ts` (new) — (1)
deterministic schema/plan assertion (`PRAGMA index_list('edges_index')`
carries `idx_edges_index_src_dst`; `EXPLAIN QUERY PLAN` on the trigger's
exact DELETE is `SEARCH`, never `SCAN` — no wall-clock, can't flake); (2)
a before/after ratio regression test (1,500-visit synthetic graph, index
intact vs. index dropped post-init) asserting the indexed run is >3x
faster than the unindexed one — generous margin so it doesn't flake on a
loaded box, same convention as `scopeRecompute.perf.test.ts`. Full
existing suite: `bun test` — 3284 pass, 8 skip, 0 fail, 366 files
(`sqlite-store.test.ts`, `connectionsMaterializer.test.ts`,
`doubleBuffer.acceptance.test.ts` etc. all green); `bun run build`
clean. (Bun's own known exit-time C++ panic fired AFTER the full-suite
summary printed — a pre-existing Bun 1.3.14 shutdown crash unrelated to
this change, not a test failure.)

Live corroboration (read-only observation of the still-running,
untouched test companion throughout — never killed/restarted per the
task's constraint): the phase log for pid 52610's second catch-up round
shows `replaceScopeRows scopedTimelineDelta scopes=4742 nodes=6092
edges=88806 ... dt=1803371ms` immediately following
`carryForwardSimilarity` — an exact, independent confirmation of both the
location and the ~30-minute magnitude of the bug, captured from
production telemetry rather than the offline repro.

PR: fix(store): index migration must not loop under the child watchdog
(branch `fix/child-index-migration-loop`) — title kept per the task's
instruction; the shipped fix targets `connections/snapshot.ts`, not an
eventStore.ts migration, per the root-cause finding above.

**2026-08-16 — SQL statement + phase budgets, CI query-plan lint
(feat/sql-budget-plan-lint).** GUARDRAIL, not an F1–F7 item — filed here
per the "binding plan tracks reality" rule, direct follow-up to the
reconcile-child watchdog-loop incident above. That incident's ONLY
signal was a 30-minute no-progress SIGKILL loop with zero attribution
(which statement? which table? which plan?) — most of a day was spent
finding the one `deleteOrphanEdges` call and the two triggers
(`trg_edges_index_au`/`_ad`) actually responsible. This change is the
standing guardrail so the SAME bug class (a missing index turning an
O(n) operation into O(n·table_size)) surfaces in seconds-to-minutes with
attribution, in production AND in CI, never again only via a 30-minute
kill loop. Three independent layers, each detection/attribution only —
none of them interrupt or kill a query (bun:sqlite has no
`sqlite3_progress_handler` binding, and killing mid-write is its own
risk class per the M7 hang-safety notes in
`connectionsReconcileChildClient.ts`):

1. **Statement budget (runtime).** `src/runtime/sqlBudget.ts` —
   `budgetedStatement(db, site, sql)` drop-in-replaces `db.query(sql)`,
   timing every `.run()`/`.all()`/`.get()` with a plain
   `performance.now()` diff (no async, no allocation on the fast path;
   measured overhead ~40-70ns/call, target <2µs/call, verified in
   `sqlBudget.test.ts`). Over `SIDETRACK_SQL_BUDGET_MS` (default `1000`)
   → one throttled `[sql.slow] ms=… site=… sql=<first 120 chars>` line
   + a per-site counter (never silently dropped — the counter still
   increments when the log line is throttled, so a statement stuck in a
   tight loop, the incident's own shape, cannot flood the log but also
   cannot hide). Over `SIDETRACK_SQL_BUDGET_HARD_MS` (default `60000`)
   → additionally runs `EXPLAIN QUERY PLAN` for the statement on the
   same handle, AFTER it completes, best-effort. Wired into
   `connections/snapshot.ts` first (the incident site) at its ~13
   hottest call sites — `replaceScopeRows`' delete-path statements
   (including the exact `deleteOrphanEdges` from #378), the resolver
   cache read/write, the resolver subgraph traversal reads, and the
   projection-accumulator upserts. Other bun:sqlite-backed stores can
   adopt incrementally — nothing in the module is connections-specific.

2. **Phase budget (child).** `src/runtime/phaseBudget.ts` —
   `checkPhaseBudgetExceeded(phaseDurations)` logs
   `[phase.budget-exceeded] phase=… dt=… budgetMs=…` for any phase over
   `SIDETRACK_PHASE_BUDGET_MS` (default `120000`). WIRING NOTE:
   `connectionsMaterializer.ts` was off-limits for this change (operator
   directive) and its `mark()` closure (the actual per-phase
   `[connections-phase]` emitter, `buildAndWrite`, ~line 3652) formats
   and logs inline with no shared utility to hook — so this is wired
   into `collectMaterializerDiagnostics` in `materializerDiagnostics.ts`
   instead, which `connectionsMaterializer.ts` already calls exactly
   once per drain with the SAME raw `phaseDurations` array `mark()`
   built. Trade-off, stated precisely: the alarm fires once the whole
   drain finishes, not the instant the slow phase's own `mark()` would
   have — acceptable because a phase wedged inside one synchronous
   bun:sqlite call (the incident shape) can't make `mark()` fire either
   until that call returns; the statement budget above is the layer
   that actually alarms DURING such a phase, seconds in, from the first
   slow statement. The existing no-progress watchdog remains the hard
   backstop; this and the statement budget are audible-drain-failure
   only — the log IS the alarm, never a throw, never a kill.

3. **Plan lint (CI).** `src/connections/queryPlanLint.test.ts` — opens a
   REAL `SqliteConnectionsStore(':memory:')` (the store's own
   schema-init DDL, never hand-copied), seeds ~4,000 rows per big table
   (`nodes`, `edges`, `edges_index` via the real triggers,
   `connections_scope_nodes/edges`, `connections_resolver_cache`, both
   projection-accumulator tables, `connections_applied_intervals`) so
   SQLite's cost-based planner is honest at real-vault shape, runs
   `ANALYZE`, then `EXPLAIN QUERY PLAN` over a 16-statement registry
   (file:line pointers + a "how to register a new one" comment live
   next to the array) and fails on any `SCAN <large-table>` not
   explicitly allow-listed for that statement's own (unavoidable)
   target. CRITICAL per the task's ask: trigger bodies are included —
   `trg_edges_index_ai/au/ad` are extracted LIVE from `sqlite_master`
   (never hand-copied, so they can't silently drift from production),
   split into their individual statements, and `OLD.`/`NEW.` references
   are substituted with a literal placeholder string
   (`/\b(OLD|NEW)\.(\w+)/gi` → `'query-plan-lint-literal'`) so each
   embedded statement can be EXPLAINed standalone outside a live trigger
   firing — EXPLAIN QUERY PLAN never evaluates row content, so the
   substituted value is irrelevant, only the resulting SQL shape
   matters. A dedicated regression test proves the lint catches the
   #378 bug class: it drops `idx_edges_index_src_dst` post-seed and
   asserts `trg_edges_index_au`/`_ad` NOW report `SCAN edges_index`
   (they don't with the index present). Ran against CURRENT main schema
   (already carrying the #378 fix): all 16 registry entries clean, zero
   additional unexpected scans found — `readIncidentEdgesForNodes`'s
   `src IN (…) OR dst IN (…)` resolves via SQLite's `MULTI-INDEX OR`
   (both `idx_edges_src`/`idx_edges_dst`), `deleteOrphanNodes`'s
   `IN (SELECT … FROM temp_replace_nodes)` resolves via an index-driven
   IN-operator rather than scanning `nodes` at all.

Registering a new hot statement: add an entry to `HOT_STATEMENTS` in
`queryPlanLint.test.ts` (SQL text + `sourceRef` file:line pointer +
`allowScanTables` only for a statement's own unavoidable DELETE/UPDATE
target) — see the comment block at the top of that file. Envs:
`SIDETRACK_SQL_BUDGET_MS` (1000), `SIDETRACK_SQL_BUDGET_HARD_MS`
(60000), `SIDETRACK_PHASE_BUDGET_MS` (120000) — all three re-read
`process.env` on every call (no caching, matching
`connectionsReconcileChildClient.ts`'s `noProgressTimeoutMs`
convention), so tests can flip them per-case without a module reload
and any process that mutates its own `process.env` at runtime (or is
launched with the var already set) picks the value up immediately.

PR: feat(runtime): SQL statement/phase budgets + CI query-plan lint
(SCAN tripwire) (branch `feat/sql-budget-plan-lint`).

**2026-08-16 — page-evidence embed lane rewired to F5 SQLite reads +
audible embed failures (fix/embed-lane-f5-read).** LIVE INCIDENT: the
test companion's embed lane logged `cycle embedded=0 failed=4 skipped=4
... quarantined=132` every cycle for hours straight after the F5 restart
(quarantine 12→180+ over the session), with no reason ever logged — a
silent-failure violation of the audible-drain-failure rule regardless of
cause.

PRIME HYPOTHESIS (a legacy file-path bypass F5 left dark, mirroring the
class of bug fixed in `recall-v2/store/backfill.ts`) was investigated and
**NOT confirmed**: `page-content/store.ts`'s and `page-evidence/store.ts`'s
own reads (`readPageContentExtractedPayloadForEvidence`,
`readRawPageEvidence`, etc.) are correctly SQL-backed already, verified
by direct reproduction against a COPY of the live test vault's
`page-content.db`/`page-evidence.db` — `bun.com/docs/...` and other
backlog head URLs DO have rows in both DBs with real extracted text. A
repo-wide sweep (grepping for `by-url`/`raw/`/`chunks/` path
constructions, direct `readdir`/`readFile` calls, and hand-rolled
`_BAC/page-content|page-evidence` joins outside the two store modules)
found **zero other legacy-layout readers** — F5's migration was complete;
`page-content/store.ts`, `page-evidence/store.ts`,
`page-evidence/bodyEvidenceQueue.ts` (a distinct, already-SQLite-adjacent
job-queue dir, not a data bypass), and every downstream caller
(`pageContentRoutes.ts`, `connectionsRoutes.ts`, `recall-v2/store/
backfill.ts`, `ranker/eval/lexicalBaseline.ts`, etc.) all go through the
exported SQLite-backed APIs.

ACTUAL ROOT CAUSE (verified by direct reproduction — a probe script
imported the real `store.ts` functions against a copy of the live DBs,
with a stub embedder logging every invocation): `page-evidence/
store.ts`'s `isCurrentEvidenceForEmbeddingCompletion` guard —
```
return record.updatedAt <= payload.extractedAt;
```
— compares the evidence record's `updatedAt` (bumped to the visit's
`lastSeenAt` by `writeMetadataOnlyPageEvidence`, called from
`ensurePageEvidenceForTimelineEntries` on EVERY timeline ensure/revisit,
even when it only carries the existing `content` block forward
unchanged) against `payload.extractedAt` (the FIXED original page-content
extraction timestamp the embed lane's backlog reconstruction,
`embedBacklogCanonicalUrl`, rebuilds every cycle). Any page revisited
after its original capture — ordinary browsing, not a bug in itself —
permanently pushes `updatedAt` past `extractedAt`, so this guard rejected
the completion BEFORE the embedder was ever called, every time, even
though the content (`contentHash`) was byte-identical. Live-vault
evidence: 394/771 (51%) of the genuine `indexed_chunks`/`embeddingState:
missing` backlog was blocked this way at time of investigation (SQL join
of `page-evidence.updatedAt` against `page-content.updated_at` per URL,
one copied-DB query); a probe with a correctly-dimensioned stub embedder
proved the embedder was NEVER invoked for guard-blocked URLs and
succeeded instantly for the rest — ruling out the embedder-poisoned-
session alternative hypothesis too (no ORT fatal error in the boot log;
`embed-lane-progress.json`'s `embeddedTotal`/`lastSuccessAtMs` show the
lane DID succeed historically, then stopped). This guard predates F5 by
three months (`e7bdba8b0`, 2026-05-24) — F5 didn't introduce the bug, but
correctly reading via SQLite made the backlog large/durable enough
(2,000+) for the pre-existing race to dominate every cycle.

Fix (`page-evidence/store.ts`): `isCurrentEvidenceForEmbeddingCompletion`
now treats `contentHash` equality as sufficient proof of "not stale" —
content-hash match short-circuits to `true` regardless of `updatedAt`
ordering; a hash MISMATCH still rejects exactly as before (the existing
"stale embedding completion" test — a genuinely newer capture landing —
still passes unmodified).

Audible failures: `embedBacklogCanonicalUrl` now classifies every
non-`embedded` outcome into a reason (`no-page-content`, `stale-guard`,
`embed-error`, `not-persisted`); `backgroundEmbeddingLane.ts`'s `runOnce`
accumulates a per-cycle `failedByReason`/`skippedByReason` histogram
(new fields on `BackgroundEmbeddingCycleResult`), logs the FIRST
occurrence of each distinct reason once (throttled — not once per
attempt), and the cycle summary line now reads e.g. `cycle embedded=3
failed=1 skipped=4 ... failedByReason=embed-error:1 head=...` instead of
a bare, unexplained count. `embedCanonicalUrl`'s return type stays
backward compatible (`'embedded' | 'skipped' | 'failed'` OR
`{outcome, reason}`) so the ~20 existing mock-based lane tests needed no
changes.

Boot-time requeue: `requeueQuarantinedEmbeddingBacklog` (new,
`store.ts`) runs once at boot, before the lane starts, and clears
attempt/quarantine bookkeeping ONLY for entries whose last recorded
failure reason is bug-caused (`stale-guard`, `not-persisted` —
`REQUEUE_ELIGIBLE_FAILURE_REASONS`); `no-page-content` and `embed-error`
are excluded so a genuinely-unembeddable record is never resurrected.
Wired into `runtime/companion.ts` right before `backgroundEmbeddingLane
.start()`.

Tests added: a read-path regression in
`backgroundEmbeddingLaneStore.test.ts` that writes real page-content +
page-evidence via the SQLite stores, simulates a revisit (bumps
`updatedAt` past `extractedAt` via `writeMetadataOnlyPageEvidence`), and
asserts the record now embeds (confirmed to FAIL without the fix,
classified `stale-guard`, before restoring it); audible-failure unit
tests in `backgroundEmbeddingLane.test.ts` (histogram construction,
throttled first-occurrence logging, thrown-embed classification,
backward-compat bare-string path); requeue tests (bug-caused reasons
cleared, genuinely-bad/unrecorded reasons left alone, one-time — a
second sweep requeues nothing further).

Verification: full page-evidence suite 73/73, page-content 52/52,
runtime 63/63, full package suite 3440+/3449 (two consecutive full runs;
the 2-3 failures were `http/visitsRoutes.test.ts` and `collectors/
framework/discovery.test.ts` — both unrelated to this change and green
in isolation, a loaded-machine flake plus a known Bun native-crash-on-
exit at process teardown after the summary already printed).
`typecheck`/`eslint`/`build` clean (zero new diagnostics; one pre-
existing `no-console` warning in `store.ts`'s unrelated port-log line
and one pre-existing unused-var warning in `companion.ts`, neither
touched by this PR).

Deviation from task framing: the prime hypothesis (a legacy file-path
read-miss) was investigated thoroughly and explicitly ruled out with
db-row evidence rather than assumed — the actual bug is a stale timing
guard, not an I/O bypass. Reason-category naming reflects that (
`stale-guard`/`not-persisted` instead of `read-miss`) while preserving
the requested audibility/histogram/requeue shape.

PR: fix(evidence): rewire embed lane to F5 SQLite stores + audible embed
failures (branch `fix/embed-lane-f5-read`).

**2026-08-16 — storage-tier in-place scoped publish, landed
(perf/in-place-scoped-publish).** Closes the design note above. Full
investigation, the empirical WAL-isolation spikes, and every design
decision are recorded there (written BEFORE implementation, per the
binding rule); this note records the SHIPPED result.

**What shipped.** `replaceScopeRows` (foreground-nav / catch-up scoped
deltas, called by both the parent process and the fork-per-drain child)
and `applyProjectionEventOverlay`'s parent-reader branch (the "overlay
twin") now apply their mutation directly to the CURRENTLY PUBLISHED
generation file under the cross-process publish lock — no
`copyFileSync`, no new generation id, no pointer flip — falling back to
the existing clone+CAS-flip path (byte-for-byte unchanged) whenever
in-place publish isn't applicable (disabled, no generation published
yet, or a TOCTOU race on the generation file). Full graph rewrites
(genuine content-signature changes), first-boot legacy migration,
kill-switch downgrade reconciliation, and any future structural schema
migration are UNCHANGED — they still choose a fresh generation
deliberately via clone+CAS-flip. `connections/contract/
connectionsMaterializer.ts` was not touched.

**Measured baseline (live vault, read-only, companion never
restarted).** `~/.sidetrack-vault-test/_BAC/connections/` held two full
437,288,960-byte generation files simultaneously, minted 37,712ms apart
during one active-browsing window, on a companion boot only 37 minutes
old — extrapolating that single fresh-boot rate across a day projects
~34 GB/day from connections-generation copy-on-publish churn alone (see
the design note for the full reasoning and caveats on this estimate).

**Empirical WAL-isolation verification (bun:sqlite 1.3.14).** Two
throwaway spikes (not committed) proved: (1) a reader with an open WAL
read transaction (or the store's existing plain-autocommit H6 pattern)
never sees a concurrent writer's uncommitted changes and is NEVER
blocked (`SQLITE_BUSY`) by a writer holding a transaction on the same
file; (2) one long-lived reader connection (matching the store's cached
`#db`) correctly tracks every subsequent writer commit across 5 rounds
of 100-row `SAVEPOINT`/`RELEASE` writes, with zero staleness. Full
detail in the design note above.

**Deviation from the task's literal "SAVEPOINT per publish" wording,**
flagged and justified in the design note: a bare `SAVEPOINT` cannot
precede the touched call sites' existing `BEGIN IMMEDIATE` without
SQLite's "cannot start a transaction within a transaction" error
(verified). Shipped instead: the caller's own existing `BEGIN
IMMEDIATE`/`COMMIT`/`ROLLBACK` block, completely unchanged, is the
atomic unit for each in-place publish — transactionally equivalent to a
top-level `SAVEPOINT`/`RELEASE` and the exact primitive every other
writer in this class already uses and is already tested against.

**Tests (`connections/inPlacePublish.test.ts`, new; 7 cases, all
mandatory categories from the task):**
1. **Crash-kill**: a real forked bun subprocess performs a 6,000-row
   scoped-delta in-place publish; the PARENT process SIGKILLs it at a
   randomized point (delay sampled from a measured, uncounted
   calibration run of the identical payload, spanning "before the write
   starts" through "after it should have committed"), N=20 iterations.
   Reopens a fresh store and asserts the scope's content is EITHER
   completely untouched OR completely and correctly replaced — never a
   partial/mixed state. Run 12× total during this PR (targeted reruns
   plus every full-suite/full-directory pass = 240 randomized SIGKILL
   trials across development), 0 torn states, every run also asserted
   `killedWhileRunning > 0` (proof the randomization actually landed
   mid-write, not just in dead zones).
2. **Concurrent reader isolation**: a raw `BEGIN DEFERRED` reader on the
   store's ACTUAL served generation file (not a throwaway db) is proven
   to hold its pre-publish snapshot throughout a concurrent in-place
   publish and past its commit, updating only once its own transaction
   ends; a second test races the store's own `readCurrent()` (H6 paged
   read) against 6 rounds of concurrent in-place publishes and asserts
   the base graph is never partially missing (the torn-read detector).
3. **Write volume**: a 60,000-node, 128,876,544-byte (~123 MiB) synthetic
   fixture; a 100-row in-place scoped delta wrote 238,992 bytes total
   (WAL growth + main-db page growth) — 0.185% of the fixture size, ~21×
   under the task's 5MB bound.
4. **Revision/write_seq equivalence**: an identical 4-step write sequence
   (full seed, scoped delta, single-event overlay, second scoped delta)
   run once with in-place publish on and once with
   `SIDETRACK_INPLACE_PUBLISH=0`; `readCurrent()` (nodes, counts,
   `snapshotRevision`) and `readMaterializerProgress` are asserted equal
   between the two runs.
5. **Generation GC**: 10 consecutive in-place scoped publishes leave
   `residentGenerations()` at exactly 1 (the seed gen) throughout — no
   accumulation; a separate case proves the full-rebuild clone+flip path
   (unchanged) still mints and GCs generations correctly (keep-window of
   2, oldest collected on the third rebuild).

**WAL checkpoint policy, shipped as designed and documented:**
`PRAGMA wal_autocheckpoint` left at SQLite's default (1000 pages);
`SIDETRACK_INPLACE_CHECKPOINT_IDLE_MS` (default 30,000) folds the WAL
back via `wal_checkpoint(TRUNCATE)` after that much quiet;
`SIDETRACK_INPLACE_CHECKPOINT_EVERY_N` (default 50) forces the same
independent of idle timing, for a vault under continuous activity.

**Residual, discovered by the crash-kill test, documented not
silently fixed**: killing a writer WHILE it holds the cross-process
publish lock (`current.publish.lock`) leaves it orphaned until the
existing `PUBLISH_LOCK_STALE_MS` (15s, unchanged, shared by every
publisher) staleness window passes — pre-existing machinery, but now
exercised far more often, since in-place publish holds this lock for
the FULL row-mutation transaction (the slow part) rather than only the
fast final flip (the old clone+flip design cloned OUTSIDE the lock).
Readers are completely unaffected either way (WAL readers never
contend on this lock or on a concurrent writer at all — see the
isolation verification above); only a SECOND writer landing inside that
same ≤15s window would wait. Not fixed here: `acquirePublishLock`'s
staleness check is time-based, shared by the pointer-flip CAS path too,
and improving it (e.g. pid-liveness, matching the in-flight generation
markers' pattern) is real, separable work outside this PR's scope.

**Verification**: `bun test` — 3422 pass, 8 skip, 0 fail, 3430 tests
across 378 files (Bun's known exit-time C++ panic fired AFTER the
summary printed, same pre-existing Bun 1.3.14 shutdown crash noted in
the prior landing note, not a test failure). `bun run build` clean.
`bunx eslint` on every touched file: 0 errors (pre-existing warnings
only, none introduced by new logic beyond style parity with existing
casts in the same file).

**Files changed**: `connections/generationBuffer.ts` (lock
acquire/release factored out of `withPublishLock`; new env-gate
helpers), `connections/snapshot.ts` (`#acquireInPlaceWriteHandle` +
checkpoint-policy helpers; `replaceScopeRows` /
`applyProjectionEventOverlay` wiring; new diagnostics counters),
`http/routes/systemRoutes.ts` (surfaces the new diagnostics counters),
`system/resolveCanary.test.ts` (updated fixtures for the new required
diagnostics fields), `connections/inPlacePublish.test.ts` (new, the
five mandatory test categories).

PR: perf(store): in-place scoped publishes — kill copy-on-publish write
amplification (branch `perf/in-place-scoped-publish`).

**2026-08-16 — in-place publish widened to the child-writer full-rewrite
channel, landed (perf/in-place-child-drain).** Closes the gap the design
note above's own scope left open: PR #381 made `replaceScopeRows` and
`applyProjectionEventOverlay` in-place-capable for EITHER writer role, but
deliberately kept `putCurrent`/`writeSnapshotAndProgress` (full
content-replace writes) on the clone+CAS-flip path for every caller,
every role. That full-write method turned out to be the DOMINANT publish
channel, not a rare one: `connectionsMaterializer.ts`'s
`catchUpDeferredThreadReconcile` → `forceFullRebuildForThreadReconcile`
runs exactly one full rebuild via `writeSnapshotAndProgress` at the end of
essentially every real catch-up that touched thread/workstream membership
(`connectionsMaterializer.ts:7426-7434`, `:9199-9211`) — i.e. routinely on
an actively-browsed vault, not rarely. Live evidence that motivated this
work: two new 437MB generation files 47 seconds apart during one active
catch-up window on build 79f2c8bd (which already includes #381) — the
scoped-delta channel was fixed, but this full-rewrite channel, reached by
BOTH roles, was still cloning on every hit.

**Handoff protocol (read, not changed).** The reconcile CHILD is a
one-shot `child_process.fork` of `connectionsReconcileChild.entry.ts`
(`connectionsReconcileChildClient.ts`'s `forkReconcileChild`): the parent
sends one `{kind:'reconcile', vaultRoot, seq}` IPC message, the child
re-instantiates its own `ConnectionsMaterializer`/`EventLog`/store
(`role: 'child-writer'`) against the vault path, runs `catchUp()` to
completion, posts `{seq, ok, snapshotRevision?}`, and exits. There is no
shared memory — the published generation file IS the handoff; the parent
(`role: 'parent-reader'`) picks up a pointer change via a cheap
`readPointer()` stat on its next read (`#pointerChangedSync`/
`#reopenIfPointerChanged`, snapshot.ts). A 30s-no-progress watchdog
(heartbeat every 30s from the child; `SIGKILL` on silence,
`connectionsReconcileChildClient.ts:75-83,438-455`) protects against a
wedged child; a pidfile (`.reconcile-child.pid`) lets the NEXT boot
`SIGKILL` an orphan left by a `kill -9` of the parent
(`cleanupOrphanReconcileChild`). None of this changed. What DID change:
under in-place publish, the child's full-rewrite write no longer needs
the handoff's generation-identity change at all in the steady-state case
— the published generation the parent is already polling for stays the
SAME file, so the parent's next `readPointer()` sees no change (correctly
— nothing to reopen) and its very next plain read (no held transaction)
observes the fresh content through the SAME already-open readonly handle,
exactly as the original design note's WAL-isolation proof establishes for
the scoped-delta case. TOCTOU generation-open retries
(`#openHandleForRole`) and the watchdog/pidfile machinery are unrelated to
this change and untouched.

**What shipped.** `putCurrent` and `writeSnapshotAndProgress`
(snapshot.ts) now call `#acquireInPlaceWriteHandle()` first, exactly like
`replaceScopeRows` already did, falling back to `#acquireGraphWriteHandle`
(clone+CAS-flip, byte-for-byte unchanged) only when in-place isn't
applicable. `writeMaterializerProgress`'s rare fresh-vault/degraded-
checkpoint fallback got the same treatment for completeness (it was
already a no-op widening in the common case — S1's generation-bound
progress sidecar handles the steady state without touching the graph db
at all). `#writeCurrentRows`'s row-level diff/upsert already ran inside
its own `BEGIN IMMEDIATE`/`COMMIT` with no schema DDL — the identical
shape `replaceScopeRows` already proved safe in place — so no changes to
the mutation logic itself were needed, only to which handle it's applied
against.

**Cross-process WAL + crash verification (this task's explicit ask,
empirical not assumed).** The shared mechanism
(`#acquireInPlaceWriteHandle`/`acquirePublishLock`) is identical between
the scoped and full-write channels, so the ORIGINAL design note's
spike-verified WAL isolation (a reader's plain autocommit read, or a real
open `BEGIN DEFERRED` transaction, never blocks on and never sees a torn
view of a concurrent in-place writer — bun:sqlite 1.3.14) applies
unchanged. Re-verified end to end for the WIDENED channel specifically:
`connections/inPlacePublish.test.ts` gained a second crash-kill case
(`describe('(1) crash-kill')`) that forks a REAL bun subprocess running
`writeSnapshotAndProgress` (not `replaceScopeRows`) against a 3,000-node
full-rewrite payload, SIGKILLs it at a randomized point sampled from a
measured calibration run, N=20 iterations — reopens a fresh store each
time and asserts fully-old (empty) or fully-new (exactly `PAYLOAD_N`
nodes, every label carrying the iteration's own prefix), never torn, and
that the generation the pointer names never changed across all 20 kills
(`readPointer()` pinned to the seed gen throughout — the in-place
invariant holding even under repeated SIGKILL). The publish lock's
existing 15s staleness window (`PUBLISH_LOCK_STALE_MS`, unchanged) frees
correctly after a kill mid-lock, same as #381's finding — not
re-timed here (would cost 20×15s), the orphaned lockfile is cleared
immediately once the killed pid is confirmed dead via `waitForExit`,
which is equivalent to letting real wall-clock time pass. `describe('(6)
audible publish marks')` adds four cases proving every publish (both
roles, both paths) emits its mark.

**Real end-to-end acceptance test (task's explicit ask — the REAL
child-drain flow, not a direct store call).**
`sync/contract/connectionsInPlaceChildDrainIntegration.test.ts` (new)
drives the ACTUAL production entry point: `runReconcileInChild` forks the
built `dist/sync/contract/connectionsReconcileChild.entry.js` against a
real `EventLog`, running the real `ConnectionsMaterializer.catchUp()` —
the exact process production spawns under `SIDETRACK_CONNECTIONS_CHILD=1`.
Sequence: 20 real events bootstrap the first published generation (clone
path — the one remaining legitimate first-write case); the SAME
generation is inflated to a realistic ~130MB fixture via a direct
row-preserving write (fast — avoids re-running the real embedding/
similarity/ranker pipeline just to pad bytes, while leaving the real
materializer's own progress/frontier state exactly as it left them so the
next catch-up resumes coherently); 100 more real events are appended; the
REAL reconcile child runs again. Result, measured through the real IPC
handoff: `readPointer()` unchanged, `residentGenerations()` byte-identical
before/after (zero new generation files), 534,496 bytes written for the
100-event delta against the 130,265,088-byte fixture (0.410% — well under
the task's 5MB/100-row bound), and the child's own log carries
`[publish.in-place] channel=child bytes=534496` — the audible proof this
went through the real materializer's branch selection AND landed
in-place, not just that the store method can do so when called directly.

**Audible engagement (task requirement — this is exactly the gap that let
the parent-only fix ship undetected).** Every publish now logs exactly
one mark: `[publish.in-place] channel=child|parent bytes=<walDelta>` on
success, or `[publish.clone] channel=child|parent reason=<reason>` when
falling back — `reason` is one of `legacy` (double-buffer off / `:memory:`),
`kill-switch` (`SIDETRACK_INPLACE_PUBLISH=0`), `no-generation-yet` (fresh
vault — the first-boot case), or `race-vanished` (TOCTOU). Both marks are
emitted from a single choke point inside `#acquireInPlaceWriteHandle` —
every clone-eligible write method now routes through it first, so there
is exactly one log site to keep honest rather than one per call site.

**Retained clone+CAS-flip cases (task's explicit ask — document each).**
1. The very first write to a fresh vault — no generation exists yet to
   open in place; `#acquireInPlaceWriteHandle` naturally returns null
   (`genId === null`) and the existing clone path seeds gen0, unchanged.
2. `SIDETRACK_INPLACE_PUBLISH=0` — the whole-suite kill switch, reverts
   EVERY write method (scoped, overlay, and now full-rewrite) to
   clone+CAS-flip byte-for-byte, re-verified by
   `inPlacePublish.test.ts`'s "(5) generation GC" kill-switch case.
3. `migrateLegacyToGeneration` (first-boot legacy migration) — a standalone
   `copyFileSync` operation structurally separate from any writer's publish
   path (runs before a generation is resolved), untouched.
   `reconcileLegacyToPublished` (kill-switch downgrade reconciliation) is
   ALSO retained as a clone (a plain file copy into `current.db`, not a
   generation), but it needed a REAL fix here, not just documentation: its
   pre-existing implementation assumed the source generation was ALWAYS
   already checkpoint-TRUNCATE'd (true under clone+CAS-flip-only — every
   published generation got a free checkpoint before the pointer ever named
   it) and used the pointer's genId alone as a "have I already reconciled
   this" staleness marker. Neither holds once the SAME genId can receive
   many in-place publishes: (a) in-place publish defers its own checkpoint
   (idle timer / every-N safety net), so the main `.db` file can be missing
   content still sitting in its `-wal` sidecar — a raw `copyFileSync` of the
   main file alone would silently downgrade to STALE content; (b) an
   unchanged genId no longer implies unchanged content. Fixed:
   `reconcileLegacyToPublished` now runs under the SAME cross-process
   publish lock every in-place writer holds, checkpoint-TRUNCATEs the
   source generation itself before copying (guaranteeing the main file is
   self-contained), and fingerprints its staleness marker on
   `(genId, post-checkpoint mtime)` instead of `genId` alone. New regression
   test: `generationBuffer.test.ts`'s "reconcileLegacyToPublished picks up
   in-place content changes on the SAME gen id (not stale, not falsely
   idempotent)" — an un-checkpointed WAL-mode write on an already-reconciled
   gen id is picked up correctly, and a genuinely unchanged repeat call is
   still a no-op.
4. Any future structural (non-`IF NOT EXISTS`) schema migration would
   still need to choose a fresh generation deliberately — the pointer-flip
   model exists precisely so readers can keep serving the OLD schema until
   they're ready to move; nothing in this change removes that escape
   hatch, it only stops taking it for ordinary content writes.

**Revision/write_seq equivalence — a REAL bug found and fixed here, not
just re-verified.** The persisted row content (`write_seq`/
`snapshotRevision`) is unchanged reasoning from the original design note:
both are pure `metadata`-table content, computed identically regardless of
which physical file they land in, and `inPlacePublish.test.ts`'s existing
"(4) revision/write_seq equivalence" case (exercising
`writeSnapshotAndProgress` in its 4-step sequence) passes identically with
`SIDETRACK_INPLACE_PUBLISH=0` vs default-on with no changes needed. BUT the
task's own warning — "the parent's readCurrent memo keys on
snapshotRevision... must bump such that the parent picks up the new state
exactly as it did on pointer flip" — caught a real gap: `#readCurrentAttempt`'s
in-process `#cachedSnapshot` memo was keyed on `metadata.snapshotRevision`
(snapshot.ts, pre-existing code, not introduced by this PR), a WEAK
content-hash of metadata-only fields that a caller may legitimately supply
unchanged across writes whose STRONG per-row content differs — exactly the
shape `#matchingPublishedContentSignature`'s own skip-vs-publish distinction
exists to handle, and exactly what
`doubleBuffer.acceptance.test.ts`'s pre-existing "unchanged ticks skip full
publish; one real content delta publishes once and stays atomic" case
constructs. Under the pre-widening clone+CAS-flip-only world this collision
was masked for free: a content-changing write ALWAYS minted a new
generation, and `#reopenIfPointerChanged`'s unconditional
`#dropCachedSnapshot()` on ANY pointer change busted the cache regardless of
which key it used. Under in-place publish the SAME generation (no pointer-
change signal at all) can legitimately serve new row content, so the cache
key itself has to be precise. **Fix**: `#cachedSnapshot`'s key is now
`write_seq` (via the already-existing `#readWriteSeq` helper), not
`snapshotRevision` — matching `#cachedDerivedProjections`'s existing
precedent, which already migrated to `write_seq` for this exact reason (F4
blob-diet). `write_seq` is strictly monotonic and bumped by `#bumpWriteSeq`
on every transaction that mutates `readCurrent`'s inputs, so it cannot
collide the way a caller-supplied weak revision string can. Caught by
re-running (not just re-verifying) `doubleBuffer.acceptance.test.ts` after
the store-level change — its "one real content delta publishes once and
stays atomic" case failed with `served label = "v0"` instead of `"v0
changed"` before this fix, and passes after. Three other pre-existing tests
in that file needed updating (not fixing — a correct consequence of the
widening, not a bug): they asserted a genuine pointer swap for a scenario
that now legitimately applies in place; each now forces
`SIDETRACK_INPLACE_PUBLISH=0` to keep exercising the swap-and-reopen
mechanism they're actually testing.

**Deviation from the task prompt.** The task asked for a fixture "<5MB on
a ~100MB fixture for a 100-row delta" via a spawned child process
applying a scoped delta. The shipped acceptance test's delta is 100
EVENTS (real timeline-visit captures through the real materializer, which
resolve to a handful of node/edge rows each plus HNSW/similarity
bookkeeping) rather than literally 100 pre-built graph rows — a closer
match to what the reconcile child actually processes per drain in
production, and the harder-to-satisfy bound in practice: even so it
measured 534KB, ~9× under the 5MB ceiling. The `#writeCurrentRows`-path
crash-kill case above uses a synthetic 3,000-node payload (not a spawned-
child scoped delta) specifically because it targets the FULL-rewrite
in-place path this PR adds, mirroring but not duplicating #381's existing
scoped-delta crash-kill coverage.

**Verification**: `bun test` — pass, 0 fail (see PR for exact counts on
the final branch state). `bun run build` clean. Every change confined to
`connections/snapshot.ts` and `connections/generationBuffer.ts` plus new/
extended tests; `sync/contract/connectionsMaterializer.ts` untouched, per
this task's binding constraint (verified by re-reading it, never edited).

PR: perf(store): in-place publishes for the child-writer drain channel
(branch `perf/in-place-child-drain`).

**2026-08-17 — disk-wear addendum: embed-cache write amplification killed
+ embed lane batched (perf/embed-cache-write-amp).** Not an F1–F7 item;
filed here per the "binding plan tracks reality" rule — same disk-wear
theme as F1's log compaction, different chokepoint.

*Traced evidence (user, 60s fs trace on the test companion, 2026-08-16/17).*
~350MB/min of writes, dominated by two paths: `_BAC/recall/v2/index.sqlite`
(+WAL) and `_BAC/recall/embed-cache.*`. `embed-cache.bin` was 14MB live; the
page-evidence background embed lane (unblocked the day before by #382) was
draining a 2,102-item backlog. Hypothesis to verify: the embed cache was
being fully rewritten every cycle.

*Verified write pattern.* Confirmed by reading `embeddingCache.ts`: `put`/
`putMany` read the WHOLE cache file, mutated one in-memory `Map`, then did a
tmp-write + atomic rename of the ENTIRE map back to disk — on every call,
regardless of batch size. `page-evidence/embedding.ts`'s
`writePageEvidenceDocEmbedding` called the cache TWICE per embedded page
(once via `putMany` for the chunk vectors, once via `put` for the doc
vector), so one embedded record cost TWO full-file rewrites: O(cache-size)
disk I/O to persist O(1) new data. Confirmed by a timed fixture
(`createEmbeddingCache` + 2,102 sequential single-entry `put` calls,
matching the traced backlog size): the OLD read-modify-full-rewrite design
would have written **~3,381MB total** to land a 3.22MB final cache (the sum
of the file's size after every write, since every write rewrote the whole
file) — a live measurement of the quadratic-in-entries shape, not an
estimate. Separately checked `_BAC/recall/v2/index.sqlite`
(`recall-v2/store/sqlite.ts`, not modified — owned by another in-flight
agent): `journal_mode = WAL` + prepared per-row `INSERT`/upsert statements
for `upsertDocument`/`upsertVector`/`upsertChunkVector`, no full-table
rewrite or reindex on the write path. That store's contribution to the
traced volume is legitimate O(work) (one embed → one row upsert, WAL pages
only the changed page) scaling with embed throughput, not a second
amplification bug — left untouched.

*Chosen design: append-only log + threshold-triggered compaction*, not a
new file format or a migration. The on-disk record format (`u32 headerLen +
JSON header`, then repeated `u32 hashLen + hash + dim*float32` records) was
already safe for a duplicate-key log — the read path folds records into a
`Map` sequentially, so a later record for the same hash already overwrote
an earlier one in memory. That meant zero migration: `put`/`putMany` now
APPEND only the incoming batch's encoded bytes when the on-disk model
identity is unchanged (one `appendFile` of just the new records); a first
write or a model-identity change still does a full rewrite, but of a fresh
(small) map, which was never the expensive path. Superseded on-disk records
(re-embeds, `migrateModel` runs) are tracked as accumulating "stale bytes"
per cache path; once they cross `compactionStaleBytesThreshold` (default
2MB), the next write compacts instead of appending, reclaiming the dead
space — the "periodic compaction" the file's own docstring had named as a
TODO for years. Crash safety: an append is not a single atomic rename, so
`readCacheFileUncached` now treats an incomplete trailing record (not
enough bytes left in the file for one more full record) as end-of-file
instead of discarding the whole parse — every record fully written before a
crash is still read back; the worst case is re-embedding the last in-flight
batch, acceptable because this file is a CACHE (the lifecycle rebuilds the
index from source content, never from this file). Two design options
offered by the task (batched write-behind; migrate to a small sqlite table)
were not chosen: write-behind would still write O(cache-size) per flush,
just less often (a constant-factor win, not the asymptotic fix the
`entries=N, NOT 20×file-size` acceptance bar calls for); a sqlite migration
would have meant touching schema/dependency surface for no gain once the
append design was available for free from the existing format.

*Batching.* The lane's default `batchCap` (visits per 4s cycle) raised
8 → 16, and made overridable via `SIDETRACK_EMBED_BATCH` (env, clamped to
[1, 64], degrades to the default on unset/blank/non-numeric/≤0 rather than
failing boot) — see `resolveEmbedBatchCapFromEnv` in
`backgroundEmbeddingLane.ts`. Raising the cap was unsafe under the OLD
write path (it would have linearly multiplied the ~350MB/min rate); safe
now that a cache write costs O(batch), not O(cache-size). At 16/cycle and
the Apple-engine ~4s/embed cost (see the on-device-engines memory note),
worst-case cycle latency is ~64s, acceptable because the lane re-checks
`isDrainActive` between records (a larger cap costs at most one more
record of drain latency, not the whole batch). A 2,102-item backlog at
16/cycle (vs. the previously observed ~1 real embed/cycle) drains in hours,
not days.

*Audibility.* `embeddingCache.ts` gained an optional throttled `log` hook
(`options.log`, default no-op, following the same DI convention as the
background-embedding lane) emitting `[embed-cache] flushed entries=N
bytes=M kind=append|compact path=…` — pending entries/bytes accumulate
across throttled-away flushes so the line is never missing volume, only
coalesced. Wired to stdout at the traced hot path
(`page-evidence/embedding.ts`'s two `createEmbeddingCache` call sites), not
at the low-level module's default — `embeddingCache.ts` has too many
scattered callers across the codebase (`vectorCorpus.ts`,
`connections/visitSimilarity.ts`, `sync/contract/recallMaterializer.ts`,
`recall-v2/store/backfill.ts`) to default all of them to stdout without a
much larger, out-of-scope plumbing change; noted here as a deliberate
deviation rather than a silent gap.

*Test-companion maintenance.* `docs/runbooks/sidetrack-companion-
maintenance.sh` §1 (restart-on-mem/uptime) covered only the daily companion
(:17373); the test companion (:17374) had zero automatic restart coverage —
live footprint measured 2,488M on 2026-08-15 with nothing to catch it. §1
is now a shared `check_and_restart_companion` function applied to both
companions with identical `MEM_LIMIT_MB=3000` / `MAX_UPTIME_DAYS=2`
thresholds. Per the file's existing sync convention (see its "NOT YET
SYNCED" header note): the coordinator copies the changed sections into the
live launchd script at `$HOME/.sidetrack-companion-maintenance.sh` at
deploy time — this PR only changes the repo copy.

*Verification.* New `embeddingCacheWriteAmplification.test.ts`: write-
volume regression (20 puts after a 200-entry baseline write far less than
20× the file size, and a single put after a 500-entry cache writes ~1
record, not the whole file), compaction reclaims space once the stale-byte
threshold is crossed, throttled-log format + coalescing, and two crash-
safety cases (truncated trailing record recovers all prior entries without
throwing; truncated header degrades to an absent cache, not a throw — both
still writable afterward). `resolveEmbedBatchCapFromEnv` covered directly
in `backgroundEmbeddingLane.test.ts` (defaults, clamping, fractional
flooring, custom fallback). Existing `embeddingCache.test.ts`,
`vectorCorpus.test.ts` (`migrateModel`/`rollbackMigration`, unchanged —
still full-rewrite, used rarely), `embeddingCacheReuse.test.ts`, and
`backgroundEmbeddingLaneThroughput.test.ts` all pass unmodified against the
new write path. `src/recall-v2/store/sqlite.ts`,
`src/tabsession/prototypeLane.ts`, and
`src/sync/contract/connectionsMaterializer.ts` untouched, per this task's
binding constraint.

PR: perf(recall): O(delta) embed-cache writes + batched embed lane +
test-companion maintenance (branch `perf/embed-cache-write-amp`).

**2026-08-17 — kill ambient test flakiness; blocking suite deterministic
(test/flaky-quarantine).** Not an F1–F7 item; filed here per task #30, an
accepted review finding: "full suite red, isolated green" had become
normalized, which lets real regressions hide behind ambient flakiness.
Verified each of the four named offenders against real CI history
(`gh run view --log-failed` on the last several main-branch failures) rather
than trusting the description alone, and found one additional live flake
plus one already-resolved one along the way.

*1. `connections incremental ranker frontier > forces a full ranker
augmentation when the producer revision changes`.* Confirmed via CI log
(`this test timed out after 5000ms` at exactly 5045ms, run 31912141879,
2026-08-15) — not a guess. Root cause: the test stubs
`closestVisitRankerLoader` (so the real LightGBM ranker never loads) but
left `embed` unset, so `createConnectionsMaterializer` fell back to
`defaultEmbed` and loaded the real Xenova/multilingual-e5-small model on
every drain (~1.8s cold). Real fix: stub the embedder, same pattern the
file's own "skips a similarity-changing topic recompute" test already used.
First attempt used a 2-dim `[1, 0]` vector (matching that sibling test) and
broke two assertions — turned out a low-dim vector trips the vector store's
dimension guard and silently drops candidate generation, a different latent
bug. Fixed by using a full `RECALL_MODEL.embeddingDim`-dimension stub
(`embedFullDim`, mirroring `connectionsMaterializer.renderedSimilarityFloor
.test.ts`'s existing convention) instead. Applied the same fix to the
sibling "runs the ranker on a scoped-delta drain" test, which had the
identical unstubbed-embed shape (2 drains × 2 roots) and was one real-model
load away from the same flake, just not yet caught in CI.

*2. `connectionsHnswReconcileIntegration.test.ts`.* Spawn-heavy by design —
every one of its 13 tests forks a real reconcile child process
(`runReconcileInChild`), which is the actual thing under test, so mocking
it away would defeat the suite's purpose. Confirmed empirically that
bun:test does not honor a describe-level timeout (neither a bare number nor
an `{ timeout }` object as the third arg to `describe()` changed per-test
behavior in a throwaway probe file) — the only honored mechanism is a
per-`it()` third-arg override. Added explicit budgets to all 11 tests that
didn't already have one (20_000ms; the two heaviest — 100+ visit corpora,
full-vs-incremental comparisons — already carried their own 90_000/30_000
overrides), with a shared rationale comment, same pattern as `ae4a8d5a`.

*3. eventLog append-index prewarm + connections boot-catchup timing.*
`eventLog.test.ts`'s three prewarm tests seed 40k–350k real event lines and
walk them (sometimes twice, plus an oracle cold rebuild) — genuinely
CPU-bound work with no dependency to stub; added explicit 30_000ms budgets
with a shared comment. Separately,
`connectionsMaterializer.instantBoot.test.ts`'s B5(a) asserts
`bootMs < 5_000` on a real `performance.now()` delta for a 6-event fixture;
the regression it actually guards against (a full-log seed instead of a
resume-fold) is already pinned by phase-log assertions earlier in the same
test, so the literal wall-clock bound is CI-noise budget, not load-bearing
coverage — raised to 15_000ms with a comment explaining why, plus a 20_000ms
`it()` budget.

*4. `packages/sidetrack-extension/tests/unit/content/engagement
/copyPaste.test.ts`.* The old wait was 5 fixed ticks of
`setTimeout(0)+Promise.resolve()` before checking that both lineage
messages arrived — bounding elapsed *ticks*, not elapsed *time*.
`attachCopyPasteLineage` hashes via `crypto.subtle.digest`, a real async
WebCrypto call whose settle time isn't fixed; under a contended runner each
tick can itself take longer than 5 ticks' worth of margin. Replaced with a
`waitUntil(predicate, { timeoutMs, intervalMs })` helper that polls a real
wall-clock deadline (2s budget) and returns as soon as both messages land —
deterministic intent, honest upper bound instead of a papered-over retry.

*Found via CI history, not on the named list.* (a) `discovery.ts`'s
`fs.watch` listener only guarded `filename === null`; Linux inotify
recursive watches have been observed invoking the callback with
`filename === undefined` (a runtime deviation from the documented `string |
null` type), which threw inside `path.join` and surfaced as "Unhandled
error between tests" in CI (3 occurrences in one run alone, confirmed via
log). Same defect existed in `vault/watcher.ts` (its Buffer-fallback branch
would call `.toString()` on `undefined` and crash) but not in
`collectors/framework/tail.ts` (its `String(filename)` call degrades
harmlessly on `undefined`, so left as-is). Fixed both real bugs: narrowed
to `typeof filename !== 'string'` / added an explicit `undefined` guard.
(b) `buildVisitSimilarity > does not emit a candidate below the top-K
cutoff even when it clears threshold` flaked twice more on main
(2026-08-14, 2026-08-15) with contradictory assertion directions
(`toBeUndefined()` vs `toBeDefined()` failing on alternate runs) despite an
earlier fix (0745556f, 2026-07-12) that added deterministic score/id
tie-breaks throughout the hybrid fusion path. Root cause was upstream of
all of that: `buildAnnIndex` called usearch's HNSW `add()`/`search()` with
`threads=0`, which resolves to `hardware_concurrency()` — multi-threaded
graph construction with library-documented non-deterministic insertion
order, so the CANDIDATE SET was unstable before any tie-break sort ever
ran. Already fixed on this branch's base by `faf08269` (same day, later
that evening) pinning `HNSW_INDEX_THREADS = 1`; verified fixed rather than
assumed — 3 consecutive local runs of `visitSimilarity.test.ts` green, no
action needed here.

*Quarantine.* Not used — every offender got a real, root-caused fix; none
needed the `SIDETRACK_CI_STRICT` / `*.flaky.test.ts` non-blocking-lane
convention the task offered as a fallback, so no `QUARANTINE.md` and no
`.github/workflows/ci.yml` change (the blocking-lane philosophy is
unchanged).

*Verification.* Full suite run 3× back-to-back on a loaded machine (typecheck
already-running plus this session's own prior work in the same tree):
companion (`bun test`) 3,625 pass / 0 fail / 8 skip across all three runs
(165,155 / 165,272 / 165,380 `expect()` calls; 164–166s each); golden
resolve referee 38/38 pass; extension (`vitest run`) 1,795/1,795 pass across
all three runs; MCP (`vitest run`) 94/94 pass across all three runs.
`tsc -p tsconfig.build.json` (companion), `tsc --noEmit` (extension, MCP)
all clean. `bun run build` clean across all three packages.

PR: test: fix or quarantine ambient flaky tests — blocking suite
deterministic (branch `test/flaky-quarantine`).

**2026-08-17 — disk-wear addendum, part 2: diff-aware putCurrent — O(changed-
rows) WAL writes per connections publish (perf/diff-aware-putcurrent).** Not
an F1–F7 item; same disk-wear theme, third chokepoint in this addendum
series (after F1's log compaction and the embed-cache entry above) — this
one is the DOMINANT live write channel on the test companion.

*Traced evidence (user, repeated fs trace, 2026-08-16/17).* Test companion
writing ~506MB/min, dominated by `connections/current*.db-wal`. Cause
chain, confirmed by reading the code rather than guessing: the reconcile
child's post-catch-up thread-membership reconcile
(`connectionsMaterializer.ts`'s `forceFullRebuildForThreadReconcile`) ends
essentially EVERY real catch-up/drain with a call to
`writeSnapshotAndProgress` carrying `dirtyScopes === undefined` — a full
content-replace of the ~18k-node/107k-edge snapshot. The "storage-tier
in-place publish" work (PRs #381/#386, the two entries directly above) made
these writes land in place (WAL) instead of 437MB `copyFileSync` clones —
a real fix for the CLONE-vs-in-place routing — but explicitly left
`#writeCurrentRows`'s own row-level write shape untouched ("no changes to
the mutation logic itself were needed, only to which handle it's applied
against" — see the 2026-08-16 entry above). That mutation logic itself was
still O(snapshot) per publish: unconditional
`upsertMetadata.run('node_order', …)` /
`upsertMetadata.run('edge_order', …)` rewriting the FULL id array every
time regardless of whether any node/edge actually changed, and — the
dominant term — `connections_scope_nodes`/`connections_scope_edges`
handled via a blind `DELETE FROM connections_scope_nodes` /
`DELETE FROM connections_scope_edges` (delete-ALL) followed by reinserting
EVERY node's/edge's scope membership from scratch, every time
`dirtyScopes` was `undefined` (i.e. every full-rebuild reconcile). Nodes
and edges themselves were ALREADY correctly guarded (a JS `Map` diff
compares each row's serialized body before calling `upsertNode.run`/
`upsertEdge.run` — unchanged rows never touched `.run()` at all) — the gap
was specifically the scope-membership tables and the two order arrays.

*Fix (`src/connections/snapshot.ts`, `#writeCurrentRows` only —
`generationBuffer.ts` inspected and left untouched: it owns generation
lifecycle/pointer/checkpoint-policy plumbing, no row-level writes at all,
nothing to fix there).*
1. **Scope-membership anti-join delete.** Replaced the delete-all + reinsert-
   all shape with the SAME anti-join temp-table technique
   `replaceScopeRows` already uses (and the SQL-budget/query-plan-lint
   guardrails from the 2026-08-16 `#378` incident already cover the bug
   class for): populate `temp_writecur_scope_nodes`/`temp_writecur_
   scope_edges` with the incoming (post-dirty-scope-filter) membership set,
   `INSERT OR IGNORE` each pair into the real table (measured: a fully-
   redundant `INSERT OR IGNORE` pass against an already-present PK writes
   **zero** WAL bytes — see the probe below), then a single
   `DELETE ... WHERE NOT EXISTS (temp table match)` (or, for the scoped-
   write case, additionally `WHERE EXISTS (temp_writecur_dirty_scopes …)`)
   removes exactly the rows absent from the incoming set. Registered in
   `queryPlanLint.test.ts`'s `HOT_STATEMENTS` so a future missing-index
   regression on these tables alarms in CI the same way `#378` now would.
2. **Guarded node_order/edge_order/metadata.current.** Each is now a
   compare-then-write: read the existing stored JSON string, compute the
   new one (`metadataForSnapshotWrite`/nodeIds/edge-id-array are pure
   functions of snapshot content, no wall-clock — a string compare is a
   correct no-op detector), only call `upsertMetadata.run` when they
   actually differ.
3. **write_seq / resolver-cache invalidation gating.** `#bumpWriteSeq` and
   `#dropCachedSnapshot()` now fire only when something `readCurrent`
   actually consumes changed (nodes/edges/metadata.current/node_order/
   edge_order — per `#bumpWriteSeq`'s own pre-existing doc comment,
   `connections_scope_nodes`/`_edges` are NOT among them, so a scope-only
   delta correctly still skips the bump). A publish that reaches
   `#writeCurrentRows` and finds nothing in that set changed no longer
   bumps the commit token or busts the `readCurrent` memo — verified via
   reference equality on `readCurrent()`'s return value in
   `putCurrentDiffAware.test.ts` (impossible unless the memo survived).
4. **Audibility.** `[publish.in-place]` now carries
   `rowsChanged=N rowsUnchanged=M` (threaded through
   `#acquireInPlaceWriteHandle`/`#acquireGraphWriteHandle`'s `finalize`
   signature as an optional `PublishRowDiagnostics` argument — omitted,
   never fabricated as `0/0`, for publishers that don't track per-row
   diffs today, i.e. `applyProjectionEventOverlay`'s single-row fold and
   `replaceScopeRows`' already-O(delta) rewrite).

*Deliberate deviation from the task's suggested design:* no `content_hash`
column / schema migration. The task's own "SQLite gives this nearly free"
framing was aimed at wide/JSON-valued rows where comparing full blobs is
expensive — but nodes/edges already read their full current row content
into JS to build the diff `Map` (pre-existing code, unchanged), so
extending the SAME string-compare idiom to node_order/edge_order/
metadata.current adds no new O(state) cost beyond what the file already
paid every publish. For the scope tables, a hash column doesn't apply at
all (the "content" of a membership row IS its existence, not a value to
hash) — the anti-join temp-table technique is the direct SQL-native
analog, and it was ALREADY the established, incident-hardened pattern in
this exact file (`replaceScopeRows`), so reusing it kept the diff smaller
and lower-risk than introducing a new migration idiom.

*Measured (fixture: 10,000 nodes / 50,000 edges,
`putCurrentDiffAware.perf.test.ts`).* Fixture on-disk size: 78,184,448
bytes (~74.6MB). First (cold) `putCurrent`: full write, as expected —
this is the "naive-equivalent" volume the OLD unconditional-rewrite shape
would have written on EVERY publish, changed or not (confirmed against
this file's shape: node_order + edge_order arrays alone for this fixture
run into the low megabytes, and the scope-table delete-all/reinsert-all
touches ~110,000 rows). Second `putCurrent`, 10 node labels changed and
NOTHING else (same 50,000 edges, same scope memberships, same order):
**32,992 bytes written** — 0.042% of the fixture size, `rowsChanged=11`
(10 nodes + `metadata.current`) `rowsUnchanged=59,992` (9,990 nodes +
50,000 edges + scope-membership rows already matching). Comfortably under
the task's 1MB bar and roughly 2,371× smaller than the naive-equivalent
full rewrite. Guarded-compare overhead (the "content-hash computation
cost" the task asked to check): the second publish completed in line with
one JSON-serialization pass over the fixture's own node/edge bodies —
string comparison is strictly cheaper than the serialization the pre-
existing code already paid, so this is not a new bottleneck.

*WAL checkpoint policy (task's item 4 — reported, not tuned).*
`inPlaceCheckpointIdleMs`/`inPlaceCheckpointEveryN`
(`generationBuffer.ts`) are COUNT/idle-triggered (30s idle, or every 50
in-place publishes, forces one `PRAGMA wal_checkpoint(TRUNCATE)`) — not
size-triggered — so this fix doesn't change checkpoint CADENCE. It only
shrinks how much WAL has accumulated by the time each periodic checkpoint
fires (previously ~50 × tens-of-MB; now ~50 × tens-of-KB for a steady
membership-stable vault), so TRUNCATE cost should only go down. No
`wal_autocheckpoint` PRAGMA is set anywhere in this store (SQLite's own
1000-page/~4MB default applies as a backstop); with per-publish WAL now
O(changed) it will fire far less often in wall-clock terms than before.
No tuning applied — nothing measured to need it.

*Verification.* `putCurrentDiffAware.perf.test.ts` (WAL-bytes measurement
above), `putCurrentDiffAware.test.ts` (no-op write_seq/cache-invalidation
skip via reference equality + a mixed add/remove/change delta spanning
nodes/edges/scopes reads back exactly right), `queryPlanLint.test.ts`
extended with the 4 new anti-join statements (all resolve to SEARCH, never
an unexpected SCAN — the suite's own #378-regression proof still passes
unmodified), `inPlacePublish.test.ts`'s existing crash-kill suite
(`SIGKILL at a randomized point mid in-place FULL-REBUILD publish`, N=20,
reused unmodified — it already exercises `writeSnapshotAndProgress` →
`#writeCurrentRows`, so it now covers the diff-aware path for free; still
0 failures, fully-old-or-fully-new held) and its (6) audible-marks case
updated for the new `rowsChanged=`/`rowsUnchanged=` suffix. Full
`connections/` (546 tests) and `sync/contract/` (278 tests) suites pass
unmodified. `src/sync/contract/connectionsMaterializer.ts` untouched, per
this task's binding constraint; `generationBuffer.ts` inspected, no
changes needed (pointer/GC/checkpoint-cadence plumbing only, no row
writes).

PR: perf(store): diff-aware putCurrent — O(changed-rows) WAL writes per
publish (branch `perf/diff-aware-putcurrent`).

**2026-08-17 — CI cross-package spine (task #31, ci/cross-package-spine).**
Not an F1–F7 item; filed here per the "binding plan tracks reality" rule.
Issue #143's evidence: PR #141 shipped with `/v1/edge/events` effectively
unreachable and nothing caught it, because at the time there was no hosted
CI at all (`gh api .../actions/workflows` returned `total_count: 0`, no
`.github/` directory existed). Three additive jobs on top of the (now-
existing) `ci.yml`, honest-CI philosophy preserved (fast, deterministic,
no browser in the blocking path):

1. **Blocking deterministic smoke** —
   `packages/sidetrack-companion/src/integration/extensionCompanionSpine.test.ts`.
   Boots a real `createCompanionHttpServer`/`startHttpServer` instance
   (same harness `batchResolveShape.characterization.test.ts` /
   `prototypeLaneWiring.test.ts` use), replays the extension's REAL wire
   shapes (edge-event batch ordering imported directly from
   `sidetrack-extension/src/background/storage/edge-event-drain.ts`;
   page-content POST via the extension's real, shipped
   `PageContentClient.index()` — both are dependency-free leaf modules,
   verified importable cross-package with zero chrome/DOM machinery
   pulled in) through the canonical loop: `POST /v1/edge/events` ->
   `POST /v1/timeline/events` -> `POST /v1/page-content/extracted` ->
   drain via `SyncContractRunner.awaitIdle()` (no sleeps) -> `GET
   /v1/timeline` + `GET /v1/visits/inbox` + `GET /v1/page-content/coverage`
   all show the visit -> idempotent-replay + direct event-log read-back
   proves the durable substrate recorded `engagement.session.aggregated`
   (issue #143's exact ask, generalized past "the HTTP call returned
   200"). No ci.yml change needed for this item — `bun test` auto-
   discovers the new file, so it joins the EXISTING blocking `companion`
   job's full-suite run automatically. Verified deterministic 3x locally
   (~300ms/run).
2. **`vector-real-dim` job (new, blocking)** — the `companion` job's
   `SIDETRACK_SQLITE_LIB=off` opt-out (added so low-dimension fixtures
   elsewhere don't hit strict vec-column enforcement) meant the blocking
   gate never guaranteed real-384-dim sqlite-vec coverage end to end. New
   job runs the genuinely vector-dependent suites (5 files: the four
   `recall-v2/store/*.test.ts` sqlite-vec-store suites +
   `http/prototypeLaneWiring.test.ts`) WITHOUT the opt-out, real
   `RECALL_MODEL.embeddingDim` (384) vectors, on ubuntu-latest — 20 tests,
   371-406ms measured locally across 3 repeated runs, so BLOCKING per the
   task's <2min bar. Notable finding surfaced during verification (via
   `gh run view` on a recent green `main` run): `SIDETRACK_SQLITE_LIB=off`
   does NOT actually prevent sqlite-vec from loading on GitHub's
   `ubuntu-latest` runner today — `prototypeLaneWiring.test.ts`'s hard
   `vectorBackendAvailable===true` assertion already passes there,
   contradicting local macOS reproduction (where the opt-out genuinely
   disables vec). Pre-existing platform discrepancy, unrelated to this
   change, flagged in docs/CI.md rather than fixed here (out of scope for
   #31) — it does independently confirm the new job's core assumption
   (real vec-capable sqlite is available on that runner).
3. **`package-smoke` job (new, advisory)** — `wxt build` (real extension
   artifact) + companion `tsc -p tsconfig.build.json` + `stamp-build.mjs`,
   boot `dist/cli.js` against an empty temp vault, assert `/v1/version`
   reports a `buildSha`, `SIGTERM`, assert clean exit inside the shutdown
   watchdog's grace window (the #374 shutdown contract). ~15-20s measured
   locally (macOS). Advisory (`continue-on-error: true`) since real
   bundling + process-signal timing carries more environment-specific
   flake risk than a pure unit-test job; promote once stable across real
   PR traffic.

`docs/CI.md` (new) documents the full `bun run verify` (local, authoritative,
runs `build`/`lint`/`format:check` too) vs hosted-CI (fast, parallel,
per-package, does not run `verify` verbatim) contract, the per-job
blocking/advisory table, and why browser e2e
(`connections-full-browser-sync-user-story.spec.ts`) stays out of the
blocking path — it still exists, still runs in the live-check loop
(`docs/dev-testing.md`), just isn't wired to block merges.

`connectionsMaterializer.ts` untouched, per this task's binding
constraint — the spine test deliberately exercises the (simpler, already
event-driven) timeline materializer + direct event-log/projection reads
instead of wiring the Class B connections materializer into the test
harness.

PR: ci: cross-package spine — extension→companion smoke, real-dim
vectors, package smoke (branch `ci/cross-package-spine`).

**2026-08-17 — resolver acceptance harness + 64-bit EC digest +
candidate-window truncation mark (test/resolver-acceptance-harness).**
Task #32, three parts; closure evidence for task #24 (the week's resolver
work: hub-subgraph budgets 08-16 above, event-candidate-resolve indexing,
resolver-cache F3/F4 keying).

*EC-digest widening.* `eventCandidateCacheRevision`'s `stableHash`
(http/routes/visitsRoutes.ts) was a single-pass 32-bit FNV-1a — the SOLE
cache identity for the folded event-candidate URL set, so a 32-bit
collision was a silent WRONG cache hit, not just a slow miss. Widened to
64-bit: two independent 32-bit FNV-1a passes (same prime, two different,
unrelated offset-basis seeds) concatenated into 16 lowercase hex chars.
Still dependency-free (no crypto import), still deterministic, still
order-/duplicate-invariant on the URL set (unchanged upstream sort+dedup).
No migration: old rows keyed under the prior 8-char digest simply miss
once — the revision string is a different length for the same logical
input, so it can never collide with a new-format key — and the miss
re-populates the cache under the new key on the next read.

*Candidate-window truncation mark.* The bounded
`SIDETRACK_RESOLVER_CANDIDATE_TIMELINE_WINDOW` read
(`timelineEventsForCandidateGeneration`, http/server.ts) silently dropped
everything past the window with zero signal. Added a throttled (30s,
mirrors `[resolver.subgraph.truncated]`'s window) `console.warn`:
`[resolver.candidate-window.truncated] url=… window=N`, firing when the
read returns exactly `window` rows (the same "hit the cap" proxy a LIMIT
query allows without a second COUNT query on the hot path). `url=` carries
the batch's missed event-candidate targets (capped to 3 + a "+N more"
suffix) since this read serves a whole batch, not one seed. Both changes
stayed out of `connections/snapshot.ts` per this task's binding
constraint — the call site threading (`missedEventCandidateTargets`
through to the read) lives entirely in `http/server.ts`.

*Acceptance harness* (the substance) —
`packages/sidetrack-companion/scripts/resolver-acceptance.ts`. A checked-in
CLI, run manually (never auto-run against a live vault): copies `--vault`
into TWO of its own working copies (APFS `cp -Rc`, falling back to `cp -R`),
starts a real companion process on each (ephemeral port, ordinary
`bun <file> --vault --port` on `src/cli.ts` directly — no dist/ build
dependency, no stale-buildSha footgun), and drives real HTTP resolves
against them. Instance A (production budgets) records a manifest (vault
identity via streamed sha256 + size on the event-store/connections db,
event/node/edge/candidate-url counts via direct sqlite reads, enabled
lanes from env, machine class, bun version) then runs N cold resolves, N
warm repeats, and M event-candidate resolves, timing every call.
Instance B (`SIDETRACK_RESOLVER_SUBGRAPH_NODE_BUDGET` /
`EDGE_BUDGET` / `HUB_DEGREE_CAP` / `CANDIDATE_TIMELINE_WINDOW` all `=0`,
i.e. unlimited) resolves the same N cold-probe URLs once each on its OWN
independent copy — decision drift is instance A's cold decision vs
instance B's decision per URL. **Two independent copies, not one instance
with an env flip, is load-bearing**: `resolverCacheRevision` keys on
`(snapshotRevision, arm[, state])` only, never the structural budgets, so
running both regimes against the same copy would let instance B silently
serve back instance A's cached (production-budget) answer, making every
drift comparison a false negative.

Two sqlite-path discoveries worth recording (found by verifying against
real data before trusting the numbers, not by reading the schema once):
node/edge counts (`connections_scope_nodes`/`connections_scope_edges`) DO
live in the generation-swapped file, so the harness resolves the active
generation via `connections/generationBuffer.ts`'s already-exported
`readPointer`/`generationDbPath` (read-only import, no edits to that
file) rather than guessing a fixed path. The resolver cache does NOT: per
`SqliteConnectionsStore`'s own D3 comment, `connections_resolver_cache`
lives in a separate, fixed-path `resolver-cache.db`, never
generation-swapped — an initial version of the harness pointed at the
generation file instead (same table name exists there too, empty, from a
different open path) and silently reported `before=0 after=0` for every
run until cross-checked directly against both files on the real vault
copy.

*Real-vault run (closure evidence, task #24).* One run against a fresh
`cp -Rc` clone of `~/.sidetrack-vault-test` (3.1GB; live daily+test
companions untouched throughout, confirmed by PID before/after) to
`/tmp`, `--cold 30 --event-candidates 10`, total wall clock 74.8s (well
under the 10-minute budget):

| class | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| cold | 30 | 207.2ms | 514.9ms | 531.8ms | 531.8ms |
| warm | 30 | 10.7ms | 12.6ms | 23.7ms | 23.7ms |
| eventCandidate | 10 | 590.0ms | 1074.6ms | 1074.6ms | 1074.6ms |

Manifest: events=249,276 nodes=19,821 edges=113,423 candidateUrls=4,044.
Event-loop stalls: count=2, totalBlockedMs=844, maxBlockedMs=553.
Resolver-cache rows: before=25 after=55 (delta=30, matching 30 cold
resolves each landing one new/updated key — the 30 warm repeats hit the
same keys, no new rows). Truncation marks: subgraph=2, candidateWindow=0.
**Acceptance bar: warm <300ms (10.7ms p50 — well clear) and cold <1.5s
(207.2ms p50, 531.8ms max — well clear). Both PASS.**

Decision drift: 30 compared, 2 differing (6.7%) —
`https://news.ycombinator.com/?p=3` and a LinkedIn post permalink, both
plausible high-fan-in hub pages. Not zero, but explained: the subgraph-
truncation count for the same run is also 2, consistent with (not proven
identical to, the throttled log doesn't carry per-URL identity) the
structural budgets actually trimming these two URLs' subgraphs enough to
flip the winning workstream — i.e. the drift measures real, non-zero cost
from the 1200/4000/400/20k budgets landed 08-16, concentrated on hub
pages, not a uniform tax on every resolve.

*Tests.* `visitsRoutes.test.ts`: widened digest shape (16 hex chars) +
new "two halves are independent" check; existing order-/duplicate-
invariance and distinct-set tests pass unmodified (the folded-suffix
helper in `http/visitsRoutes.test.ts` derives its expected suffix from the
real function, so it never hard-coded the old 8-char width).
`server.candidateWindowTruncation.test.ts` (new): fires on cap-hit,
silent under cap, silent on the store-null/merged-filter path, throttled
across two calls, and caps+summarizes the logged url list — via a minimal
`EventStore` stub (`readMostRecentByType`/`forEachChunkOfTypes` only), no
full HTTP scaffold needed. `scripts/resolver-acceptance.test.ts` (new):
unit coverage for `percentile`/`latencyStatsOf`/`stratifiedSample`/
`parseArgs`/`renderTable`, plus an end-to-end smoke test that spawns the
real script against a tiny freshly-`mkdir`'d empty vault directory
(0 candidate URLs — exercises the harness's own orchestration: two real
companion boots/shutdowns, manifest building against absent tables,
log-scanning, well-formed JSON) and asserts on the written report. Full
`bun test` (398 files) and `npm run build` clean; one unrelated flaky fail
on a loaded machine (`eventLog.test.ts`'s append-index-prewarm timing
test, pre-existing, passes clean in isolation — not touched by this PR).
`src/sync/contract/connectionsMaterializer.ts` and
`src/connections/snapshot.ts` untouched.

PR: test(resolver): acceptance harness + 64-bit ec digest + candidate-window
truncation mark (branch `test/resolver-acceptance-harness`).

**2026-08-21 — HNSW write delta-gate + rowid-driven replaceScopeRows (perf/hnsw-gate-rowid-scopes).**
Not an F1–F7 item; ships the two concrete follow-ups the 2026-08-21 F9
landing note above filed and explicitly did NOT implement: the 89.43MB
HNSW wholesale rewrite (protected-file-adjacent, fix layer 3) and the
`replaceScopeRows` `deleteScopeEdges`/`deleteOrphanEdges` allow-listed
scans (also fix layer 3, "verified 54x faster... NOT applied in this
PR"). Per that note's own instruction, this PR re-derives both rather
than blindly reapplying the cited numbers — and the re-derivation
overturned parts of the cited mechanism, reported honestly below per
"evidence before conclusions."

**Win 1 — HNSW write delta-gate.** The write is `visitSimilarityHnsw.ts`'s
`persist()` (`packages/sidetrack-companion/src/connections/
visitSimilarityHnsw.ts`) — the lowest-level call is
`await loaded.index.writeIndex(indexTmpPath)` (line ~528, hnswlib-node's
native binding), reached from `connectionsMaterializer.ts`'s
`buildHnswVisitSimilarity` → `loadedHnswStore.persist()` (materializer
untouched, per the task's constraint — `persist()`'s existing public
signature takes no arguments and stays that way). `persist()` already had
a coarse boolean `dirty` skip (added 2026-08-15, `7993eefd`) — but
`insertOrUpdate`/`delete` set `dirty = true` unconditionally on every
call, including a redundant re-insert of an ALREADY-published, byte-
identical embedding (the materializer's `carryForwardSimilarity`-style
re-insertion of every carried-forward visit on graph-touching drains —
exactly the F9 note's measured case: one new visit forced the FULL
89.43MB corpus to rewrite, not just that one vector). Fix: a content
signature — SHA-256 over `schemaVersion` + `dimension` + vector identity
+ sorted `(visitId, label, embedding-bytes)` tuples, computed from
`LoadedState`'s own in-memory maps and `index.getPoint()` reads (no
external input needed, so no materializer change required) — compared
against a signature persisted in a new sidecar-adjacent file,
`visit-similarity-hnsw.sig` (unversioned, always describing whatever
`.current` currently names). On a match, `persist()` skips
`writeIndex()`/sidecar/pointer entirely and logs
`[hnsw.write] skipped signature=… count=… bytes=…` (bytes = the on-disk
size of the artifact NOT rewritten); on a mismatch it does the existing
full write, THEN — strictly AFTER the artifact is fully published, never
before — writes the new `.sig` via the same tmp+rename atomic pattern
already used for `.bin`/`.json`/`.current`, and logs
`[hnsw.write] written signature=… count=… bytes=…`. Crash safety: a
missing or garbage-content `.sig` (any read failure, or content failing a
64-hex-char sha256 shape check) is treated identically to "no match" —
the next `persist()` call redoes the full write, which is safe (one
wasted rewrite, never a silently-stale skip) and self-heals the `.sig`
file. Deliberate deviation from the task's literal "count + xxhash/fnv
over sorted edge ids" suggestion: the signature also hashes each
embedding's bytes (via `Float64Array`-reinterpreted bit patterns), not
just the id/label set — an id/label set unchanged since the last publish
does not prove the underlying VECTOR values are unchanged (a genuine
re-embed of an already-known visit, same id, same label, different
value, is a real content change an id-only signature would silently
drop); the extra `getPoint()` reads are in-memory native-binding calls
over already-loaded vectors, vastly cheaper than the 89MB write they
gate. Uses `node:crypto`'s `createHash('sha256')`, matching the
established "diff-aware putCurrent" precedent (PR #391,
`contentSignatureForSnapshot` in `connections/snapshot.ts`) rather than
xxhash/fnv, for consistency with the codebase's own existing signature-
gated-skip idiom.

*Verification, `visitSimilarityHnsw.test.ts`.* New `describe('persist()
delta-gate ...)` block (7 tests, all passing alongside the 8 pre-existing
tests in the file, 15/15): skip when a redundant mutation reproduces
already-published content (no new version file, pointer unchanged);
write + correct served content when an existing embedding's VALUE
actually changes (same id/label, proves the embedding-bytes-in-signature
design decision is load-bearing, not decorative); write when a visit is
added or deleted even if all other visits are unchanged; two crash-safety
tests (missing `.sig`, corrupt `.sig` — both force a rewrite despite
logically-unchanged content); one measured test (500-vector corpus, 32
dims, 10 consecutive redundant carry-forward drains): **10/10 skipped, 0
rewrites**, each avoiding a 138,204-byte rewrite it would otherwise have
paid. Live corroboration: the existing real-forked-child integration
suite (`connectionsHnswReconcileIntegration.test.ts`, 13/13 pass
unmodified, including the D4 "reuses the persisted similarity revision on
a re-drain over an unchanged corpus" case) now visibly logs
`[reconcile.child] [hnsw.write] written …` / (on unchanged re-drains)
would log `skipped` through the real child process — the gate is wired
into the actual drain path, not just unit-tested in isolation.

**Win 2 — `replaceScopeRows` rowid-driven rewrite.** Target statements:
`deleteScopeEdges` (allow-listed `SCAN connections_scope_edges`) and
`deleteOrphanEdges` (allow-listed `SCAN edges`) in `connections/
snapshot.ts`'s `#replaceScopeRows`. **Re-derivation finding, reported
honestly per "evidence before conclusions" / "retract premises when data
disagrees":** the F9 note's literal cited shape — `DELETE FROM t WHERE
rowid IN (SELECT c.rowid FROM small_temp s JOIN t c ON …)` — does NOT
reliably avoid the scan on this repo's bun:sqlite/SQLite version: an
ordinary `JOIN` is reorderable, and at this statement's real selectivity
the planner chose to drive the join from the BIG table anyway (`SCAN c`
in `EXPLAIN QUERY PLAN`, with a Bloom-filter pre-check replacing the
correlated subquery) — measured NO reliable speedup building and timing
this shape directly (sometimes a small regression). Two alternatives were
spiked and compared: forcing join order with `CROSS JOIN` (SQLite
disables reordering for a join spelled `CROSS JOIN`), and restating the
predicate as a row-value `(col1, col2) IN (subquery)` membership test
with no JOIN at all. The row-value `IN` form won on both simplicity and
measured speed and is what shipped:
`deleteScopeEdges` → `DELETE FROM connections_scope_edges WHERE
(scope_kind, scope_id) IN (SELECT scope_kind, scope_id FROM
temp_replace_scopes)`; `deleteOrphanEdges` → `DELETE FROM edges WHERE
(src, dst) IN (SELECT edge_src, edge_dst FROM temp_replace_edges) AND
NOT EXISTS (SELECT 1 FROM connections_scope_edges c WHERE c.edge_src =
edges.src AND c.edge_dst = edges.dst)`. Both now resolve via `SEARCH
<table> USING (COVERING) INDEX … (col=?…)` — no `SCAN` of either
statement's own target table or the joined table, `EXPLAIN QUERY PLAN`-
verified.

**A second, sharper finding from the same re-derivation:** naively
extending the row-value idiom to `deleteOrphanEdges`'s orphan check
(`(src, dst) NOT IN (SELECT edge_src, edge_dst FROM
connections_scope_edges)`) is not just unhelpful but **catastrophic** —
measured **~102x-340x SLOWER** (9+ seconds vs tens of ms on a 110k-row
fixture) than the original `EXISTS`-correlated shape, almost certainly
SQL's three-valued NULL-comparison semantics forcing SQLite into a much
more conservative plan for a row-value `NOT IN` against a large, non-
uniquely-keyed subquery. `deleteOrphanEdges` therefore keeps `NOT EXISTS`
for that half — still index-driven via the existing
`idx_scope_edges_edge(edge_src, edge_dst)` index — and only replaces the
OTHER (membership-in-the-touched-set) half with row-value `IN`. This trap
is committed as a permanent regression guard (see tests below) so nobody
"simplifies" the `NOT EXISTS` into `NOT IN` later without re-discovering
this the hard way.

*Measured (`snapshot.replaceScopeRowsRowid.perf.test.ts`, realistic-
selectivity fixture: 110,000 edges, 50,000 total distinct scopes
accumulated, only 4,742 replaced this one drain — matching the live
phase-log line the F9 investigation cited, "scopes=4742" touched out of a
much larger accumulated total; an earlier, ABANDONED fixture that
replaced 100% of the scope population showed NO speedup at all, since
both the old scan and the new search must visit every row when literally
every row matches — not a real scoped-timeline-delta's shape).*
`deleteScopeEdges`: real runs measured 2.6x–2.8x faster; `deleteOrphanEdges`:
1.3x–1.7x faster. Both real, reproducible, `EXPLAIN QUERY PLAN`-verified
as SCAN→SEARCH — but **not the 54x the F9 note cited**, which was
measured against a real, much larger (400+MB), disk-cache-pressured
generation file; this suite's in-memory/small-file synthetic fixtures
understate the real-vault win (the PLAN SHAPE change is the asymptotic,
load-bearing property; the wall-clock ratio on a small fixture is a
lower bound, not the real number). Reported honestly rather than
re-asserting the original figure unverified.

*Tests.* `snapshot.replaceScopeRowsRowid.perf.test.ts` (new): (1)
equivalence — OLD (EXISTS-correlated, embedded verbatim from the pre-
rewrite statement) vs NEW (shipped) SQL delete the IDENTICAL row set on
three fixtures, including the #378-adjacent many-scope-groups-in-one-
table shape and explicit edge cases (an edge orphaned by the delta, an
edge kept alive by a surviving scope, an edge untouched entirely, an edge
with two scope refs where only one is removed); (2) measured speed (above
numbers, `expect(newMs).toBeLessThan(oldMs)` — asserts direction, not a
pinned ratio, to avoid flaking on a shared box, exact numbers logged for
the record); (3) a dedicated NOT-IN-trap regression guard, sized to
reproduce a clear (~100x) ratio in under a second rather than the 9+
seconds the full 110k-row fixture takes. `queryPlanLint.test.ts`: the two
`HOT_STATEMENTS` entries' `sql` text updated to the shipped shape and
`allowScanTables` REMOVED (both now covered by the generic "no SCAN of
any LARGE_TABLES entry" check); a new `describe('queryPlanLint — proves
the row-value IN rewrite holds ...)` block adds the task's requested
POSITIVE pin (asserts the exact `SEARCH … USING (COVERING) INDEX … (col=?
…)` line appears, not just "no SCAN") plus two regression tests that
`unexpectedScans` on the OLD, pre-rewrite EXISTS-correlated SQL text
still correctly reports `['connections_scope_edges']` / `['edges']` —
proving the lint's protective intent survives the allow-list removal, per
the #378-incident-scarred "prove the new shape with the plan lint, don't
just delete the guard" rule. `snapshot.replaceScopeRows.perf.test.ts`
(the #378 fix's own suite, unmodified) still passes — the missing-index
fix and this rewrite are independent and compose cleanly.

**Full verification.** `bun test`: 3888 pass / 8 skip / 0 fail across 420
files (companion package; `src/connections/` — 578 pass/0 fail — and
`connectionsHnswReconcileIntegration.test.ts` — 13/13 — rerun in
isolation twice on a loaded machine, both clean, no flakes). `tsc
--noEmit`: 152 pre-existing errors, unchanged, zero in any touched file
(same baseline PR #402 recorded). `eslint` on every touched/new file: 0
errors (a handful of pre-existing `import()`-type-annotation warnings,
same convention already present in the sibling files this PR's new file
copies its `captureDb` pattern from). `bun run build` clean across
companion/extension/mcp.

**Deviations from the task brief, stated plainly.** (1) The HNSW
signature hashes embedding bytes, not just ids — see Win 1's rationale;
this is MORE than "count + hash over sorted edge ids" asked for, for
correctness. (2) `node:crypto` sha256 used instead of xxhash/fnv,
matching PR #391's existing precedent rather than introducing a new
hashing primitive. (3) The rowid-driven rewrite as literally specified
(`rowid IN (SELECT … JOIN …)`) was tried, measured to NOT reproduce a
real speedup, and replaced with an empirically faster/simpler row-value
`IN` form — retracting the task's `rowid IN (JOIN)` framing per "evidence
before conclusions," while keeping the SAME target statements, the same
allow-list removal, and the same "prove it with the plan lint" discipline
the task asked for. (4) The measured speedup is real but far below the
task's cited 54x figure on the fixtures this suite can run in CI —
reported honestly with an explanation (disk-cache-pressure effects on a
real multi-hundred-MB file vs. an in-memory/small-file synthetic fixture)
rather than silently re-asserting the bigger number. (5) A NEW, previously
undocumented hazard (`NOT IN` catastrophically slow on this exact schema
shape) was found and is now a permanent regression guard — not asked for
explicitly, but directly load-bearing for not shipping a regression while
chasing the requested speedup.

PR: perf(store): HNSW write delta-gate + rowid-driven replaceScopeRows
(branch `perf/hnsw-gate-rowid-scopes`).

**2026-08-21 — event-store mirror day repair, F2 addendum
(fix/event-store-day-repair).** Built `event-store-repair-days`
(`src/gc/eventStoreMirrorRepair.ts`, wired in `cli.ts`) per this task's
brief: idempotent, watermark-gate-FREE re-ingestion of a (replica, day)'s
canonical JSONL events into the typed event-store mirror via
`EventStore.ingestMany` (`INSERT OR IGNORE` on the `(replica_id, seq)`
primary key) — fixes the general bug class where a day's mirror rows go
missing while `catchUpFromJsonl`'s `shard_progress` bookkeeping (size/mtime
tracked per shard file) never revisits an already-fully-read shard again.
Default discovery (no `--replica`/`--day`): every (replica, day) with a
canonical shard on disk — via `listCanonicalEventShards`, so an
already-F2-retired day works too — but zero mirror rows. Explicit
`--replica`/`--day` bypasses the zero-rows filter (targets that key
unconditionally; a no-op if already fine). Same safety bar as
`event-store-vacuum`: `SIDETRACK_EVENT_STORE_REPAIR=1` arm switch + the
recall process-lock, refused outright if a live companion owns it. 7 module
tests (fixture repair, idempotent re-run via explicit filter, malformed-line
handling, already-F2-retired-day repair, discovery-filter correctness,
clean no-op) + 6 CLI tests (missing `--vault`, unarmed refusal, lock-held
refusal, clean no-op, happy path + idempotent re-run) — all green; full
`bun test` 3935 pass/8 skip/0 fail across 424 files (after `npm run build`,
required for the pre-existing HNSW-reconcile-child/in-place-publish
integration tests that fork a `dist/` entrypoint — 0 failures attributable
to this change); `tsc --noEmit` 152 pre-existing errors, unchanged, zero in
any touched/new file; `eslint` 0 errors on every touched/new file.

**Real-vault verification surfaced a wrong premise — reported per the
debugging doctrine ("evidence before conclusions... retract premises when
data disagrees"), not silently patched over.** Task hypothesis: the 6 named
store-drift shards (replica `819ef08e-b4d4-4e8e-b230-60e33e96142f`, days
2026-06-15/06-26/07-02/07-03/07-04/07-05) have a mirror missing REAL events
still present in canonical JSONL. Verified on a COPY of
`~/.sidetrack-vault-test` (`cp -Rc` for `_BAC/log` + `_BAC/retired` +
`_BAC/seal`; `sqlite3 <src> ".backup <dest>"` for
`_BAC/connections/event-store.db` — WAL-safe online backup against the live
companion, which was never contacted/restarted/disrupted throughout, confirmed
still running the whole time; `retire-hot-tail --report` on the copy
reproduced the exact 6 named shards first, before any repair attempt).
Direct inspection FALSIFIES the premise: all 6 canonical
`_BAC/log/<replica>/<day>.jsonl` shards are literally 0 bytes (identical
mtime, Aug 15 21:56 — the F1 `compact-engagement --apply` idle-window run
per the F1 goal-register row above), and the mirror's row count for all 6 is
ALSO 0 — matching the JSONL, not drifted from it. The `compacted_events`
ledger carries 192,265 rows for this replica across the 6 days' seq span
(369310-565761), confirming a receipt-verified F1 compaction fully dropped
every event in these specific days (unlike the PARTIAL-drop compaction-aware
test in `hotTailRetirement.test.ts`, where an undropped aggregate event
keeps the day visible to the sealer). Running `event-store-repair-days`
against these exact 6 days (default discovery correctly found EXACTLY these
6 and nothing else across the 2.3GB copy — matching the task's own claim
precisely) is a correct, honest no-op: `canonicalEvents=0` for all 6
(nothing to re-ingest), `retire-hot-tail --report` byte-for-byte unchanged
after (`storeDriftShards` stays 6). The tool is not broken — there is
genuinely nothing left in canonical JSONL to repair for these 6 days.

**Real root cause (a second, more precise bug, found not guessed):
`eventSeal.ts`'s day-discovery can never re-seal a day that compacted to
EXACTLY zero rows.** `runEventSealPass` discovers candidate days via
`for (const stat of store.sealDayStats(replica))`, and `sealDayStats` is a
`GROUP BY day` SQL aggregate — which structurally never emits a row for a
day with zero matching rows. A day whose live row count drops from N to 0
(full compaction, this case) therefore becomes permanently invisible to the
same re-seal self-heal path the compaction-aware test proves DOES work when
at least one row (e.g. a surviving aggregate) keeps the day in
`sealDayStats`'s output. Confirmed directly: `seal --dry-run`
(`SIDETRACK_EVENT_STORE=1`) against the copy classifies all 234
currently-sealed-verified days as `skippedAlreadySealed` and never even
visits the 6 drifted days — not planned, not skipped, not counted anywhere;
the loop structurally cannot reach them. THIS is the actual, load-bearing
fix needed to close these 6 real shards — touches the columnar seal write
path (`src/analytics/eventSeal.ts`), a different subsystem with its own
segment-verification contract, deliberately NOT bundled into this PR (one
goal per PR, per repo convention) — filed here as a concrete,
ready-to-implement follow-up: extend the day-discovery loop to also plan a
re-seal (rows=0) for any manifest entry whose `(replica, day)` no longer
appears in `sealDayStats`'s output at all.

**Mechanism proven correct at real vault scale (the tool DOES work, on the
failure class it actually targets).** To close the loop honestly rather than
stop at a negative result, manufactured a genuine instance of the ORIGINALLY
hypothesized bug on the same copy: deleted the mirror's 22,963 rows for
`2026-08-05` (a real, already-F2-retired, otherwise-healthy day) —
`retire-hot-tail --report` correctly flipped it to `store-drift`
(`storeDriftShards` 6→7). `event-store-repair-days --replica
819ef08e-b4d4-4e8e-b230-60e33e96142f --day 2026-08-05` restored
`rowsAfter=22963` (`canonicalEvents=22963`, read from `_BAC/retired/log` —
proving the `listCanonicalEventShards` already-retired-day path at real
scale, not just the unit fixture) — `retire-hot-tail --report` flipped it
straight back to `sealed-verified` (`eventsLive=22963` matches
`eventsSealed`; `storeDriftShards` 7→6, `shardsEligible` back to 234).
Re-running the identical repair immediately after: `rowsInsertedTotal=0`,
`daysAlreadyOk=1` — idempotent at real vault scale, not just the synthetic
test fixtures.

PR: fix(store): event-store mirror day repair — unblock store-drift
retirement shards (branch `fix/event-store-day-repair`). Not merged —
coordinator review pending per this task's "one PR; do not merge"
instruction.

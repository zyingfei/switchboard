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
| F2 | JSONL hot-tail retirement | Report-only enumeration with per-day seal proofs; destructive apply behind flag + soak (~Aug 21); one-command flip documented | Report-only landed (PR perf/f2-hot-tail-report, 2026-08-16); real-vault run: 185 shards, 178 eligible, ~244MB retirable, 0 segment alarms; APPLY still pending soak (~Aug 21) |
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

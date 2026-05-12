# Stage 5.2 — incremental materializer refactor

> **Status: planning, not implementation.** This document proposes a
> structural change to `connectionsMaterializer` driven by CPU
> saturation observed during Stage 5.0 dogfood (see
> [`work-graph-stage5-0-retrospective.md`](work-graph-stage5-0-retrospective.md)).
> Stage 5.1 (T7a–T7d in
> [`work-graph-stage5-data-bridge.md`](work-graph-stage5-data-bridge.md))
> covers content-aware similarity and is *independent* of this work —
> ship in either order.

## Symptom (observed 2026-05-11/12, CDP attached to live recorder)

```
Companion PID 51335 (gitSha 3721deb6 — latest Stage 5.0 build)
CPU:   97.9–168.5% (continuous saturation across multiple readings)
MEM:   3.4% (heap fine; CPU is the bottleneck)

Side panel reads (during burst):
  /v1/visits/projection         82 s   (200 KB response)
  /v1/visits/inbox              82 s
  /v1/tabsessions/projection    67 s   (92 KB response)
  /v1/system/health             70 s   (timeout)
  /v1/status                    >5 s   (timeout, periodic poll)
```

Stage 5.0 cached the read path (`urls/cachedProjection.ts`,
`tabsession/cachedProjection.ts`) which collapsed burst polls onto a
single rebuild per 500 ms. CPU dropped briefly under that fix, then
re-pegged. The cache hides the *symptom* (slow reads) but not the
*cause* (continuous rebuilds on the write path).

## Diagnosis — `connectionsMaterializer.buildAndWrite` on every event

Path (`packages/sidetrack-companion/src/sync/contract/connectionsMaterializer.ts:377`):

```
readMerged()                             — reads ALL events from disk
buildTimelineDays(merged)                — re-buckets every event by day
buildEngagementClassifierInputs(...)     — re-derives per-visit focus/scroll/copy stats
buildEngagementClassRevision(...)        — re-classifies every visit
buildVisitSimilarity(allEntries, embed)  — re-embeds + pairwise edges
projectTabSessions(merged)               — re-iterates every event
projectUrls(merged, {threads})           — re-iterates every event
buildSelectedTopicRevision(...)          — re-clusters via union-find
buildConnectionsSnapshot(input)          — full graph rebuild
rankerRetrainer(...)                     — has a label-hash gate, skips if unchanged
```

Trigger: **every accepted event** (line 506–509). Engagement intervals
fire every ~30 s per active tab. With 4 tabs the trigger fires every
~7 s. Each rebuild is O(events). On a 5,000-event vault the rebuild
takes 60–80 s of CPU. The materializer is permanently behind its own
ingest rate.

## What MUST rebuild per event vs what could be incremental

Audit from
[`work-graph-stage5-data-bridge.md`](work-graph-stage5-data-bridge.md)
+ ad-hoc analysis 2026-05-12:

| Sub-model | Strict rebuild required? | Incremental-friendly? |
|---|---|---|
| **Engagement classifier inputs** | ❌ — each engagement event is immutable + scoped to one visit | ✅ trivially: streaming reducer keyed by `visitId` |
| **Timeline days** | ❌ — yesterday's bucket is frozen | ✅ touch only today's day |
| **URL projection** (`byCanonicalUrl`) | ❌ — each event affects one canonical URL row | ✅ patch the one row in place |
| **Tab-session projection** | ❌ — each event affects one `tabSessionId` row | ✅ same |
| **Visit similarity edges** | partial — new visit pairs with N existing visits | ✅ mostly: only N edges need (re)computation; existing-existing edges stable |
| **Topic clustering (union-find)** | partial — clusters can merge | ⚠️ harder: re-cluster the affected component, not the whole graph |
| **Connections graph snapshot** | partial — only nodes/edges touching the new event's surfaces | ⚠️ partial: most nodes/edges are stable |
| **Ranker retrain** | ❌ — already gated by `lastTrainedLabelDatasetHash` + 50-label threshold | ✅ already correct |

The user's load-bearing insight: **engagement, timeline, selection,
visual-fingerprint are append-only leaf streams**. Once an event is in
the past, the fields it carries (`focusedWindowMs`, `observedAt`,
`canonicalUrl`) are set in stone. Anything keyed by `(streamName,
visitId)` or `(streamName, canonicalUrl)` can be folded once and
cached forever.

The events that DO mutate state retroactively — full audit grouped
by which derived state they invalidate:

**User-driven attribution mutators** (the core "organize" surface):
- `user.organized.item` — moves an item (URL / tab-session / thread)
  between workstreams. Invalidates that one row's `currentAttribution`
  + any `visit_instance_in_workstream` edges referencing it.
- `user.engagement.relabeled` — overrides the engagement classifier
  for one visit. Invalidates that visit's class + any downstream
  feature that fed off the class (similarity gates, ranker labels).
- `user.flow.confirmed` / `user.flow.rejected` — user accepts /
  rejects a flow grouping. Invalidates flow membership for the
  involved visits.
- `user.topic.renamed` — changes a topic's display label. Display-
  only; no data-shape invalidation.
- `user.snippet.promoted` — promotes a snippet to first-class.
  Invalidates snippet membership.

**Workstream tree mutators** (the user's original "workstream changes"
question):
- `workstream.upserted` — creates a workstream OR renames an existing
  one OR re-parents it. Invalidates:
  - the workstream node's `label` in the graph
  - the `workstream_parent_of` edge set if `parentId` changed
  - the display path resolution for every URL / tab-session attributed
    to it (paths like "sideproject / sidetrack" are derived from the
    current tree shape, not snapshotted at attribution time)
- `workstream.deleted` — tombstones a workstream. Invalidates:
  - every `visit_instance_in_workstream` edge pointing to it (orphaned)
  - every `currentAttribution.workstreamId` row pointing to it
    (caller must fall back to a parent or drop the attribution)
  - the workstream tree shape

**Thread record mutators** (analogous to workstream):
- `thread.upserted` — creates / renames / re-points a thread. The
  thread carries a `primaryWorkstreamId` field; the materializer's
  `projectUrls(merged, {threads})` propagates that attribution onto
  the thread's canonical URL. Any change invalidates the URL's
  thread-derived attribution.
- `thread.archived` / `thread.unarchived` — changes Inbox visibility.
  Invalidates the Inbox's filter.
- `thread.deleted` — tombstones a thread. Same shape as
  `workstream.deleted`.

**Inferred-attribution mutators** (system-derived, overridable):
- `urls.attribution.inferred` — system suggests a URL attribution.
  Overridable by a later `user.organized.item`. Invalidates the URL
  row.
- `tabsession.attribution.inferred` — same shape for tab sessions.

**Other state mutators**:
- `privacy.gate.flipped` — toggles a subsystem gate. Re-gates
  engagement / similarity / visual eligibility for *future* events;
  past events are unaffected (the classifier already ran with the
  prior gate state).
- `privacy.permission.granted` / `privacy.permission.revoked` — same
  shape, narrower scope (host permission only).
- `queue.created` / `queue.statusSet` — queue projection.
- `dispatch.linked` — links a dispatch to a thread; refines an
  already-existing dispatch.
- `recall.tombstone.target` — removes an item from the recall index.

The design principle is more useful than the enumeration: **observation
streams fold incrementally; user-driven and system-derived state
mutators invalidate a specific, declared slice.** The full invalidation
table (M6 in the migration plan below) is a declarative mapping from
event type → set of affected slices; the incremental materializer reads
that table and re-projects only the named slices.

A helpful taxonomy for both halves. **"Append-only" does not always mean
"O(1) fold."** Timeline/engagement-style metadata folds cheaply per
event. Content/capture/extraction streams are append-only facts whose
*derived* work (chunking, embedding, recall index, content-similarity)
is heavy and belongs in a dedicated reconciliation lane.

| Group A — O(1) LEAF folds (hot-path safe) |
|---|
| `browser.timeline.observed` — patch one `byCanonicalUrl` row + one `bySessionId` row |
| `engagement.interval.observed` — fold into per-`visitId` accumulator |
| `engagement.session.aggregated` — same |
| `selection.copied` / `selection.pasted` — metadata-only; per-visit counter |
| `visual.fingerprint.observed` — per-`visitId` row |
| `coding.tick.observed` / `coding.session.turn.observed` / `coding.session.started` — per-session row |
| `dispatch.recorded` — per-dispatch row |

| Group B — heavy source streams (mark dirty, enqueue reconciliation) |
|---|
| `capture.recorded` — mark `sourceUnit` dirty; enqueue recall + content-similarity rebuild |
| `capture.extraction.produced` — mark `extractionRevision` + `sourceUnit` dirty; reuse embeddings by `embedTextHash` |
| (future) `page.content.extracted` — same shape as `capture.extraction.produced` |
| (future) content-similarity source units — same shape |

| Retroactive MUTATORS (invalidate declared slices) |
|---|
| `user.organized.item`, `user.engagement.relabeled`, `user.flow.confirmed`, `user.flow.rejected`, `user.topic.renamed`, `user.snippet.promoted` |
| `workstream.upserted`, `workstream.deleted` |
| `thread.upserted`, `thread.archived`, `thread.unarchived`, `thread.deleted` |
| `urls.attribution.inferred`, `tabsession.attribution.inferred` |
| `privacy.gate.flipped`, `privacy.permission.granted`, `privacy.permission.revoked` |
| `queue.created`, `queue.statusSet` |
| `dispatch.linked` |
| `recall.tombstone.target` |

Group B is what the **content / recall index lane** (W7 below) handles.
Workstream/user-organization mutators should NOT trigger chunk/embed
work; only Group B inserts + `embeddingModelRevision` / `chunkerVersion`
upgrades do.

## Why the current design chose batch rebuild

The original design optimized for two correctness properties:

1. **Byte-determinism** — snapshot is a pure function of the event
   log. Replay produces identical bytes.
2. **Correctness-under-replay** — rebuild from scratch always gives
   the right answer; no incremental bugs to chase.

Both are valuable. Both can be preserved.

## The core pattern — serve from snapshot, recompute non-blocking

The codebase ALREADY has the primitive this design needs: every heavy
sub-model lives behind an atomic-swap "current" store.

| Store | `putCurrent` semantics | `readCurrent` semantics |
|---|---|---|
| `connectionsStore` | atomic write-then-rename of snapshot JSON | latest committed snapshot |
| `topicRevisionStore` | new revision under `_BAC/connections/topic-revision/<rev>.json`; pointer file flips to active | active revision |
| `visitSimilarityRevision` | hash-keyed write under `_BAC/connections/visit-similarity/<rev>.json` | latest by revision id |
| `engagementClassStore` | same shape | same |
| `rankerRetrainState` | hash-gated; skips identical training | same |

These are precisely the "atomic swap-current pointer" abstraction the
non-blocking pattern needs. The materializer's `buildAndWrite()` already
produces a complete new snapshot and calls `store.putCurrent(snapshot)`;
after that returns, `readCurrent()` callers see the new version. Old
readers in flight keep their reference to the old version.

The design intent is right. Two implementation mistakes block its
benefit today:

### Mistake 1 — HTTP routes bypass the store

`/v1/visits/projection`, `/v1/visits/inbox`, `/v1/tabsessions/projection`,
`/v1/tabsessions/inbox`, and several POST routes re-derive projections
on every call:

```ts
const projection = projectUrls(await context.eventLog.readMerged());
```

The connectionsStore's snapshot ALREADY contains the projection internally
(line 408 of `connectionsMaterializer.ts` computes `urlProjection` and
feeds it into `buildConnectionsSnapshot`). The HTTP route should be a
single `await store.readCurrent()` and a field access. Instead it walks
the event log and re-projects.

Stage 5.0 caches (`urls/cachedProjection.ts`, `tabsession/cachedProjection.ts`)
are a half-fix — they cache the rebuild result in memory for 500 ms,
but the rebuild itself still runs on cache miss. The real fix is to
**stop calling `projectUrls(merged)` from HTTP routes at all**.

### Mistake 2 — Recompute runs on the HTTP / event-ingest thread

`buildAndWrite()` is triggered by `runner.onAcceptedEvent(event)`
(`connectionsMaterializer.ts:506`) which runs in the same Node event
loop as HTTP requests. While the rebuild churns through
`buildVisitSimilarity` + `buildSelectedTopicRevision` +
`buildConnectionsSnapshot`, nothing else on the loop progresses.
HTTP probes queue behind it and time out.

The store layer is async-ready (every `putCurrent` returns a Promise).
The *trigger* is per-event-on-hot-loop. To unblock the HTTP path while
preserving byte-determinism, the trigger needs to be:

- **Debounced** — coalesce a burst of N events into one rebuild
- **Off-thread** for the heaviest sub-passes (similarity embedding,
  topic clustering) — `worker_thread` keeps the main loop responsive
- **Periodic reconciliation** — every N minutes OR every M events,
  regardless of explicit triggers, to catch any incremental-fold drift

## Target shape

```
                ┌──────────────────────────┐
                │   HTTP read endpoints    │   always fast, O(1) lookup
                │   /v1/visits/projection  │   reads from store
                │   /v1/tabsessions/*      │   never blocks
                └──────────────┬───────────┘
                               │ store.readCurrent()
                               ▼
                ┌──────────────────────────┐
                │   Current snapshot       │   atomic pointer
                │   (incl. projections)    │   versioned, swap-on-write
                └──────────────┬───────────┘
                               ▲ atomic swap on reconcile completion
                               │
                ┌──────────────┴───────────┐
                │  Reconciliation worker   │   off-thread, debounced
                │  - rebuild similarity    │   60-80s OK; doesn't block
                │  - re-cluster topics     │
                │  - retrain ranker        │
                │  - rebuild snapshot      │
                └──────────────────────────┘
                               ▲
                ┌──────────────┴───────────┐
                │  Hot-path O(1) folds     │   per event, on event loop
                │  - engagement classifier │   < 1 ms each
                │  - URL projection patch  │
                │  - tab-session patch     │
                └──────────────────────────┘
                               ▲
                               │ events appended
                ┌──────────────┴───────────┐
                │  Event log (immutable)   │
                └──────────────────────────┘
```

Three properties this gives:

1. **Read path is O(1)** — every HTTP read serves a pre-materialized
   snapshot, never recomputes.
2. **Hot path is bounded** — per-event work is O(1) fold + at most a
   single accumulator update. Engagement events stop pegging the loop.
3. **Heavy recompute is non-blocking** — runs in a worker on a debounced
   schedule; HTTP path keeps serving the old snapshot until the new one
   atomic-swaps into the store.

Byte-determinism is preserved because the reconciliation worker IS the
full rebuild (same code path as today's `buildAndWrite`). The hot-path
folds are an optimization for low-latency between events; they can
drift slightly between reconciliations, and the next reconciliation
re-grounds them. A byte-equality property test (random event sequence
→ both paths → identical snapshot bytes) is the safety net.

## Hot path vs reconciliation — what each does per event

| Sub-model | Hot path (per event) | Reconciliation (periodic) |
|---|---|---|
| **Engagement classifier** (Group A) | Fold into `engagementByVisit[visitId]`. Update visit's class if threshold crossed. O(1). | Rebuild from scratch every 30 min for drift correction. |
| **URL projection patch** (Group A) | Update `byCanonicalUrl[url]` row for the new event's canonical URL. O(1). | Full `projectUrls(merged)` rebuild every 30 min. |
| **Tab-session projection patch** (Group A) | Same — patch `bySessionId[tabSessionId]`. O(1). | Full `projectTabSessions(merged)` rebuild every 30 min. |
| **Visit similarity** (W3) | Budgeted: if embedder warm + corpus under budget, embed + top-K insert (O(K log N)) and update displaced existing top-Ks. Otherwise mark `visitSimilarityDirty(sourceId)`. | Full pairwise rebuild on a coarse cadence (hourly) OR on demand. Byte-exact edge set. |
| **Topic clustering** (W4) | Add: union-find merge across V's similarity neighbors. Remove: affected-component rebuild restricted to the touched component. | Full re-cluster every 60 min. |
| **Ranker retrain** | No-op on hot path. | Already-gated: train if `newLabelCount ≥ 50`. Runs every 30 min. |
| **Snapshot graph** | Apply row-local delta (1 node add, K edge adds) to the current in-memory snapshot. | Full `buildConnectionsSnapshot` every 30 min. |
| **Content / recall index** (Group B → W7) | `dirtySourceUnits.add(sourceUnitId)`; debounce. No chunk / embed / index on event loop. | Worker pass: chunk + embed (with cache reuse by `embedTextHash`) + atomic source-unit replace + content-similarity revision swap. |

The cold-path rebuild that runs at companion boot is the reconciliation
worker running once with full force. Same code, same byte output.

## Snapshot writeback strategy — decision recommended

Two options:

1. **In-memory hot snapshot, lazy-persist** (recommended). Hot-path
   updates only the in-memory snapshot. The reconciliation worker
   writes to disk on completion. Crash recovery via cold-path replay
   on next boot — already exercised today.
2. **Write-through snapshot**. Every fold writes to disk. Higher
   correctness; defeats the whole point because disk I/O is the
   bottleneck the design avoids.

Option 1 is the right call. Companion crash recovery already exercises
the "rebuild from event log on boot" path; "loses ≤ N seconds of
derived state on crash" maps onto the existing failure mode exactly.

## Similarity & topics — the hardest two

Visit similarity (W3): a new visit's embedding needs comparison against
the top-K nearest. Two failure modes to design against:

- Embedding is not free; doing it on the hot path for every visit
  saturates CPU once content-aware similarity (Stage 5.1) lands.
- ANN-index inserts can be O(K log N) but only if the embedder is
  already warm; cold-start embed costs are seconds.

W3 handles this with a **budget gate**: hot-path insert only when the
embedder is warm and the corpus is small; otherwise mark dirty + defer
to the reconciliation worker. Byte-exact edge-set equality is
guaranteed by the worker, not the hot path.

Topic clustering (W4): union-find supports incremental *merge* but
not delete. Hot path handles add via union-find merge; remove (user
moves URL out, privacy gate masks, edge dropped after re-embed) via
**affected-component rebuild** — re-cluster only the touched
component. Full re-cluster moves to reconciliation as the
byte-equality oracle.

## Migration plan — two halves

The refactor splits cleanly along the two structural mistakes
identified above. **Half 1 (Read path)** stops HTTP routes from
re-deriving on every call; this alone removes the cache-and-rebuild
churn that Stage 5.0 papered over. **Half 2 (Write path)** moves the
recompute itself off the hot loop and folds Group-A leaf streams in
O(1).

Half 1 is a *semantics-preserving snapshot extension* — it adds two
fields to `ConnectionsSnapshot` and routes HTTP through them. Snapshot
bytes change (new fields) but the graph node/edge content does not.
Half 2 is the deeper structural change and introduces byte-equality
property tests as the safety net.

**What Stage 5.2 is — and is not.** This is not "make everything
incremental." It is:

1. Serve reads from committed snapshots, never from ad-hoc
   event-log projections.
2. Move expensive reconciliation off the HTTP / event-ingest loop.
3. Add O(1) hot folds only for Group-A projections that are truly
   row-local.
4. Treat content / indexing as a dirty-source reconciliation lane
   (W7), not a hot-path operation.
5. Use declarative invalidation for retroactive mutators.
6. Preserve full replay as the correctness oracle.

### Half 1 — Read path: serve from snapshot

The connectionsStore snapshot already contains `urlProjection` and
`tabSessionProjection` (computed during `buildAndWrite`). Switch every
HTTP route to read those fields from `store.readCurrent()` instead of
re-deriving from the event log. After this lands, the only path that
runs `projectUrls(merged)` is the materializer itself.

#### R1 — Surface projections on the snapshot type

`ConnectionsSnapshot` already passes `urlProjection` and
`tabSessionProjection` through `buildConnectionsSnapshot`, but neither
is exposed on the returned snapshot. Add them as top-level fields:

```ts
interface ConnectionsSnapshot {
  // …existing fields…
  readonly urlProjection: UrlProjection;
  readonly tabSessionProjection: TabSessionProjection;
}
```

This is a *semantics-preserving snapshot extension*, not a no-byte-change
refactor: bump `payloadVersion`, regenerate fixtures under
`packages/sidetrack-companion/src/connections/*.test.ts`.

**Acceptance bar:**
- Old snapshot loads gracefully (re-derive on first read until next
  `buildAndWrite`).
- New snapshot includes `urlProjection` and `tabSessionProjection`.
- Graph node/edge content is unchanged modulo the added fields.
- HTTP route output equals the pre-refactor `projectUrls(merged)` /
  `projectTabSessions(merged)` output for every fixture in
  `urls/projection.test.ts` and `tabsession/projection.test.ts`.

#### R2 — Route HTTP endpoints through the store

Replace the projection derivations at the five offending sites in
`packages/sidetrack-companion/src/http/server.ts`:

- `GET /v1/visits/projection` → `(await store.readCurrent()).urlProjection`
- `GET /v1/visits/inbox` → same, then filter to Inbox predicate
- `GET /v1/tabsessions/projection` → `(await store.readCurrent()).tabSessionProjection`
- `GET /v1/tabsessions/inbox` → same, filtered
- `POST /v1/visits/{url}/attribute` and `/resolve` — read attribution from snapshot, never re-project

**Acceptance:** HTTP wall-clock P99 for projection routes drops below
10 ms (currently 60–80 s under load). CDP regression
(`inspect-companion-status.mjs`) shows zero timeouts on a 5K-event
vault under engagement load.

#### R3 — Retire Stage 5.0 read-path caches

`packages/sidetrack-companion/src/urls/cachedProjection.ts` and
`packages/sidetrack-companion/src/tabsession/cachedProjection.ts`
become dead code once R2 lands. Delete them and their invalidation
hooks (`invalidateCachedUrlProjection`, `invalidateCachedTabSessionProjection`)
at all call sites in `http/server.ts`.

**Acceptance:** delete the two files + their import references; tests
that exercised the caches either delete or repoint to direct snapshot
reads.

#### R4 — Snapshot freshness contract

After Half 2 ships, HTTP reads serve up to the debounce window stale
(see W2). Before then, the HTTP path is exactly as fresh as today:
each `buildAndWrite` call swaps a new snapshot in. Half 1 alone changes
nothing about freshness; it only changes who PAYS for the projection
derivation.

The property to preserve through both halves: HTTP routes become
async-cheap; only the writer pays.

Two consumer-facing freshness contracts to land alongside R2:

**GET routes**: read `store.readCurrent()`. Response includes
`snapshotRevision` so the side panel can detect stale data and refetch
if needed. Default tolerance: side panel accepts up to the debounce
window stale (250 ms target).

**Resolver dry-run** (`POST .../resolve` with `dryRun: true`): may run
against committed snapshot; accepts debounce-window staleness; response
includes `snapshotRevision`.

**Resolver auto-apply** (`POST .../resolve` with `dryRun: false`): must
run against a *fresh-enough* snapshot. Two ways:
- Force a read-through for the affected slice (single-row, not full
  projection rebuild), OR
- Reject with `409 stale-snapshot` if the caller's `dependencyKey`
  doesn't match current `snapshotRevision`; caller retries.

The first option is preferable for UX; the second is the correctness
backstop. Stale *suggestions* are fine; stale *mutations* are not.

#### R5 — Read-your-writes for mutation routes

POST routes that mutate state historically returned the updated
projection slice in the same response (so the UI re-renders without
a follow-up GET). Switching them to read from `store.readCurrent()`
naively would return the *pre-mutation* snapshot until reconciliation
completes — that's a regression.

Rule for each mutation route:

```
POST /v1/visits/{url}/attribute        — must return updated URL projection slice
POST /v1/tabsessions/{id}/attribute    — must return updated tab-session slice
POST /v1/visits/{url}/resolve dryRun=false  — must return updated URL slice
POST /v1/tabsessions/{id}/resolve dryRun=false  — must return updated tab-session slice
```

Three options for satisfying this:

**Option A (preferred): hot-path fold + return folded slice.** Mutation
route appends the event, applies the row-local fold to the in-memory
projection (one `byCanonicalUrl[url]` or `bySessionId[id]` entry),
returns the folded slice. Reconciliation will re-ground it next pass.
This is exactly what Half 2's W2 hot-path folds enable for Group-A
events; mutation routes piggyback on the same accumulator.

**Option B: read-through for the affected row only.** Mutation route
runs a single-row `projectUrlsForOne(url)` against the event log
(not the full projection). Bounded cost, ~5 ms per call. Acceptable
fallback if Option A's accumulator isn't ready.

**Option C: optimistic response + revision token.** Returns
`{ accepted: true, snapshotRevision: previous, pendingProjection: true }`;
UI optimistically renders the change. Acceptable for non-critical
flows but adds UI complexity.

Half 1 implementation should ship Option B (single-row read-through)
to unblock Half 1's HTTP route refactor without depending on Half 2's
accumulator. Half 2 W2 upgrades the route to Option A.

**Acceptance:** for each mutation route, the response includes the
*updated* projection slice; an integration test asserts the slice
reflects the just-appended event.

### Half 2 — Write path: hot-path folds, off-thread recompute

The write path has two jobs: keep per-event work bounded (hot path)
and run the expensive byte-deterministic rebuild without blocking the
event loop (reconciliation).

#### W1 — Move `buildAndWrite` off the event loop

Wrap the materializer in a debounce + worker-thread shell. Trigger
contract stays the same (`runner.onAcceptedEvent`), but the work runs
in a `worker_thread` and the trigger only enqueues. Burst of N events
in T seconds → one rebuild after the debounce window.

```ts
class ReconcileQueue {
  private pending = false;
  private inFlight: Promise<void> | null = null;
  schedule(): void { this.pending = true; void this.drain(); }
  private async drain(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = (async () => {
      while (this.pending) {
        this.pending = false;
        await runInWorker('reconcile', { snapshot: store.readCurrent() });
        // worker returns new snapshot; store.putCurrent swaps it in
      }
    })().finally(() => { this.inFlight = null; });
  }
}
```

The HTTP path keeps serving whatever the store currently holds; the
swap is atomic when the worker's putCurrent lands.

**Acceptance:** CPU profile shows the main thread idle during rebuild
(< 5 % main, ~100 % on worker); `/v1/status` P99 stays under 200 ms
during a 5K-event reconciliation.

#### W2 — Hot-path O(1) folds for leaf streams

For the append-only LEAF stream events (table above), fold into an
in-memory accumulator on the main thread synchronously. The
accumulators live on the same object the worker hands back as its
"current state" so the worker can refold them on the next
reconciliation without state divergence.

Sub-tracks W2a–W2c (any order; each is independent):

- **W2a — Streaming engagement classifier.** Replace
  `buildEngagementClassifierInputs(merged)` with a per-`visitId`
  accumulator. Past visits' classifications never recompute.
- **W2b — URL projection patch.** Replace `projectUrls(merged)` with
  a stateful mutator that updates exactly the affected
  `byCanonicalUrl[url]` row per event.
- **W2c — Tab-session projection patch.** Same shape for
  `projectTabSessions`.

**Acceptance per sub-track:** byte-equality property test —
`fast-check`-generated event sequences run through both paths produce
identical bytes for the affected slice.

#### W3 — Budgeted incremental visit similarity

Embedding is *not* a safe default hot-path operation. For metadata-only
similarity with a warm embedder and small corpus it may be acceptable;
for content-aware similarity (Stage 5.1 T7c) it is not.

The hot path runs a budget gate:

```
on new visit V:
  if embedder is warm AND corpus size < BUDGET AND p99 embed-latency < 50 ms:
    embed V
    insert into in-memory similarity index
    return new edges
  else:
    mark visitSimilarityDirty(V.sourceId)
    enqueue worker reconciliation
    return immediately (no new edges this tick)
```

Worker reconciliation computes embeddings, updates the ANN / inverted
index, writes a similarity revision, and atomic-swaps current.

**Edge-set semantics on hot insert.** A new visit V's top-K neighborhood
includes new V→existing edges. V may also enter older visits' top-K
neighborhoods, evicting weaker edges. The hot path *should* recompute
existing-visits' top-K when V's score beats their current Kth neighbor,
but should NOT do a full pairwise pass.

**Acceptance bar (split between paths):**
- Hot path: bounded affected-neighborhood update — for the inserted
  visit and at most O(K) existing visits whose top-K is displaced.
- Reconciliation: byte-exact edge-set equality between incremental
  state and full pairwise rebuild.

Requiring exact full-corpus equality after every hot insert would push
implementation back toward O(N²). The byte-exactness property lives in
the reconciliation worker; the hot path is the responsiveness
optimization.

#### W4 — Incremental topic clustering with removal-aware fallback

Union-find supports incremental *merges* cleanly: new visit V with
similarity edges to visits {A, B, C} joins the union of components of
A, B, C (or starts a new one). This covers most events.

It does NOT support deletes / splits. Operations that REMOVE edges
need a different path:

- `user.organized.item` moves a URL between workstreams (removes
  workstream-membership edge)
- `privacy.gate.flipped` masks similarity for a gated time window
- Similarity edge dropped after re-embedding (e.g., model upgrade
  shifted relative distances)
- `workstream.deleted` orphans visits

For these, hot path runs **affected-component rebuild**: find the
union-find component(s) touching the removed edge, re-cluster *that
component only* using the current edge set. Cost is O(|component|) —
typically small, not full corpus.

```
on edge removal R(A, B):
  comp_A = uf.find(A); comp_B = uf.find(B)
  if comp_A == comp_B:
    members = uf.membersOf(comp_A)
    reset members; re-cluster using current edge set restricted to members
```

Worker reconciliation owns the full re-cluster as the byte-determinism
oracle.

**Acceptance:**
- Hot-path add: union-find merge yields same membership as worker
  reconciliation.
- Hot-path remove: affected-component rebuild yields same membership
  as worker reconciliation for the involved components.

#### W5 — Store-level diffing, external API unchanged

`connectionsStore.putCurrent(snapshot)` accepts a complete snapshot as
today. The store may internally diff against the previous current and
write only changed regions, but that's an implementation detail —
callers continue to hand it a full snapshot.

```ts
// External API (unchanged):
store.putCurrent(snapshot)
store.readCurrent(): Promise<ConnectionsSnapshot>

// Internal implementation MAY:
// - keep last-committed snapshot in memory
// - compute byte-diff against previous
// - write region-keyed deltas to disk
// - reconstruct full snapshot on readCurrent if needed
```

Explicit `applyDelta({ addedNodes, addedEdges, ... })` is NOT exposed
to callers in this stage. Every consumer (HTTP routes, materializer,
side panel) treats the store as "give me a snapshot." If store-level
diffing later becomes the bottleneck (it likely won't — snapshots are
~200 KB), an explicit delta API is a backward-compatible upgrade.

**Acceptance:** byte-identity between `N delta-applied snapshots` and
`one full rebuild` over the same event sequence; HTTP route output is
unchanged across the refactor.

#### W6 — Declarative invalidation table for retroactive mutators

The ~15 retroactive mutator event types each trigger re-projection of
declared slices. Implement as a single declarative map; the
reconciliation worker reads it instead of branching on event type
inside the materializer.

```ts
type InvalidationKey =
  | { kind: 'url'; canonicalUrl: string }
  | { kind: 'tabSession'; tabSessionId: string }
  | { kind: 'thread'; bacId: string }
  | { kind: 'workstream'; bacId: string }
  | { kind: 'workstreamTree' }              // structural change
  | { kind: 'workstreamPathMemo'; bacId: string }   // path memo entries traversing bacId
  | { kind: 'engagementVisit'; visitId: string }
  | { kind: 'topicMember'; visitId: string }
  | { kind: 'queue'; itemId: string }
  | { kind: 'rankerLabels' }                // batch-level
  | { kind: 'inboxFilter' }                 // Inbox visibility predicate

  // Group B (content / recall index lane — see W7):
  | { kind: 'sourceUnit'; sourceUnitId: string }
  | { kind: 'extractionRevision'; extractionRevisionId: string }
  | { kind: 'recallIndex'; sourceUnitId: string }
  | { kind: 'contentSimilarity'; sourceUnitId: string }
  | { kind: 'contentEvidence'; sourceUnitId: string }
  | { kind: 'resolverAnchors'; nodeIds: readonly string[] }
  | { kind: 'embeddingModelRevision' }      // batch-level — re-embed all
  | { kind: 'chunkerVersion' };             // batch-level — re-chunk all

const INVALIDATION_RULES: Record<EventType, (event: AcceptedEvent) => InvalidationKey[]> = {
  'user.organized.item': (e) => {
    const k = e.payload.itemKind;
    if (k === 'canonical-url') return [{ kind: 'url', canonicalUrl: e.payload.itemId }];
    if (k === 'tab-session')   return [{ kind: 'tabSession', tabSessionId: e.payload.itemId }];
    if (k === 'thread')        return [{ kind: 'thread', bacId: e.payload.itemId }];
    return [];
  },
  'user.engagement.relabeled': (e) =>
    [{ kind: 'engagementVisit', visitId: e.payload.visitId },
     { kind: 'rankerLabels' }],
  'user.flow.confirmed':   (e) => e.payload.visitIds.map(v => ({ kind: 'topicMember' as const, visitId: v })),
  'user.flow.rejected':    (e) => e.payload.visitIds.map(v => ({ kind: 'topicMember' as const, visitId: v })),
  'workstream.upserted':   (e) => [{ kind: 'workstream', bacId: e.payload.bac_id },
                                   { kind: 'workstreamTree' },
                                   { kind: 'workstreamPathMemo', bacId: e.payload.bac_id }],
  'workstream.deleted':    (e) => [{ kind: 'workstream', bacId: e.payload.bac_id },
                                   { kind: 'workstreamTree' },
                                   { kind: 'workstreamPathMemo', bacId: e.payload.bac_id }],
  'thread.upserted':       (e) => [{ kind: 'thread', bacId: e.payload.bac_id },
                                   { kind: 'url', canonicalUrl: e.payload.canonicalUrl }],
  'thread.archived':       (e) => [{ kind: 'thread', bacId: e.payload.bac_id },
                                   { kind: 'inboxFilter' }],
  'thread.unarchived':     (e) => [{ kind: 'thread', bacId: e.payload.bac_id },
                                   { kind: 'inboxFilter' }],
  'thread.deleted':        (e) => [{ kind: 'thread', bacId: e.payload.bac_id },
                                   { kind: 'inboxFilter' }],
  'urls.attribution.inferred':       (e) => [{ kind: 'url', canonicalUrl: e.payload.canonicalUrl }],
  'tabsession.attribution.inferred': (e) => [{ kind: 'tabSession', tabSessionId: e.payload.tabSessionId }],
  'privacy.gate.flipped':            ()  => [],   // see Privacy gate semantics section below
  'queue.created':                   (e) => [{ kind: 'queue', itemId: e.payload.itemId }],
  'queue.statusSet':                 (e) => [{ kind: 'queue', itemId: e.payload.itemId }],

  // Group B — content / recall index lane (W7):
  'capture.recorded':                (e) => [
    { kind: 'sourceUnit', sourceUnitId: e.payload.sourceUnitId },
    { kind: 'recallIndex', sourceUnitId: e.payload.sourceUnitId },
    { kind: 'contentSimilarity', sourceUnitId: e.payload.sourceUnitId },
  ],
  'capture.extraction.produced':     (e) => [
    { kind: 'sourceUnit', sourceUnitId: e.payload.sourceUnitId },
    { kind: 'extractionRevision', extractionRevisionId: e.payload.extractionRevisionId },
    { kind: 'recallIndex', sourceUnitId: e.payload.sourceUnitId },
    { kind: 'contentSimilarity', sourceUnitId: e.payload.sourceUnitId },
  ],
  'recall.tombstone.target':         (e) => [
    { kind: 'sourceUnit', sourceUnitId: e.payload.sourceUnitId },
    { kind: 'recallIndex', sourceUnitId: e.payload.sourceUnitId },
    { kind: 'contentSimilarity', sourceUnitId: e.payload.sourceUnitId },
    { kind: 'resolverAnchors', nodeIds: e.payload.affectedNodeIds ?? [] },
  ],
  // ...
};
```

The design rule that falls out of this table:

- **Organization mutations** (`user.organized.item`, `workstream.*`,
  `thread.*`) never invalidate `sourceUnit` / `recallIndex` /
  `contentSimilarity`. Moving a URL between workstreams does NOT
  re-embed its content.
- **Content mutations** (`capture.*`, `recall.tombstone.*`) only
  invalidate Group B keys; they do not invalidate workstream/thread
  projections except via `resolverAnchors` (which represents
  resolver-evidence that referenced the affected source).

Three important properties:

1. **`workstream.upserted` returns BOTH** the specific workstream
   slice AND `workstreamTree` AND `workstreamPathMemo`. Renaming X
   invalidates X's label AND every URL/tabSession whose
   `currentAttribution.workstreamId` resolves a display path through
   X (which is "any descendant of X plus X itself"). The materializer
   holds a `workstreamId → resolved-path` memo; the
   `workstreamPathMemo` key invalidates memo entries whose path
   includes the changed bac_id (the renamed/moved node + all its
   descendants).
2. **`workstream.deleted` may orphan attributions.** The reducer
   should NOT mutate the attribution row's `workstreamId` field —
   that violates byte-determinism if the deletion is later undone on
   a peer. Instead, mark the workstream node as `tombstoned: true`
   in the snapshot, and let the side panel render orphaned
   attributions as such. Re-attribution becomes a user action
   (`user.organized.item`) rather than an automatic recovery. The
   `workstreamPathMemo` key invalidates display paths that traverse
   the deleted node; the attribution fact stays untouched.
3. **Organization mutations don't trigger Group B work.** Moving a
   URL between workstreams invalidates the URL's attribution row but
   never its `sourceUnit` / `recallIndex` / `contentSimilarity`
   keys. Re-embedding only happens when content actually changes
   (`capture.*`) or when batch keys flip (`embeddingModelRevision`,
   `chunkerVersion`).

**Acceptance:** invalidation-trace test — for each mutating event
type listed in the audit, the exact set of recomputed slices matches
the documented rule. Property-test fixture: generate a random event
sequence, run incremental + rebuild paths, assert identical slice
content after each invalidation. Negative-property test: assert
`user.organized.item` does NOT produce any `sourceUnit` /
`recallIndex` / `contentSimilarity` keys.

#### W7 — Content / recall index lane

Group B (`capture.recorded`, `capture.extraction.produced`,
`recall.tombstone.target`, plus future `page.content.extracted`) is
append-only at the event-log level but expensive at the derived-state
level: each event triggers chunking, embedding, recall index update,
and content-similarity revision. W7 keeps that work *off* the hot
path by treating source units as a dirty queue.

**Hot path** (synchronous, runs on event ingest):

```
on capture.recorded(sourceUnitId, ...):
  dirtySourceUnits.add(sourceUnitId)
  scheduleContentReconcile()  // debounced

on capture.extraction.produced(sourceUnitId, extractionRevisionId, ...):
  dirtySourceUnits.add(sourceUnitId)
  latestExtractionFor[sourceUnitId] = extractionRevisionId
  scheduleContentReconcile()

on recall.tombstone.target(sourceUnitId, ...):
  tombstonedSourceUnits.add(sourceUnitId)
  scheduleContentReconcile()
```

No chunking, no embedding, no index writes on the event loop.

**Content reconciliation worker** (off-thread, debounced):

```
for sourceUnitId in dirtySourceUnits:
  if sourceUnitId in tombstonedSourceUnits:
    recallIndex.removeBySourceUnit(sourceUnitId)
    contentSimilarity.removeBySourceUnit(sourceUnitId)
    continue

  extractionRev = latestExtractionFor[sourceUnitId]
  chunks = chunker(extractionRev.content, chunkerVersion)
  embeddings = chunks.map(c =>
    embeddingCache.get(c.embedTextHash, embeddingModelRevision)
      ?? embedder.embed(c, embeddingModelRevision))
  recallIndex.replaceBySourceUnit(sourceUnitId, chunks, embeddings)
  contentSimilarity.invalidateForSourceUnit(sourceUnitId)
  resolverEvidence.invalidate({ kind: 'contentEvidence', sourceUnitId })

contentSimilarity.recompute(dirtySourceUnits)
contentSimilarityRevision.swapCurrent(newRevision)
```

Key properties:

- **Embedding cache keyed by `(embedTextHash, embeddingModelRevision)`.**
  If chunk text hasn't changed, embedding is reused — no recompute.
- **`replaceBySourceUnit` is atomic at the source-unit granularity.**
  Recall queries during reconciliation either see the old source's
  chunks or the new ones, never a partial mix.
- **Content-similarity invalidation is per source unit**, not whole
  corpus. Existing source-to-source edges that don't touch the dirty
  source remain.

**Full rebuild required** when batch keys flip:
- `embeddingModelRevision` changes → re-embed every chunk (worker pass
  rate-limited; runs over hours, not minutes).
- `chunkerVersion` changes → re-chunk every source then re-embed.
- `extractionSchemaVersion` changes → re-extract upstream (separate
  pipeline; W7 only consumes the latest extraction).
- `contentSimilarityProducerVersion` changes → re-compute all edges.

These are batch-level operations, not event-driven. They live behind
a manual trigger or migration script.

**Acceptance:**
- `capture.recorded` doesn't run chunk/embed on event loop (CPU
  profile shows main thread idle on capture ingest).
- Embedding cache hit rate > 95 % when only attribution changes
  (no actual content change).
- Source-unit replacement is atomic — concurrent recall queries see
  consistent chunk sets.
- `user.organized.item` doesn't invalidate any Group B key.

### Privacy gate semantics — explicit decision

`privacy.gate.flipped` deserves a deliberate choice between two
plausible semantics; the invalidation cost depends on which is picked.

**Option F — future-only gate (recommended for v1).** The gate affects
observation from this point forward. Old derived artifacts stay
visible. `privacy.gate.flipped` invalidates nothing in the snapshot;
it changes the predicate the recorder applies when emitting new events.

- Invalidation cost: O(1)
- Implementation: extension recorder consults the current gate state
  before admitting a `browser.timeline.observed` / `engagement.*` /
  `selection.*` event. Companion side does nothing.

**Option G — retroactive derived-view mask.** The gate also masks
materialized views for events in gated time windows. Old events stay in
the log but derived caches hide them.

- Invalidation cost: large. `privacy.gate.flipped` invalidates:
  `engagementVisit[*]` (for visits in the gated window),
  `topicMember[*]`, `rankerLabels`, `contentEvidence[*]`,
  `resolverAnchors[*]`. Potentially full snapshot rebuild.
- Implementation: materializer applies a "visible visit" filter at
  every projection step.

Given the local-first / privacy posture, Option F is the right
default. The user's mental model is "starting now, don't record X";
they don't expect toggling the gate to erase yesterday's view. If a
user wants retroactive deletion they have `recall.tombstone.target`
(per-source-unit) or full vault deletion (manual).

**Implementation rule:** `INVALIDATION_RULES['privacy.gate.flipped']`
returns `[]`. The recorder side handles the future-only enforcement.
A separate `privacy.gate.scrubbed` event (if ever needed) would
trigger Option G semantics for an explicit retroactive scrub — but
that's a future concern, not this stage.

**Acceptance:** flipping the gate does not trigger a connectionsStore
write; existing snapshot bytes are unchanged. The recorder stops
emitting gated event types from the moment of the flip.

### Sequencing rationale

Half 1 ships first because it's a semantics-preserving snapshot
extension — adds two fields to `ConnectionsSnapshot` and routes HTTP
to them. The user-visible benefit (HTTP responsiveness) lands without
touching the materializer internals. R5's mutation-route Option B
(single-row read-through) keeps read-your-writes working without
depending on Half 2.

Half 2 follows because it depends on Half 1's snapshot shape (W2's
in-memory accumulators have the same shape as R1's `urlProjection`
field) and because W1's worker-thread move is best done once the read
path no longer cares whether the writer is mid-rebuild. W2 upgrades
the mutation routes from Option B to Option A (hot-path fold + return
folded slice).

W7 (content / recall index lane) can ship alongside or after W1–W6.
It depends on W1 (worker-thread reconciliation) but is otherwise
independent of W2–W6.

Stage 5.1 (T7a–T7d content-aware similarity) overlaps with W7. If
Stage 5.1 lands first, W7 must consume its content-similarity
revisions; if Stage 5.2 lands first, Stage 5.1 plugs into W7's dirty
source-unit queue as the content evidence producer. The W3 budget
gate accounts for either order — content embedding is always Group B
work, never hot path.

## Risks & open questions

1. **Byte-determinism across versions** — incremental folds may
   produce different snapshot bytes than the full rebuild if fold
   order doesn't strictly match event-log order. Mitigation: the
   reconciliation worker IS the rebuild; hot-path folds preserve
   order via the contract runner's serial `onAcceptedEvent`
   invocation. Byte-equality property tests gate every W-track.
2. **Reconciliation worker cost** — W1's debounced rebuild still
   costs 60–80 s on a 5K-event vault. Schedule on a coarse cadence
   (hourly OR after N events). Even if it costs 80 s, it runs off
   the main thread and doesn't block HTTP — the worst case is "the
   snapshot is 30 minutes stale," which the side panel can tolerate.
3. **Memory cost** — in-memory accumulators grow with the event log.
   ~5K events yields ~200 KB; not concerning. Could add a tier-3
   eviction for cold visits (older than 30 days) if memory becomes a
   problem.
4. **Test fixture rewrite** — current tests do
   `writeEvents() → expect(snapshot)`. Need a parallel pattern
   `writeEvents() + run hot-path folds → expect(snapshot)` for
   incremental coverage. Plan to wrap both paths behind a single
   harness so existing fixtures cover both.
5. **Snapshot freshness after Half 2** — HTTP reads serve up to the
   debounce window stale (default proposal: 250 ms). R4 makes this
   explicit via `snapshotRevision` in responses. The resolver
   dry-run path is fine with stale snapshots; the resolver
   auto-apply path requires the R4 dependency-key check (or a
   single-row read-through) — NOT a blanket assumption that resolver
   reads the event log directly. Audit the current resolver paths
   against this contract during Half 1 implementation.
6. **Group B reconciliation cadence** — W7's chunk/embed/index lane
   has its own cadence (independent of W1's snapshot reconciliation).
   Need explicit budgets: max concurrent embeds, max work-per-tick,
   embedding cache size. If `embeddingModelRevision` flips, the
   re-embed-all pass should rate-limit (one source per N seconds)
   to avoid pegging CPU for hours.
7. **Worker stale-output races** — concurrent worker passes (W1 +
   W7) could race on snapshot writes. Need a revision token check:
   each worker reads `snapshotRevision` at start, refuses to swap if
   a newer revision has already landed. See verification case #9.

## Verification approach

For each R/W track:

1. **Byte-equality property test** — generate random event sequences
   with `fast-check`, run both the reconciliation rebuild and the
   incremental hot-path, assert identical snapshot bytes for the
   slice the track owns.
2. **Performance test** — CPU profile a 5,000-event vault going
   through 100 new events at 30 s intervals. Pre-refactor: 60–80 s
   per rebuild ≈ continuous saturation. Post-Half-1 target: HTTP
   P99 < 50 ms regardless of writer activity. Post-Half-2 target:
   < 5 ms per event in the hot path; reconciliation runs without
   pegging the main thread.
3. **CDP regression** — recorder running with engagement load,
   `inspect-companion-status.mjs` polls `/v1/status` every 15 s for
   30 minutes; pass criterion: zero timeouts, P99 < 200 ms.

Track-specific cases:

4. **R2 route equivalence** — for every projection HTTP route, assert
   the post-refactor response equals the pre-refactor
   `projectUrls(merged)` / `projectTabSessions(merged)` output across
   the full test fixture corpus.
5. **R5 read-your-writes** — for each mutation route
   (`POST /v1/visits/{url}/attribute`, `.../resolve`,
   `/v1/tabsessions/{id}/attribute`, `.../resolve`), assert the
   response body contains the updated projection slice immediately
   (the just-appended event is reflected). Test under both Option B
   (single-row read-through) and Option A (hot-path fold) paths.
6. **Resolver freshness** — dry-run accepts stale snapshot and
   returns `snapshotRevision` in response; auto-apply rejects with
   `409 stale-snapshot` when `dependencyKey` doesn't match current,
   succeeds otherwise.
7. **W7 content lane** — `capture.recorded` ingest does not chunk /
   embed / index on the main event loop (CPU profile assertion).
   `capture.extraction.produced` with unchanged `embedTextHash`
   reuses the embedding cache (zero embedder calls). Source-unit
   replacement is atomic across concurrent recall queries.
8. **W7 negative property** — `user.organized.item`,
   `workstream.upserted`, `thread.upserted` do NOT invalidate any
   `sourceUnit` / `recallIndex` / `contentSimilarity` keys.
9. **Worker stale-output guard** — if worker A starts at
   `snapshotRevision = 10` and worker B starts at revision 12 and
   completes first, worker A's late completion must NOT overwrite
   the current snapshot. Assert via a forced-interleave fixture.
10. **W4 topic removal** — issue an edge-removal sequence (e.g.,
    user moves URL out of workstream); assert affected-component
    rebuild yields the same membership as full reconciliation.
11. **Privacy gate (Option F)** — flipping
    `privacy.gate.flipped` does not trigger a connectionsStore
    write; existing snapshot bytes are unchanged. The recorder
    stops emitting gated event types from the moment of the flip.

## Out of scope (for this design doc)

- **`/v1/system/health` directorySize** — separate fix; ~10 lines;
  doesn't need a refactor.
- **CI safety net** for `connections-full-browser-sync-user-story.spec.ts`
  — infrastructure work, separate PR / owner.
- **Inbox pagination UI** — front-end-only; not blocking.
- **Resolver auto-apply caller wiring** — sequenced with Stage 5.1 /
  T7a as the most natural pairing (content evidence is the strongest
  candidate trigger for resolver auto-apply).

## Open questions for review

Three decisions worth explicit acknowledgement before this becomes an
implementation prompt; each has a recommendation below.

### Q1 — Privacy gate semantics (Option F vs Option G)

See "Privacy gate semantics" section above. **Recommended: Option F
(future-only)** for v1. Option G (retroactive derived-view mask) is a
larger architectural commitment and not required by current product
asks. Reserve the door for a separate `privacy.gate.scrubbed` event
if retroactive scrub is needed later.

### Q2 — R5 mutation route response shape (Option A vs B vs C)

**Recommended: ship Option B with Half 1**, upgrade to Option A as
part of W2. Option B (single-row read-through) is a 5-ms cost per
mutation route call and doesn't depend on Half 2's accumulator
landing. Option A (hot-path fold + return slice) is the long-term
target; Option C (optimistic response) is acceptable for non-critical
flows but adds UI complexity not worth taking on now.

### Q3 — W5 store contract (full snapshot vs explicit delta)

**Recommended: keep the full-snapshot external API.** The store may
internally diff and write region-keyed deltas, but every caller
continues to hand it a complete snapshot via `putCurrent(snapshot)`.
Explicit `applyDelta()` is deferred until a consumer audit confirms
it's needed; snapshot bytes (~200 KB) suggest it likely won't be.

Defer all three decisions to implementation but record the
recommendations.

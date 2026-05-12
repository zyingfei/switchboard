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

A helpful taxonomy for both halves:

| Append-only LEAF streams (fold in O(1) forever) |
|---|
| `browser.timeline.observed` |
| `engagement.interval.observed` |
| `engagement.session.aggregated` |
| `selection.copied` / `selection.pasted` |
| `visual.fingerprint.observed` |
| `capture.recorded` / `capture.extraction.produced` |
| `coding.tick.observed` / `coding.session.turn.observed` / `coding.session.started` |
| `dispatch.recorded` |

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
| **Engagement classifier** | Fold the new event into `engagementByVisit[visitId]`. Update visit's class if threshold crossed. O(1). | Rebuild from scratch every 30 min for drift correction. |
| **URL projection patch** | Update `byCanonicalUrl[url]` row for the new event's canonical URL. O(1). | Full `projectUrls(merged)` rebuild every 30 min. |
| **Tab-session projection patch** | Same — patch `bySessionId[tabSessionId]`. O(1). | Full `projectTabSessions(merged)` rebuild every 30 min. |
| **Visit similarity** | If event is `browser.timeline.observed` with a new visit: embed + top-K insert into the in-memory ANN index. O(K log N). | Full pairwise rebuild every 60 min OR on demand. |
| **Topic clustering** | If new similarity edges link the new visit to existing components, union-find merge. O(1) amortized. | Full re-cluster every 60 min. |
| **Ranker retrain** | No-op on hot path. | Already-gated: train if `newLabelCount ≥ 50`. Runs every 30 min. |
| **Snapshot graph** | Apply minimal delta (1 node add, K edge adds) to the current in-memory snapshot. | Full `buildConnectionsSnapshot` every 30 min. |

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

Visit similarity needs a new visit's embedding compared against the
top-K nearest. Hot-path options:

- **Insert-only ANN**: maintain an in-memory ANN index (`hnswlib-node`,
  or a simple K-nearest map sorted by recency). New visit → embed →
  query top-K → add K new edges. O(K log N) per visit, not O(N×N).
- **Lexical fallback**: same shape; maintain an in-memory inverted
  index over tokenized titles/URLs; query by Jaccard. O(K) per visit.

Topic clustering: union-find supports incremental merge naturally.
On new visit V with similarity edges to existing visits {A, B, C}, V
joins the cluster containing A∪B∪C (or creates a new cluster). The
full re-cluster pass moves to reconciliation, not per-event.

## Migration plan — two halves

The refactor splits cleanly along the two structural mistakes
identified above. **Half 1 (Read path)** stops HTTP routes from
re-deriving on every call; this alone removes the cache-and-rebuild
churn that Stage 5.0 papered over. **Half 2 (Write path)** moves the
recompute itself off the hot loop and folds leaf streams in O(1).

Half 1 ships independently and unblocks the side panel without
changing snapshot bytes. Half 2 is the deeper structural change and
introduces byte-equality property tests as the safety net.

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

This is a snapshot-format change; bump `payloadVersion` and add a
fixture-regen for the existing golden tests under
`packages/sidetrack-companion/src/connections/*.test.ts`.

**Acceptance:** snapshot tests regenerate; loading an older snapshot
from disk degrades gracefully (re-derive on first read until next
`buildAndWrite`).

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

#### R4 — Snapshot freshness guarantee

After Half 2 ships, HTTP reads serve up to the debounce window stale
(see W2). Before then, the HTTP path is exactly as fresh as today:
each `buildAndWrite` call swaps a new snapshot in. Half 1 alone changes
nothing about freshness; it only changes who PAYS for the projection
derivation.

This is the property to preserve through both halves: HTTP routes
become async-cheap; only the writer pays.

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

#### W3 — Incremental visit similarity

In-memory similarity index (hnswlib-node or sorted top-K). New visit
inserts in O(K log N); existing-existing edges remain stable across
inserts. Full pairwise rebuild stays in the reconciliation worker as
the periodic safety net.

**Acceptance:** edge-set equality across the existing similarity test
corpus. Wall-clock per-visit insert < 50 ms on a 5K-visit index.

#### W4 — Incremental topic clustering

Union-find supports incremental merge directly. New visit V with
similarity edges to visits {A, B, C} → V joins the union of components
of A, B, C (or starts a new one). Full re-cluster runs in
reconciliation.

**Acceptance:** cluster-membership equality between hot-path merge +
reconciliation rebuild.

#### W5 — Snapshot delta application

`store.putCurrent` accepts an optional delta hint so disk writes are
O(delta) not O(snapshot). Two shapes considered:

```ts
// Option A — full snapshot, store diffs internally
store.putCurrent(snapshot);

// Option B — explicit delta
store.applyDelta({ addedNodes, addedEdges, updatedAttributions });
```

Option A keeps the store's external contract identical; the store
computes the diff against the previous current. Easier to roll out.

**Acceptance:** byte-identity between `N delta applications` and `one
full rebuild` over the same event sequence.

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
  | { kind: 'engagementVisit'; visitId: string }
  | { kind: 'topicMember'; visitId: string }
  | { kind: 'queue'; itemId: string }
  | { kind: 'rankerLabels' }                // batch-level
  | { kind: 'inboxFilter' };                // Inbox visibility predicate

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
                                   { kind: 'workstreamTree' }],
  'workstream.deleted':    (e) => [{ kind: 'workstream', bacId: e.payload.bac_id },
                                   { kind: 'workstreamTree' }],
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
  'privacy.gate.flipped':            ()  => [],   // affects future events only
  'queue.created':                   (e) => [{ kind: 'queue', itemId: e.payload.itemId }],
  'queue.statusSet':                 (e) => [{ kind: 'queue', itemId: e.payload.itemId }],
  // ...
};
```

Two important properties:

1. **`workstream.upserted` returns BOTH** the specific workstream
   slice AND `workstreamTree`. Renaming X invalidates X's label AND
   every URL/tabSession whose `currentAttribution.workstreamId`
   resolves a display path through X (which is "any descendant of X
   plus X itself"). The materializer reads the affected
   `workstreamTree` key as "rebuild any path-derived display labels
   that traverse the changed node." Practical implementation: hold a
   `workstreamId → resolved-path` memo, invalidate the memo entries
   whose path includes the changed bac_id.
2. **`workstream.deleted` may orphan attributions.** The reducer
   should NOT mutate the attribution row's `workstreamId` field —
   that violates byte-determinism if the deletion is later undone on
   a peer. Instead, mark the workstream node as `tombstoned: true`
   in the snapshot, and let the side panel render orphaned
   attributions as such. Re-attribution becomes a user action
   (`user.organized.item`) rather than an automatic recovery.

**Acceptance:** invalidation-trace test — for each mutating event
type listed in the audit, the exact set of recomputed slices matches
the documented rule. Property-test fixture: generate a random event
sequence, run incremental + rebuild paths, assert identical slice
content after each invalidation.

### Sequencing rationale

Half 1 ships first because it's a pure read-path refactor with no
byte-format change to the existing computation — only adds two fields
to `ConnectionsSnapshot` and routes HTTP to them. The user-visible
benefit (HTTP responsiveness) lands without touching the materializer
internals.

Half 2 follows because it depends on Half 1's snapshot shape (W2's
in-memory accumulators have the same shape as R1's `urlProjection`
field) and because W1's worker-thread move is best done once the read
path no longer cares whether the writer is mid-rebuild.

Stage 5.1 (T7a–T7d content-aware similarity) is independent of both
halves. If Stage 5.1 lands first, W3 must account for content-similarity
edges; if Stage 5.2 lands first, Stage 5.1 adds a new edge producer to
W3's index.

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
   debounce window stale (default proposal: 250 ms). Acceptable for
   side-panel UI; verify the resolver isn't sensitive to single-event
   lag (it shouldn't be — resolver runs against the event log, not
   the snapshot).

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

## Out of scope (for this design doc)

- **`/v1/system/health` directorySize** — separate fix; ~10 lines;
  doesn't need a refactor.
- **CI safety net** for `connections-full-browser-sync-user-story.spec.ts`
  — infrastructure work, separate PR / owner.
- **Inbox pagination UI** — front-end-only; not blocking.
- **Resolver auto-apply caller wiring** — sequenced with Stage 5.1 /
  T7a as the most natural pairing (content evidence is the strongest
  candidate trigger for resolver auto-apply).

## Open question for review

The biggest design call: **option A (full snapshot, store-computed
diff) vs option B (explicit delta) for W5 writeback**. Option A keeps
the store's external contract identical; the store internally diffs
against the previous current. Option B exposes the delta shape to the
caller — cleaner semantics but every caller now has to construct one.

My recommendation is option A, because:
- Callers don't have to think about delta construction; the writer
  just hands the store a complete snapshot as today.
- The store is the single place that knows the on-disk format, so
  diffing there is consistent with the existing
  write-then-rename atomic-swap protocol.
- If option A becomes the bottleneck (it probably won't — snapshot
  bytes are ~200 KB), option B is a backward-compatible upgrade.

Defer the decision to implementation but record the recommendation.

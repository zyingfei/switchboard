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

Reading the materializer + types + tests, the original design
optimized for two correctness properties:

1. **Byte-determinism** — snapshot is a pure function of the event
   log. Replay produces identical bytes.
2. **Correctness-under-replay** — rebuild from scratch always gives
   the right answer; no incremental bugs to chase.

Both properties are valuable. Both can be preserved while moving to
incremental.

## Proposed architecture — two-tier materializer

### Tier 1 — Cold-path replay (preserves byte-determinism)

On companion start, replay the entire event log through a single
fold into in-memory accumulators. This is the *warm-up* step; runs
once per companion boot.

```
boot:
  for each event in eventLog.readMerged():
    fold(event, accumulators)
  setReady()
```

Identical inputs always produce identical accumulator state.
Byte-determinism preserved.

### Tier 2 — Hot-path delta updates

On `runner.onAcceptedEvent(event)`, fold ONE event into the
accumulators in O(1). HTTP routes serve from accumulators directly;
no event-log scan.

```
onAcceptedEvent(event):
  fold(event, accumulators)
  if event.type in INVALIDATING_TYPES:  // user.organized.item, thread.upserted, etc.
    schedulePostMutationRebuild(affected_slice)
  publish updated slice via store.putCurrent(affected_slice)
```

`affected_slice` is the minimal subset of the snapshot that depends
on this event:
- `engagement.interval.observed` → `accumulators.engagementByVisit[visitId]`
- `browser.timeline.observed` → `urlProjection.byCanonicalUrl[canonicalUrl]` + `tabSessionProjection.bySessionId[tabSessionId]`
- `user.organized.item itemKind='canonical-url'` → that URL's attribution row + any visit-instance edges pointing to it
- `thread.upserted` → thread's URL-mapped attribution propagation

### Snapshot writeback strategy

Two options, ranked:

1. **In-memory snapshot, lazy-persist** (preferred). Accumulators ARE
   the snapshot. `store.putCurrent` writes to disk periodically (every
   N seconds OR after N updates OR on graceful shutdown) for restart
   durability. Companion crash loses ≤ N seconds of derived state,
   but the event log replay re-derives it on next boot.
2. **Write-through snapshot**. Every fold updates disk. Higher
   correctness, more I/O. Maps to the existing `putCurrent` shape but
   loses the per-event 60s rebuild.

Recommendation: option 1. Crash recovery via cold-path replay is
already exercised on every boot today, so the failure mode is
familiar.

### Similarity & topics — the hardest two

Visit similarity needs the new visit's embedding compared against the
top-K nearest visits. Two paths:

- **Insert-only path**: maintain an in-memory ANN index (e.g.,
  hnswlib-node, or a simple K-nearest map sorted by recency). New
  visit → embed → query top-K → add K new edges. O(K) per visit, not
  O(N×N).
- **Lexical fallback path**: same shape; maintain an in-memory
  inverted index over tokenized titles/URLs; query by Jaccard. O(K)
  per visit.

Topic clustering: union-find supports incremental merge naturally.
On new visit V with similarity edges to existing visits {A, B, C}, V
joins the cluster containing A∪B∪C (or creates a new cluster if all
three are unclassified). The full re-cluster pass becomes a periodic
rebuild (e.g., once per hour OR on graceful shutdown) for byte-
determinism reconciliation, not per-event.

## Migration plan (incremental, non-breaking)

Six sub-tracks, deliverable in order:

### M1 — Streaming engagement classifier

Lowest risk, highest CPU win. The classifier already keys by
`visitId`. Replace `buildEngagementClassifierInputs(merged)` with an
accumulator stored in `_BAC/connections/engagement-accum/<visitId>.json`
(or in-memory) that folds new `engagement.interval.observed` events
in place. Past visits' classifications never recompute.

**Acceptance:** materializer's `engagementClassRevision` produces the
same bytes as the rebuild path on identical input. Snapshot-diff test
proves byte-equality.

### M2 — Per-event URL/tab-session projection patch

Replace `projectUrls(merged)` with a stateful `UrlProjection` mutator
that updates exactly the affected `byCanonicalUrl[url]` row on each
event. Same for `projectTabSessions`. Cache invalidation becomes
unnecessary because the projection IS the cache.

**Acceptance:** projection-equality test — patched projection must
equal `projectUrls(merged)` for every test fixture in
`urls/projection.test.ts`.

### M3 — Visit-similarity incremental insert

In-memory similarity index (hnswlib or simple sorted top-K). New
visits insert in O(K log N). Rebuild path retained as a cold-start
warmup + periodic reconciliation.

**Acceptance:** edge-set equality between incremental + rebuild paths
across the existing similarity test corpus.

### M4 — Topic clusterer incremental merge

Union-find supports incremental merge directly. Add new visit V to
component C(A) where A is V's nearest similarity neighbour above
threshold; merge components if V has neighbours in multiple
components.

**Acceptance:** cluster-membership equality between incremental +
periodic-rebuild paths.

### M5 — Snapshot delta writes

`store.putCurrent` becomes `store.putCurrent(snapshot, {dirty: Set<NodeId>})`
or `store.applyDelta({addedNodes, addedEdges, updatedAttributions})`.
HTTP routes still see the full snapshot, but disk writes are O(delta)
not O(snapshot).

**Acceptance:** snapshot bytes after N delta writes equal snapshot
bytes after one full rebuild over the same events.

### M6 — Invalidation surface for mutating events

The full list of mutating event types (see the audit above; ~15
types across user/workstream/thread/inferred/privacy/queue/dispatch/
recall) each trigger re-projection of their declared affected slices.
Implement a single declarative table that owns the mapping:

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
   slice AND `workstreamTree`. Renaming X invalidates X's label
   AND every URL/tabSession whose `currentAttribution.workstreamId`
   resolves a display path through X (which is "any descendant of
   X plus X itself"). The materializer reads the affected
   `workstreamTree` key as "rebuild any path-derived display labels
   that traverse the changed node." Practical implementation: hold
   a `workstreamId → resolved-path` memo, invalidate the memo
   entries whose path includes the changed bac_id.
2. **`workstream.deleted` may orphan attributions.** The reducer
   should NOT mutate the attribution row's `workstreamId` field —
   that violates byte-determinism if the deletion is later undone
   on a peer. Instead, mark the workstream node as `tombstoned: true`
   in the snapshot, and let the side panel render orphaned
   attributions as such. Re-attribution becomes a user action
   (`user.organized.item`) rather than an automatic recovery.

**Acceptance:** invalidation-trace test — for each mutating event
type listed in the audit, the exact set of recomputed slices
matches the documented rule. Property-test fixture: generate a
random event sequence, run incremental + rebuild paths, assert
identical slice content after each invalidation.

## Risks & open questions

1. **Byte-determinism across versions** — incremental folds may
   produce different snapshot bytes than rebuilds if the fold order
   isn't strictly the same as the event log order. Mitigation: the
   cold-path replay IS the rebuild; hot-path tier preserves order via
   the contract runner's serial `onAcceptedEvent` invocation.
2. **Periodic reconciliation cost** — if M3/M4 fall back to periodic
   rebuilds for byte-determinism reconciliation, those rebuilds still
   cost 60–80 s. Schedule on a coarse cadence (hourly) and outside
   the HTTP hot path. Could move to a worker_thread.
3. **Memory cost** — accumulators in memory mean the companion's
   working set grows with the event log. With ~5K events the
   projection is ~200 KB; not concerning. Could add a tier-3
   eviction for cold visits (older than 30 days) if memory becomes a
   problem.
4. **Test fixture rewrite** — current tests do
   `writeEvents() → expect(snapshot)`. Need a parallel pattern
   `writeEvents() + apply deltas → expect(snapshot)` for incremental
   coverage.
5. **Snapshot consumers may assume freshness on read** — the cached
   reads from Stage 5.0 already serve up to 500 ms stale data;
   incremental moves staleness to "next periodic flush." Acceptable
   for side-panel UI; verify resolver semantics aren't sensitive to
   single-event lag.

## Verification approach

For each Mn track:

1. **Byte-equality property test** — generate random event sequences
   with `fast-check`, run both rebuild and incremental paths, assert
   identical snapshot bytes.
2. **Performance test** — CPU profile a 5,000-event vault going
   through 100 new events at 30 s intervals. Pre-refactor: 60–80 s
   per rebuild ≈ continuous saturation. Post-refactor target: < 100
   ms per event in the hot path; periodic reconciliation < 30 s
   amortized across an hour.
3. **CDP regression** — recorder running with engagement load,
   `inspect-companion-status.mjs` polls `/v1/status` every 15 s for
   30 minutes; pass criterion: zero timeouts, P99 < 200 ms.

## Sequencing relative to Stage 5.1 (T7a–T7d content-aware similarity)

Independent. Stage 5.1 adds new edge kinds + new evidence sources;
Stage 5.2 changes how existing computation is scheduled. Either can
land first.

If both land: Stage 5.2 M3 (incremental similarity) should account
for T7c (content-similarity revisions) so the incremental insert
path covers both edge families. Pre-coordination: M3's index
abstraction should be parameterised by similarity producer
(embedding, lexical, content).

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

The biggest design call: **option 1 (lazy-persist accumulators) vs
option 2 (write-through snapshot) for M5 writeback**. Option 1 is
simpler + faster but loses ≤ N seconds of derived state on companion
crash. Option 2 is slower but crash-safe.

My recommendation is option 1, because:
- Event log is the source of truth — already replay-tested.
- Snapshot is derived; "lost on crash" means "rederived on next
  boot," not "lost data."
- Avoids per-event disk writes which are the precise thing we're
  trying to amortize.

Defer the decision to implementation but record the recommendation.

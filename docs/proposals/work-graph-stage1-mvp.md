# Sidetrack — Stage 1 MVP (Consolidated, LLM-Free, Hardware-Neutral)

> **Design principle (re-stated).** Facts are event-sourced. Interpretations are
> versioned. Suggestions are explainable. User organization is authoritative.
> **No inference requires GPU / Apple-Silicon hardware.**

This is the consolidated Stage 1 plan, integrating the local-iteration plan with the
external researcher's converged version. It supersedes both. The structural skeleton
(Northern Star → Out of Scope) follows the researcher's revision; the work-split
section at the end is added so the team can spin major tasks (architecture, planning,
integration) for the lead while parallelizing well-scoped code work to Codex.

## Northern Star

Sidetrack is a **temporal behavioral work graph** for the modern browser worker. The
system observes — with explicit user consent — what the user reads, what they navigate
from and to, what they engage with vs. abandon, and what they copy/paste between
contexts. From those facts it builds an event-sourced graph that the user can replay,
query, label, and re-organize. The graph is shipped through the Sync Contract v1
between the plugin edge (Class F raw events), an optional companion (Class B/D/E
derivations), and an optional relay.

Two non-negotiable properties define the product:

1. **Authoritative user organization.** The user's manual labels, threads, dispatches,
   snippets, and notes always outrank inferred structure. Inferred structure is
   rendered as `confidence: 'inferred'` (Lock 1) and shown with a dashed CSS stroke so
   it is visibly weaker than user-authored facts.
2. **Hardware-neutral inference.** Sidetrack runs in any Manifest V3 browser on any
   consumer machine without assuming a discrete GPU, Apple Silicon, or an AMD APU
   with usable shared memory. **Stage 1 ships zero LLM inference code.** The codebase
   already has a working WASM-backed `multilingual-e5-small` embedder
   (`Xenova/multilingual-e5-small` via `@huggingface/transformers`, 384 dims,
   `query:` / `passage:` prefix discipline, deterministic test embedder) — that is
   the only neural component on the critical path, and it runs on CPU.

Stage 1 is the smallest set of capabilities that turns the existing engine plus the
existing recall stack into a usable behavioral graph. It adds new *facts* (Class F
raw observations), one new *evidence* edge (`visit_observed_on_replica`), one new
*similarity* edge that reuses the existing embedder, deterministic clustering, and
deterministic explanation surfaces. Everything else — learned ranker, supervised
feedback, optional cloud-LLM prose enhancement — is roadmap.

## Architectural Locks (preserved invariants)

These four locks are invariants of the broader Sidetrack design and accepted upstream
of this plan.

**Lock 1 — Confidence enum gains `inferred`.** Every node and edge carries
`confidence ∈ {'asserted', 'observed', 'inferred'}`. `'asserted'` = user said so;
`'observed'` = directly captured event; `'inferred'` = derived by a producer.
Inferred edges render with a dashed CSS stroke (`stroke-dasharray: 4 2`). Enforced in
the renderer, not by content, so it cannot be bypassed.

**Compatibility with old snapshots.** Pre-Stage-1 snapshots in
`_BAC/connections/current.json` carry the legacy enum `'explicit' | 'deterministic'`.
These are NOT mutated on disk. A reader-side normalizer is the migration:

```ts
const normalizeConfidence = (raw: string): 'asserted' | 'observed' | 'inferred' => {
  switch (raw) {
    case 'asserted':
    case 'observed':
    case 'inferred':
      return raw;
    case 'explicit':
      return 'asserted';   // user-asserted facts mapped to the new "user said so"
    case 'deterministic':
      return 'observed';   // event-derived non-inferential mapped to "directly captured"
    default:
      return 'observed';   // safe default for forward-compat with future producers
  }
};
```

Applied at three boundaries:

1. **Side-panel reader** (`ConnectionsView.tsx`) — every `edge.confidence` read passes
   through `normalizeConfidence` before CSS class selection.
2. **MCP `connections.snapshot.read` response** — the JSON-schema for `confidence` is
   a union of old + new values with the old marked as `deprecated`. The server emits
   the new enum directly when it built the snapshot itself; it normalizes on read
   when the snapshot pre-dates Stage 1.
3. **Reducer rebuild** — when the connections materializer re-runs over the merged
   event log, it writes the new enum directly. The next snapshot supersedes the old.
   No event-log mutation; just a derived-cache rebuild.

Test fixture: a `_BAC/connections/legacy.json` checked in under
`packages/sidetrack-companion/src/connections/__fixtures__/`. The snapshot test loads
it through the reader, asserts the side panel renders correctly without crashing on
the old enum, and asserts the MCP response validates against the new schema.

**Lock 2 — `payloadVersion` + `dimensions` extension slot.** Every Class F event and
every replayable Class B/D/E artifact has `payloadVersion: number` (monotone) and
`dimensions: Record<string, unknown>` (open extension). New behavior fields are
*added through `dimensions`*, never via positional schema mutation.

**Dimensions safety (cannot become a raw-content / PII side channel).** The open
extension slot is bounded at three layers:

1. **Hard size cap.** `JSON.stringify(dimensions)` MUST be ≤ 4 KB at the producer.
   The runtime predicate
   (`isBrowserTimelineObservedPayload`, `isSelectionCopiedPayload`, etc.) rejects any
   payload that exceeds the cap; the event spool drops the over-cap event, increments
   a `storage.dimensions.oversize` counter, and records the offending event-type +
   producer in the storage health surface.
2. **Allowed-dimension manifest per event family.** Each `ContractEntry` declares an
   `allowedDimensions: readonly string[]` whitelist. Unknown keys are stripped at
   ingest (HTTP route + `importPeerEvent` + relay subscriber path all share one
   `sanitizeDimensions(payload, entry.allowedDimensions)` helper). Stripped keys are
   not relayed; replicas converge on the whitelisted shape.
3. **Redaction at ingest.** Before `sanitizeDimensions` runs, every string value in
   `dimensions` is checked against three regex patterns:
   - email: `/[^\s@]+@[^\s@]+\.[^\s@]+/`
   - long token: `/[A-Za-z0-9_\-]{40,}/` (catches API keys, JWTs, OAuth tokens)
   - card-like: `/\b(?:\d[ -]?){13,16}\b`
   When matched, the value is replaced with `'[redacted]'` and a sibling list
   `dimensions._redacted: ['<key>', ...]` records which keys were touched. The
   redaction list itself is whitelisted in every `allowedDimensions`.

**Per-family preserve / drop policy:**

| Event family | Preserves dimensions? | Notes |
|---|---|---|
| `browser.timeline.observed` | YES | `engagement`, `provenance` keys whitelisted |
| `engagement.interval.observed` | YES | dimension is the entire payload contract |
| `engagement.session.aggregated` | YES | aggregate dimensions from raw stream |
| `selection.copied` | YES | hash-only schema; rawText forbidden via redaction |
| `selection.pasted` | YES | hash-only schema |
| `navigation.committed` | YES | `transitionType`, `transitionQualifiers`, `provenance` |
| `privacy.gate.flipped` | NO (drop on ingest) | gate state must not carry side data |
| `privacy.permission.granted` | NO | permission scope only, no extension |
| `privacy.permission.revoked` | NO | same |
| `workstream.upserted` | NO | canonical user fact; fixed schema |
| `thread.upserted` | NO | canonical; fixed schema |
| `dispatch.recorded` | NO (already extended by Phase 4 fixed fields) | |
| `annotation.created` | NO | canonical user fact |
| `queue.created` / `.status_set` | NO | fixed schema |
| `capture.recorded` | NO | recall pipeline owns its own per-turn schema |

The "NO" rows have `allowedDimensions: []` in their registry entry; the sanitizer
returns `dimensions: undefined` for those events, so they ferry through the relay
without any `dimensions` field at all.

**Replay safety.** When a reducer reads an event with a `dimensions.<key>` that the
current code doesn't recognize (e.g., a future Stage-2 producer's events on a
Stage-1 reducer), it treats it as `undefined` — never throws, never short-circuits
the event. The `allowedDimensions` whitelist is the registry-level policy; reducers
are forgiving readers.

**Lock 3 — `producedBy` provenance on every Class B edge eligible to be derived.**
Every derived edge records
`{ producer: string, producerVersion: string, inputs: Array<{kind, id, hash}>, producedAt: number }`.
This makes Class E revisions deterministic to reissue.

**Lock 4 — Privacy gates as Class A facts.** Privacy state changes are facts on the
timeline, not flags in a settings store. The events are `privacy.gate.flipped`,
`privacy.permission.granted`, `privacy.permission.revoked`. Replicas materialize from
the event stream so revoking on Replica α propagates to β through Sync Contract
Class A delivery, including retroactive masking of any derived artifact whose
`inputs[]` reference a now-forbidden source.

**Conflict resolution under offline divergence.** Two replicas may flip the same
gate while offline. When their event logs merge:

- Last-write-wins by `(observedAt, replicaId)` — higher `observedAt` wins; ties
  resolved by lexicographically lower `replicaId`. Both replicas, replaying the
  same merged log, converge on the same final state.
- The projection function over the gate-event stream is a pure reducer. No
  coordination service is required.
- For monitoring, the projection emits a `privacy.gate.conflicts: number` health
  metric counting LWW-resolved-against events; a UI affordance can warn the user
  when their explicit revoke was overridden by a later open from another replica.

**What gates block:**

- **Edge observation (extension side).** The content script and event listeners
  consult the gate's projected state at observation time. `closed` ⇒ no new
  events emitted to the spool. This is the cheapest and most consistent block.
  Gate-projection state lives in `chrome.storage.local` as a fast-path cache
  hydrated from the projection on SW boot + `runtime.onMessage` notifications
  when the projection updates.
- **Companion materialization (companion side).** Materializers respect the gate
  timeline at projection time. Observations whose `observedAt` falls in a window
  when the gate was `closed` are EXCLUDED from derived caches. This catches both
  events that slipped through (e.g., observation block fired late) and events
  that arrived from a peer replica (the peer's local block was off when ours was
  on, but our projection still masks).
- **Both, with different scopes.** Observation block prevents NEW data within the
  current replica. Materialization block hides EXISTING data within a window
  across all replicas.

**Retroactive masking is derived-view masking, not destructive event deletion.**

- Old events stay in the event log (Class C audit + Class F observed). They are
  immutable.
- The reducer projection respects the gate timeline and excludes events whose
  `observedAt` falls in a `closed` window from derived caches.
- If the user later flips back to `open`, those events become visible again in the
  derived caches. That's the correct semantics for "mask, not delete."
- HARD deletion would be a separate `privacy.event.tombstoned` event type (out of
  scope for Stage 1; flagged for a future privacy follow-up).

**Cross-replica privacy revoke e2e (1.K-A).** The e2e suite asserts the round-trip:

1. Browser A flips `privacy.gate.flipped({ gate: 'engagement', state: 'closed' })`.
2. Relay carries the event to Browser B within the Class B freshness budget (30 s).
3. Browser B's projection masks engagement-class artifacts in any window post-flip.
4. Browser B's side panel re-renders with the new mask applied.
5. Browser A flips back to `open`; Browser B sees masked engagement artifacts
   become visible again.
6. The e2e asserts: same merged event log on both replicas → same projection →
   same UI state.

## Stage 1 — Sub-sections

The C1–C6 increments from the codebase adoption map are the spine of Stage 1.

```
C1: schema/event evolution                                  -> 1.A, 1.B, 1.F
C2: deterministic causality via webNavigation               -> 1.B
C3: engagement intervals                                    -> 1.A, 1.G
C4: copy/paste lineage with hashes                          -> 1.H
C5: relationship ranker v1 (existing stack only)            -> 1.C, 1.E, 1.J (Why Related)
C6: explicit IndexedDB decision for production extension    -> 1.F (transport), all of 1.A/1.H (event sink)
```

### 1.A Engagement dimensions (content script, deterministic, gated)

The content script captures **counts and durations only**. Nothing about page contents
leaves the page unless an explicit Class A privacy gate is open. Engagement events are
emitted as Class F. Raw observations and aggregates are kept separate so a future
producer can re-derive aggregates without losing the raw stream.

| Field | Source primitive | Notes |
|---|---|---|
| `activeMs` | `visibilitychange` + idle detector | wall time tab is visible AND user is not idle (idle threshold default 30 s) |
| `visibleMs` | Page Visibility API | wall time `document.visibilityState === 'visible'`; superset of `activeMs` |
| `focusedWindowMs` | `chrome.windows.onFocusChanged` | window contains tab AND window is OS-foreground |
| `idleMs` | `chrome.idle` (extension) + content-script inactivity | complement of `activeMs` within `visibleMs` |
| `foregroundBursts` | counted hidden→visible transitions | unbounded counter |
| `returnCount` | counted re-entries to same canonical URL within session | session = browser session |
| `scrollEvents` | throttled `scroll` listener (max 1 Hz aggregate) | counts only, no positions |
| `maxScrollRatio` | `(scrollY + clientH) / scrollH` snapped at sample points | float `[0, 1]`; never re-decreases |
| `copyCount` | `copy` event | event-level counter; snippet semantics live in 1.H |
| `pasteCount` | `paste` event | dual to `copyCount` |

Events emit as `engagement.interval.observed` (`payloadVersion: 1`,
`dimensions: { ...above }`). The content script registers dynamically; if the user's
Class A `privacy.gate.flipped` event for "engagement" is `closed`, the content script
is not injected — gate honored before observation, not after. Aggregates over sessions
emit as `engagement.session.aggregated` and are a *replayable Class B reduction* of
the raw `engagement.interval.observed` stream, never a destructive overwrite.

### 1.B Provenance dimensions (deterministic causality)

The plugin gains the `webNavigation` permission. On every committed top-frame
navigation we emit a Class F `navigation.committed`:

```ts
{
  payloadVersion: 1,
  visitId: string,                    // canonical URL + commitTimestamp + replicaId
  url: string,                        // pre-canonicalization
  canonicalUrl: string,               // post-normalization (utm/fbclid/gclid/srsltid stripped, scheme+host lowercased, default ports removed, fragment dropped)
  documentId: string,                 // chrome.webNavigation provides UUID
  parentDocumentId: string | null,
  tabId: number,                      // raw, transient
  tabSessionIdHash: string,           // FNV-1a 32-bit of (tabId, browserSessionStart)
  windowSessionIdHash: string,        // FNV-1a 32-bit of (windowId, browserSessionStart)
  openerVisitId: string | null,       // resolved from openerTabId IF opener still exists, else null
  previousVisitId: string | null,     // last visit on the same tabSessionIdHash
  navigationSequence: number,         // monotone within tabSessionIdHash
  transitionType: TransitionType,     // 'link' | 'typed' | 'auto_bookmark' | 'auto_subframe' | 'manual_subframe' | 'generated' | 'start_page' | 'form_submit' | 'reload' | 'keyword' | 'keyword_generated'
  transitionQualifiers: TransitionQualifier[], // any subset of {'client_redirect','server_redirect','forward_back','from_address_bar'}
  commitTimestamp: number,
  dimensions: { /* extension slot */ }
}
```

Two correctness notes (both grounded in Chrome documentation):

1. **`openerTabId` only when opener still exists.** When `chrome.tabs.onCreated` fires
   without `openerTabId`, `openerVisitId = null` and we fall back to `previousVisitId`
   along the same `tabSessionIdHash`. We never invent an opener.
2. **`webNavigation` timestamps are internally consistent only.** They are not
   commensurate with `Date.now()` from inside content scripts. All "duration" math
   stays *within* a single source — engagement durations from content-script clocks,
   navigation deltas from webNavigation timestamps — and never crosses streams.

`tabId` and `windowId` are not stored. They're hashed with FNV-1a (32-bit) to produce
stable, non-identifying session group keys. FNV-1a is non-cryptographic; the hash here
is a stable group key, not a privacy boundary.

### 1.C `visit_resembles_visit` edge — reuses the existing embedder

This is the new similarity edge. It reuses `multilingual-e5-small` *without*
introducing a second embedding stack, vector index, or new ANN library.

**Producer.** For every `navigation.committed` whose canonical URL has stable
extracted text (title + selected headings + first-viewport text, all already produced
by the recall pipeline), the companion (or the plugin in plugin-only mode) computes
the `passage:`-prefixed embedding and inserts through the existing recall index V3
path: `_BAC/recall/index.bin`, with `modelId = 'Xenova/multilingual-e5-small'`, the
pinned HF revision, the chunk schema version, the schema capabilities, per-entry
metadata, the replica id, the Lamport timestamp, the source-scoped replacement
semantics, and the canonical ordering already in production. **No new vector store.**

**Edge predicate.** For each new visit `v`, retrieve top-K (default 50) candidates via
the existing hybrid retrieval (MiniSearch + cosine + RRF, with title/heading/text
field weights and dotted-identifier tokenization, all already shipped). Among those
candidates, emit `visit_resembles_visit(v → u)` with `confidence: 'inferred'` for
every `u` whose cosine on the `query:`-prefixed embedding of `v` exceeds the relative
threshold `T_sim` (default `0.85`).

Threshold note: per the model card and MMTEB, multilingual-E5 cosine scores cluster in
`[0.7, 1.0]`, so `0.85` is a *position within a known distribution*, not a probability.
Exposed as a setting in the developer build and persisted so changes are auditable.

**Persistence.** The edge ships as a Class E revision (`visit-resembles-visit-revision`,
key `visit-resembles:v1:cosine`) so re-embedding under a different model revision or
threshold replaces the prior revision deterministically without orphaning.

### 1.D Persistent topic nodes via deterministic Union-Find with content-derived ids

Topics are **not** k-means and **not** HDBSCAN. A topic is the connected component of
the `visit_resembles_visit` graph at threshold `T_sim`, intersected with manual user
organization (a user who threads two visits forces them into the same topic regardless
of cosine).

```
For each visit v:
  uf.add(v)
  for each edge visit_resembles_visit(v → u) with cosine ≥ T_sim:
    uf.union(v, u)
  for each user-asserted edge in_thread(v, u):
    uf.union(v, u)            // user > inferred

For each component C:
  members = sorted(uf.members(C), by canonical URL ascending)
  topic_id = "topic:" + sha256(members.join("\n")).slice(0, 16)
```

A topic is a `ConnectionNode` of kind `'topic'` (the 8th `ConnectionNodeKind`). Its
`topic_id` is content-derived and therefore *deterministic given its membership* —
two replicas observing the same component independently mint the same id.

When a component splits or merges, the affected components' ids change; this is
acknowledged as the price of determinism without a coordination service. Stage 1
mitigates by emitting a Class B `topic.lineage` edge whenever a component splits or
merges, so the user's prior `topic_id` remains addressable as a tombstone with
`succeededBy` pointers.

For Stage 1 corpus sizes (single user, weeks-to-months, target ≤ 10⁵ visits),
Union-Find with path compression is O(α(n)) per union — flat in practice. HDBSCAN /
Leiden / centroid-stable variants are deferred until the dataset crosses an empirical
scale where Union-Find's coarseness becomes the actual user complaint.

### 1.E Cross-device continuation as evidence edge

When the same canonical URL is observed on multiple replicas within the user's
account, we emit `visit_observed_on_replica(visit, replicaId)` as a **Class B
evidence** edge with `confidence: 'observed'`. This is **not** an inference. It
carries no claim that the user "continued the same task across devices." It is the
raw fact that the URL was observed elsewhere; any classifier converting these into
"continuation" inferences belongs to a later stage and must produce a Class E
artifact with its own producer/version/threshold.

### 1.F Privacy event types replacing chrome.storage flags + the IndexedDB decision

Privacy state expressed as Class A events on the timeline:

- `privacy.gate.flipped`: `{ gate: string, state: 'open' | 'closed', actor: 'user' | 'system', reason?: string }`
- `privacy.permission.granted`: `{ permission: string, scope: object }`
- `privacy.permission.revoked`: `{ permission: string, scope: object, retroactiveMask: boolean }`

These events drive the materializers. There is no `chrome.storage.local.privacy`
settings blob in Stage 1 — the previous representation is migrated to a deterministic
replay over the privacy event stream.

**The IndexedDB decision (C6).** Keep `chrome.storage.local` as the persistence
substrate for the small, hot, mostly-read working set: URL/title timeline summary,
last seen replica id, current Lamport, the small spool of pending sync messages,
user UI preferences. **Introduce IndexedDB-backed Class F event buffer** for
high-volume append-only streams: `engagement.interval.observed`, `selection.copied`,
`selection.pasted`, `navigation.committed`, and the engagement *aggregate* artifacts.

**Why.** `chrome.storage.local` defaults to ~10 MB (5 MB pre-Chrome 114), is
JSON-stringified per write, and writes the *entire value* of any changed key.
Behavioral event streams that include per-interval engagement records on dozens of
tabs can exceed comfortable quota in a session-week. IndexedDB is available to MV3
service workers, has no fixed cap (origin quota — typically a percentage of free
disk on Chromium, with `navigator.storage.estimate()` exposing the live number),
supports range queries on indexed keys, and has documented batched-cursor and
`getAll()` patterns that outperform per-item access. Request `unlimitedStorage` so
both substrates are exempt from eviction.

**How (write path).** The service worker batches Class F events into ≤ 100-item
transactions every ≤ 1 s. Each transaction writes to a single object store keyed by
`(streamName, lamport, replicaId)` so canonical ordering is preserved. The
deterministic test embedder pattern from the recall pipeline is mirrored here: in
test runs, the IndexedDB layer swaps for an in-memory adapter behind the same
interface so the e2e suite (1.K) doesn't require a real IndexedDB.

**How (read path).** UI surfaces (Flow Path, Focus View) read through a thin reducer
that subscribes to a `getAllRecords`/cursor pagination over the indexed key range
and re-hydrates aggregates on demand. Never load the full stream into the popup or
side panel.

**MV3 lifecycle implications.** All listeners (`webNavigation.onCommitted`,
`tabs.onCreated`, `idle.onStateChanged`, `runtime.onMessage`) register synchronously
at the top of the service worker. No state lives in module globals between worker
restarts; everything that must survive is in IndexedDB or `chrome.storage.local`.
`chrome.alarms` (minimum 1-minute period) drives periodic flush of in-memory event
batches that haven't yet hit the size threshold.

**Backpressure & quota failure.**

- `navigator.storage.estimate()` is polled every flush cycle. At ≥ 80 % of quota
  the buffer emits `storage.quota.warning` (Class A health event); at ≥ 95 % it
  switches into "drop-oldest" mode for the affected stream and emits
  `storage.quota.exceeded`.
- `IndexedDB.put` `QuotaExceededError` is caught: the failed transaction is
  retried after evicting the oldest 10 % of records in the offending stream.
  Persistent failure (3 retries) escalates to `storage.quota.fatal`, which
  surfaces in side panel as a non-dismissable banner: "Sidetrack storage is full
  — clear storage in Settings, or events will be dropped."
- Drop-oldest is per-stream, never global, so a high-volume `engagement.interval.observed`
  burst cannot starve `selection.copied` retention.

**Per-stream retention.**

| Stream | Rolling window | Reason |
|---|---|---|
| `navigation.committed` | 90 days | Causal spine; Stage-2 ranker needs history |
| `engagement.interval.observed` | 30 days | High-volume; aggregates persist longer |
| `engagement.session.aggregated` | indefinite | Already aggregated; ~KB/session |
| `selection.copied` / `selection.pasted` | 90 days | Low volume; load-bearing for lineage |
| `privacy.gate.flipped` / `permission.*` | indefinite | Privacy timeline must be replayable |
| `storage.*` (health / quota events) | 30 days | Operational noise |

A daily `chrome.alarms` job evicts records older than the per-stream window. Eviction
is cursor-based (`getAllRecords` with key range below the cutoff lamport) and is
batched ≤ 1 000 records / transaction.

**Health surface.**

- `storage.health` is a Class B projection over `storage.*` events + a live snapshot:
  per-stream record count, oldest record age, latest flush lag, last error code,
  current quota %.
- Side panel exposes a "Storage" diagnostic section (under Settings → Diagnostics)
  rendering the projection.
- MCP tool `sidetrack.system.storageHealth()` returns the same projection for
  programmatic access.

**Week-offline behavior (companion unreachable for 7 days).**

- The buffer fills toward retention caps with the user's normal browsing volume.
  At default budgets, 7 days of typical browsing fits comfortably under the 30-day
  engagement-interval cap and 90-day causal-spine cap.
- Cross-replica sync via the relay continues to work for events that haven't been
  GCed — the relay does not depend on companion reachability.
- On reconnect, the flush-scheduler drains accumulated events in batches of ≤ 100.
  At 10 events/s typical, a week's backlog drains in minutes.
- If the buffer hits drop-oldest during the offline window, dropped events are
  permanently lost from this replica (peer replicas may still have them via the
  relay; cross-replica re-import on reconnect is the recovery path).

**IndexedDB schema versioning + migration.**

- Object-store keys carry a version prefix: `<streamName>:v<n>:<lamport>:<replicaId>`.
- An additional `_schema` object store records `{ streamName: string, version: number,
  schemaHash: string, migratedAt: number }` per stream.
- On every SW boot, a migration step compares each stream's stored version against
  the `CURRENT_STORE_VERSION` constant for that stream. If older, a registered
  migration function runs (forward-only; each migration is `(oldRecord) => newRecord`
  applied via cursor).
- Migration tests boot a synthetic IDB at `v1`, run the `v1 → v2` migration, and
  assert: every old record is readable in the new shape, no data loss, schema-store
  reflects the new version.
- Migration is idempotent: re-running over an already-migrated store is a no-op.

### 1.G Engagement classification — deterministic ruleset, no learned model

Per-visit engagement class is a Class E revision keyed `engagement-class:v1:rules`.

| Class | Rule (all conditions ANDed unless noted) |
|---|---|
| `parked_background` | `focusedWindowMs < 2000` AND `activeMs < 1000` |
| `glanced` | `activeMs < 5000` AND `maxScrollRatio < 0.15` AND `copyCount = 0` |
| `skimmed` | `5000 ≤ activeMs < 30000` AND `maxScrollRatio ≥ 0.15` AND `copyCount = 0` AND `scrollEvents ≥ 3` |
| `engaged_read` | `activeMs ≥ 30000` AND `maxScrollRatio ≥ 0.4` AND `returnCount ≥ 1` |
| `worked_on_reference` | `activeMs ≥ 30000` AND `copyCount ≥ 1` AND `returnCount ≥ 2` |
| `source_extracted` | `copyCount ≥ 1` AND any `selection.copied` from this visit appears as `selection.pasted` into a thread/dispatch/note/capture |
| `execution_source` | `source_extracted` AND `copyCount ≥ 2` AND distinct destinationKinds ≥ 2 |

The producer is a pure reducer over `engagement.session.aggregated` plus the C4
lineage. Writes a Class E artifact `engagement.class.assigned` with full `producedBy`
(Lock 3). Any future learned classifier (deferred to Stage 2/3) ships as a *different*
producer key (e.g. `engagement-class:v2:learned`); the two co-exist via the revision
pattern; the user can pin which producer's classes the UI surfaces use.

### 1.H Copy/paste lineage — hashes only by default

A new `'snippet'` `ConnectionNodeKind` (the 9th) joins the model. New events:

- `selection.copied`: `{ visitId, selectionHash: SHA-256, simhash64: bigint, charCount, sampledCharRanges: [start,end][], rawTextStored: false }`
- `selection.pasted`: `{ destinationKind: 'thread' | 'dispatch' | 'search' | 'note' | 'capture', destinationId, simhash64, charCount, rawTextStored: false }`

**Default privacy posture.** `rawTextStored: false`. Only hashes leave the page
(`selectionHash` for exact match, `simhash64` for fuzzy match). Raw text is captured
only if the user has flipped the explicit Class A gate
`privacy.gate.flipped({ gate: 'snippet.rawText', state: 'open' })` *or* explicitly
invokes "promote to source/note", at which point the snippet becomes a user-authored
fact (`confidence: 'asserted'`) with full text under the user's control. Sidetrack
does not poll the system clipboard.

**Lineage matching.** A `selection.copied` and a later `selection.pasted` are linked
when:

- `selectionHash` matches exactly, OR
- `simhash64` Hamming distance ≤ 3 within a 24-hour window.

Hamming ≤ 3 over 64-bit SimHash is the canonical near-duplicate band per Manku et
al. (2007 web crawl evaluation). Sidetrack normalizes selections before hashing:
collapse whitespace, drop heuristic UI chrome (header/footer markers), drop pure
timestamp lines.

**Edges minted on lineage match:**

- `snippet_copied_from_visit(snippet → visit)` — `confidence: 'observed'`
- `snippet_pasted_into_thread / _dispatch / _search / _note / _capture` —
  `confidence: 'observed'`
- `snippet_reused_across_threads(snippet → [thread_a, thread_b, ...])` —
  `confidence: 'inferred'` when the same `snippet_id` matches into ≥ 2 threads.

### 1.I Deterministic templates for label, Why Related, Context Pack

**Stage 1 ships zero LLM code.** The three surfaces are deterministic reducers.

**Topic label.** The label of a topic is `representativeTitles[0]` — the title of the
topic member with the highest `focusedWindowMs` (ties broken by canonical URL
ascending). The tooltip carries `cohesion = mean cosine over edges within the
component` and `memberCount = |members|`. No model in the loop.

```ts
function topicLabel(t: Topic): { label: string; tooltip: string } {
  const top = t.members
    .slice()
    .sort((a, b) => b.focusedWindowMs - a.focusedWindowMs || a.canonicalUrl.localeCompare(b.canonicalUrl))[0];
  return {
    label: top.title || top.canonicalUrl,
    tooltip: `cohesion=${t.cohesion.toFixed(2)} · members=${t.members.length}`,
  };
}
```

A user who renames a topic produces a `topic.label.asserted` Class A fact that takes
priority; the deterministic label is only a default.

**Why Related — structured reason-code list.** Each reason has a code and a small
structured payload, renderable in any locale and trivially testable:

```ts
type Reason =
  | { code: 'SAME_THREAD'; threadId: string; threadName: string }
  | { code: 'SAME_TOPIC'; topicId: string; cohesion: number }
  | { code: 'COSINE_ABOVE_THRESHOLD'; cosine: number; threshold: number }
  | { code: 'OPENER_CHAIN'; depth: number; viaTabSessionIdHash: string }
  | { code: 'PREVIOUS_VISIT_IN_TAB_SESSION'; tabSessionIdHash: string }
  | { code: 'TRANSITION_TYPE'; transitionType: TransitionType }
  | { code: 'TRANSITION_QUALIFIER'; qualifier: TransitionQualifier }
  | { code: 'COPIED_FROM'; snippetId: string }
  | { code: 'PASTED_INTO'; snippetId: string; destinationKind: string }
  | { code: 'OBSERVED_ON_OTHER_REPLICA'; replicaId: string }
  | { code: 'LEXICAL_OVERLAP'; topTokens: string[] }
  | { code: 'LINK_OUT_FROM' | 'LINK_IN_TO'; otherVisitId: string };
```

Renderer is a pure switch over `code` emitting parallel-structured bullets ("Same
thread: <name>", "Cosine 0.91 ≥ 0.85", "You pasted from this page into your
dispatch", …). List sorted by fixed reason-code priority (user-asserted relations
first, behavioral facts second, similarity third, lexical overlap last). This is the
production-grade form of "explainable recommendation" per Zhang & Chen 2018; Naiseh
et al.; Ge et al. ACM TORS 2024 — content-based, locally grounded, actionable.
Avoids the LLM-prose risk surveyed in Said 2025.

**Context Pack — structured Markdown.** Pure reducer over the topic, sections
rendered as Markdown lists. No inference. No summarization.

```markdown
# {Topic label}

## Core Sources
- [{title}]({url}) — focused {focusedWindowMs/1000 | 0}s · {engagementClass}

## AI Threads
- {threadName} — {threadCount} messages · last active {timestamp}

## Dispatches
- {dispatchTitle} — sent {timestamp} · {recipient}

## Snippets
- "{first 80 chars of snippet, only if rawTextStored=true; else "(hashed)"}"
  copied from [{title}]({url}) · pasted into {destinationKinds.join(", ")}

## Open Questions
- {extractable line ending in "?"}   // only when literally present in user-authored note text
```

"Open Questions" is **not** generated — it is extracted, line by line, from
user-authored notes (`'?'` line ending plus a length and structure filter). Section
omitted when no extractable question exists.

### 1.J UI surfaces — Flow Path, Focus View, Why Related, Context Pack composer

All four surfaces are deterministic. None has an LLM endpoint. None opens an
outbound network connection for inference.

**Flow Path tab.** Directed temporal view over `navigation.committed`, grouped by
`tabSessionIdHash`. Edges drawn from `previousVisitId` (solid) and `openerVisitId`
(solid). Cross-replica continuations from `visit_observed_on_replica` render as
dashed edges (Lock 1). Hovering a node reveals its engagement class. Clicking a
node opens its "Why Related" panel.

**Focus View tab.** Topic-centric view. Topic nodes (kind `'topic'`) are first-class;
visits inside a topic render as a member list ordered by `focusedWindowMs`. Topics
whose members include user-asserted threads/dispatches/snippets are visually
weighted higher. The top member's title is the topic label per 1.I.

**Why Related panel.** Renders the structured reason list for a (visit, visit) or
(visit, topic) pair. Each bullet is a discrete reason-code. Sorted by fixed priority.
Toggle "Show only user-asserted" hides every `confidence: 'inferred'` reason.

**Context Pack composer.** "Compose" produces the Markdown defined in 1.I and copies
to clipboard with explicit visual confirmation. Never opens a network connection.

### 1.K Browser e2e validation spec — no LLM stubbing required

Stage 1 e2e exercises the system end-to-end without any neural stubbing beyond the
deterministic test embedder pattern that the recall pipeline already uses (returns
deterministic 384-dim vectors keyed by content hash so the same input always
produces the same vector).

**Scenarios:**

1. **Causal spine.** Open tab via address bar (`transitionType: 'typed'`), click
   link (`transitionType: 'link'`, `openerVisitId` populated), force-close opener,
   click another link from new tab (`openerVisitId` is `null`, `previousVisitId`
   populated). Assert all three navigations emit expected Class F shape and graph
   reflects resolved openers.
2. **Engagement classification.** Open three pages: one immediately backgrounded
   (`parked_background`), one scrolled briefly (`skimmed`), one read >30 s with two
   returns (`engaged_read`). Assert deterministic class assignments and the Class E
   artifact key.
3. **Topic formation.** Open a cluster of 6 pages on a single subject; copy text
   from one into a thread (snippet lineage); assert the connected component, the
   deterministic `topic_id` formula, and the topic label = top member's title.
4. **Cross-replica observation.** Simulate a second replica observing the same
   canonical URL; assert `visit_observed_on_replica` is emitted; Flow Path renders
   a dashed edge.
5. **Privacy revocation.** Flip
   `privacy.gate.flipped({ gate: 'engagement', state: 'closed' })`; assert no
   further engagement events emitted, prior aggregates masked in UI, and the
   Class A event is in the replicable timeline.
6. **Storage substrate.** Drive 10 000 synthetic engagement intervals through the
   IndexedDB buffer; assert flush latency, batch size, and that
   `chrome.storage.local` usage stays under 5 MB (proves C6).
7. **Determinism of explanations.** Run the Why Related panel against the same
   fixture twice; assert byte-identical reason-code output. (Impossible against an
   LLM endpoint — one of the reasons the surface was redrawn deterministically.)

**Network-mock assertion:** the test installs a `context.route()` rule that fails
on any outbound LLM-shaped request (`*ollama*`, `*openai*`, `*anthropic*`,
`*claude*`, `*completions*`, etc.). Stage 1 must never make such a call.

## Roadmap (deferred, separate PRs)

| Stage | Capability | Trigger to start |
|---|---|---|
| 2 | Learned ranker for `closest_visit` (LightGBM/XGBoost LambdaMART) over existing scoring features plus behavior features | ≥ N weeks of single-user behavior + user-labeled positive/negative pairs |
| 3 | Supervised feedback loop on user accepts/rejects; producer-versioned Class E revisions | Stage 2 in production with telemetry |
| Future | Optional cloud-LLM enhancement (user supplies their own API key) for label, Why Related, and Context Pack *prose* surfaces | Class E revision pattern from Stage 1 makes this purely additive — existing deterministic surfaces remain available as fallback |
| Future | Cross-replica continuation classifier (the *inference* edge atop `visit_observed_on_replica`) | Ground-truth dataset + Stage 2 ranker |
| Future | ANN indexes (USearch / hnswlib / Faiss) | Cosine retrieval over flat float32 stops being interactive on the user's own corpus |
| Future | HDBSCAN / centroid-stable clustering | Topic id churn from Union-Find becomes a measured user complaint |
| Future | Visual fingerprinting / DOM / screenshot pHash | Need for visual revisitation that text embeddings do not solve |

## Prior art

References for the Stage 1 design choices, biased toward production-relevant work.

**Behavioral signals from the browser are well-understood.** Reconstructing detailed
browsing activity from incomplete history records — including time-spent and tab-focus
reconstruction — is an established research area (Kovacs, *Reconstructing Detailed
Browsing Activities from Browser History*, 2021); engagement-time heuristics built on
Page Visibility API with heartbeat events at ~10–15 s intervals are the production
standard (GA4, Chartbeat, Kissmetrics).

**Hybrid retrieval (lexical + dense + RRF) is the current MVP default.** Bruch, Gai
& Ingber, *An Analysis of Fusion Functions for Hybrid Retrieval*, ACM TOIS 2023/2024.
Convex combination of lexical and vector scores is sample-efficient and competitive
with RRF; RRF itself is more parameter-sensitive than its zero-shot reputation
suggests.

**Multilingual-E5-small is well-characterized for short-document semantic similarity.**
12 layers, 384 dimensions, instruction-prefixed (`query:` / `passage:`). Per the
model card and the *MMTEB: Massive Multilingual Text Embedding Benchmark* report
(arXiv 2502.13595, 2025), cosine scores on this family characteristically pile in
`[0.7, 1.0]` — *relative order matters, not absolute magnitude*. The 0.85 threshold
for `visit_resembles_visit` is therefore a *relative cutoff against the empirical
distribution*, not a calibrated probability.

**Explainable recommendation literature favors structured, content-based, actionable
explanations over free-text prose for trust calibration.** Zhang & Chen 2018; Ge et
al., *A Survey on Trustworthy Recommender Systems*, ACM TORS 2024; Naiseh et al. on
trust calibration; Said 2025 (*On explaining recommendations with LLMs*) on prose
confabulation risk. NN/g UX guidance ("Tips for Presenting Bulleted Lists in Digital
Content") is in lock-step. **Empirical license to ship deterministic, structured
explanation surfaces in Stage 1 instead of LLM-generated prose.**

**Union-Find is the canonical clustering primitive when the structure is "things
connected by an edge predicate."** Tarjan 1975. HDBSCAN itself uses Union-Find
internally on its mutual-reachability MST. Splink/UniqTag note: cluster IDs are
deterministic so long as clusters are stable; the ID equals a content-derived
function of all nodes in the cluster.

**Manifest V3 storage.** `chrome.storage.local` is capped at ~10 MB unless
`unlimitedStorage` is requested (5 MB pre-Chrome 114), serializes via JSON, not a
recommended substrate for high-frequency append-only event streams. IndexedDB is
available to MV3 service workers, has no fixed cap (origin quota), and modern
guidance (Lawson 2021/2025; RxDB benchmarks) recommends batched writes and
`getAll()`/`getAllRecords` over per-item cursoring.

**Manifest V3 service-worker constraints.** Event-driven; terminated after ~30 s of
inactivity (forcibly after 5 minutes of activity). Global state unsafe; everything
that must survive must be in `chrome.storage.*` or IndexedDB. All listeners must
register at the top level of the service worker module.

**chrome.webNavigation gives the deterministic causal spine.** `onCommitted` exposes
`transitionType` (`link` / `typed` / …) and `transitionQualifiers` (`client_redirect`
/ `forward_back` / `from_address_bar` / …). `chrome.tabs.onCreated` exposes
`openerTabId`, **only present if the opener tab still exists** (Chrome Developers
`chrome.tabs` reference). Plan handles the absent-opener case explicitly.

**SimHash with Hamming ≤ 3 over 64-bit fingerprints is the canonical near-duplicate
threshold.** Manku, Jain & Sarma, *Detecting Near-Duplicates for Web Crawling*, 2007.
`k = 3, b = 64` is the empirical sweet spot for "near-duplicate but not identical"
at web scale. Practitioners caution that too-strict thresholds produce false
negatives and that one must always normalize before hashing — both points reflected
in 1.H.

**Task trail.** Liao et al., *Task Trail: An Effective Segmentation of User Search
Behavior*, TKDE 2014 ([PDF](http://sonyis.me/paperpdf/tkde-2014.pdf)). Multi-signal
segmentation. Applies to Stage 1.B's provenance edges and Stage 2's eventual ranker.

**Cross-session task identification.** Wang et al., *Modeling and Analysis of
Cross-Session Search Tasks*, ICTIR 2013 ([Microsoft Research PDF](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/12/Modeling-and-Analyses-of-Multi-Session-Search-Tasks.pdf)).
Tasks transcend sessions; same canonical URL across weeks must be linkable.

**BrowseRank.** Liu et al., *BrowseRank: Letting Web Users Vote for Page Importance*,
SIGIR 2008. Models user browsing as a continuous-time Markov chain over a graph of
URL visits. The `visit_navigated_from` graph in 1.B is effectively a per-user, scoped
BrowseRank graph.

## Critical files

```
packages/sidetrack-extension/src/
  background/
    service-worker.ts                    # top-level listener registration (MV3-safe)
    listeners/
      web-navigation.ts                  # onCommitted -> navigation.committed (1.B)
      tabs.ts                            # onCreated openerTabId resolution (1.B)
      idle.ts                            # idle.onStateChanged -> activeMs gating
    storage/
      chrome-local.ts                    # small hot working set
      indexeddb-event-buffer.ts          # NEW (C6) — Class F append-only streams (1.A/1.F/1.H)
      flush-scheduler.ts                 # alarms-driven batched flush
    privacy/
      events.ts                          # Class A privacy.* event emission (Lock 4)
      gate-resolver.ts                   # replays events into current gate state
  content/
    engagement/
      visibility.ts                      # Page Visibility API, focus, idle (1.A)
      scroll.ts                          # throttled scrollEvents/maxScrollRatio (1.A)
      copy-paste.ts                      # selection.copied/pasted, hash-only default (1.H)
    inject.ts                            # gated injection per privacy.gate
  graph/
    canonical-url.ts                     # utm/fbclid/gclid/srsltid strip; lowercase host (1.B)
    fnv1a.ts                             # 32-bit FNV-1a for tabSessionIdHash etc. (1.B)
    simhash64.ts                         # 64-bit SimHash; Hamming ≤ 3 within 24h (1.H)
    union-find.ts                        # path-compressed UF; deterministic topic ids (1.D)
    topic-id.ts                          # sha256 of canonical URL members (1.D)
    visit-resembles.ts                   # cosine over existing recall embedder (1.C)
    cross-replica.ts                     # visit_observed_on_replica producer (1.E)
    engagement-class.ts                  # rule-based classifier (1.G)
  ui/
    flow-path/                           # (1.J)
    focus-view/                          # (1.J)
    why-related/
      reasons.ts                         # Reason union type and renderer (1.I)
      sort.ts                            # fixed reason-code priority
    context-pack/
      compose.ts                         # deterministic Markdown reducer (1.I)
  reuse/                                 # imports only; no logic
    recall-embedder.ts                   # re-export of multilingual-e5-small embedder
    minisearch-hybrid.ts                 # re-export of existing hybrid retrieval
    test-embedder.ts                     # deterministic test embedder pattern
packages/sidetrack-companion/src/
  producers/
    visit-resembles-revision.ts          # Class E producer (1.C)
    engagement-class-revision.ts         # Class E producer (1.G)
    topic-revision.ts                    # Class E producer (1.D)
  materializers/
    privacy.ts                           # Class A replay (Lock 4)
    cross-replica.ts                     # Class B materialization (1.E)
  sync/
    contract-v1/                         # already in production
```

## Reuse pointers (load-bearing)

Stage 1 must not duplicate or wrap these production components.

1. **The recall embedder.** `multilingual-e5-small` via `@huggingface/transformers`
   (`Xenova/multilingual-e5-small`, pinned HF revision, 384 dims, `query:` /
   `passage:` prefix discipline, dtype cascade, `RECALL_MODEL_MISSING` typed error,
   deterministic test embedder, model-revision-aware stale-index behavior,
   product-owned model cache). Stage 1 uses this for 1.C and *only* 1.C. Do not
   introduce `bge`, `Nomic`, or `EmbeddingGemma`.
2. **The binary recall index V3** at `_BAC/recall/index.bin`. With `modelId`,
   pinned model revision, chunk schema version, schema capabilities, per-entry
   metadata, replica id, Lamport, tombstones, deterministic canonical ordering,
   source-scoped replacement. Stage 1 inserts visit embeddings through this path.
   Do not introduce `sqlite-vec`, `hnswlib`, USearch, or Faiss.
3. **MiniSearch + cosine + RRF hybrid retrieval.** With title/heading/text field
   weights and dotted-identifier tokenization. Stage 1 uses this for the candidate
   set in 1.C and for the `LEXICAL_OVERLAP` reason in 1.I. Keep the existing fixed
   `lexical*0.3 + vector*0.5 + link*0.2` convex combination at threshold `0.55`.
   **Do not introduce a learned ranker (LightGBM / XGBoost / LambdaMART) in Stage 1.**
4. **The deterministic test embedder pattern.** Mirror it for the IndexedDB layer
   (1.F) so tests don't require a real IndexedDB. Mirror it for the Why Related
   ranker (1.I) so the reason-code output is byte-deterministic in tests.
5. **Sync Contract v1.** Class A–F, plugin-only / companion / relay modes,
   replayable materializers. All new event types in 1.A, 1.B, 1.F, 1.H slot into
   the existing Class F edge; all Class B/D/E producers run in companion or in
   plugin-only fallback. No new transport.

## Verification

| Sub-section | Verification |
|---|---|
| 1.A | Engagement events emitted only when the corresponding privacy gate is open; aggregates reproducible from raw observations (replay test). |
| 1.B | Manifest declares `webNavigation`; `onCommitted` payloads carry the full `transitionType` set; `openerVisitId` is `null` (not invented) when opener tab is gone; FNV-1a hashes are stable across runs given the same inputs. |
| 1.C | New visits produce `visit_resembles_visit` only when cosine ≥ T_sim; threshold is configurable; embedder is the existing recall embedder (no second model loaded); Class E revision replaces prior under model revision change. |
| 1.D | `topic_id` is reproduced byte-identically by an independent replica given the same membership; user `in_thread` overrides cosine-only membership; component split/merge produces a `topic.lineage` edge. |
| 1.E | Multi-replica fixture emits exactly one `visit_observed_on_replica` per (visit, replicaId) pair; edge confidence is `'observed'`, not `'inferred'`. |
| 1.F | `chrome.storage.local` usage stays under 5 MB at 10 k synthetic events; IndexedDB buffer flushes at the documented batch size; deterministic test adapter passes the same suite. |
| 1.G | Each rule fires only when its predicate is satisfied; no class is assigned non-deterministically; the `engagement-class:v1:rules` artifact carries the correct `producedBy`. |
| 1.H | Hash-only default is enforced (raw text never appears in any persisted record unless gate open or explicit promote); SimHash Hamming ≤ 3 within 24 h links copy → paste; `snippet_reused_across_threads` only fires at ≥ 2 threads. |
| 1.I | Topic labels equal `representativeTitles[0]` byte-for-byte; reason-code output is byte-identical run-to-run on the same input; Markdown Context Pack is byte-identical run-to-run. |
| 1.J | All four UI surfaces render without any network call to an inference endpoint (asserted by a network-mock that fails the test on any outbound LLM-shaped request). |
| 1.K | The full e2e suite passes against the deterministic test embedder; no neural stub other than that embedder is required. |

## Out of scope (Stage 1)

- Learned ranker for `closest_visit` (Stage 2).
- User-feedback supervised learning loop (Stage 3).
- Debug-pack MCP tool.
- Visual fingerprinting / DOM hash / screenshot perceptual hash.
- HDBSCAN, Leiden, or other centroid-stable clustering.
- SQLite FTS5, sqlite-vec, DuckDB feature store.
- Cross-replica continuation classifier (the inference edge atop 1.E).
- **Local LLM inference of any kind** — Ollama, llama.cpp, MLX runtime, Llama 3.2,
  Qwen 2.5, Phi, Gemma, SmolLM, EmbeddingGemma 300M, Nomic Embed v2.
- New ANN libraries (USearch, hnswlib, Faiss).
- New embedding models (bge, Nomic, EmbeddingGemma) — keep the existing
  `multilingual-e5-small`.
- Optional cloud-LLM prose enhancement (deferred; the Class E revision pattern in
  1.C and 1.I is in place so a future PR can add it as `*-revision:v2:cloud-llm`
  with the user's own API key, additively, without touching the deterministic
  surfaces).

## Implementation PR shape

This planning doc lands in **PR #99 as plan-only**. Once reviewers approve the plan,
PR #99 is **merged with one commit** (the planning doc on `feat/work-graph-mvp`).

**Wave A and beyond ship in a separate, fresh PR** off `main` after PR #99 merges.
Reasons:

- Clean planning history. PR #99 is a doc; the next PR is code. Reviewers can
  re-load context cheaply.
- Bisect cleanliness. A code-only PR has commit-by-commit `git bisect run` value.
- Faster Codex onboarding. Codex worktrees fork from a stable base (the merged
  plan), not from a moving plan-and-code branch.

**Each subtask lands as an independent commit** on the implementation PR. No
subtask squashes another's commits. The PR title for the implementation PR will
be something like `Stage 1 MVP — work graph (Wave A: locks + storage)`, with
follow-up PRs per wave if the implementation PR grows beyond ~3 000 lines.

If the lead's review on a Codex-delivered subtask uncovers a small fix, the fix
lands as a *new* commit on the same branch, not by amending the Codex commit.

## Work split — major tasks vs Codex subtasks

The lead (Claude Code, this session) holds **planning, integration, cross-cutting
design, e2e spec authorship, PR-body writing, and review**. Codex handles
**deterministic, well-scoped code additions** in parallel batches.

Pattern: lead authors a self-contained subtask brief (file paths + interfaces +
test requirements + acceptance criteria); user spins Codex with that brief; Codex
delivers; lead integrates and reviews. Multiple subtasks run in parallel when
their dependencies allow.

### Subtask dependency graph

```
S1 confidence enum + dashed CSS  ───┬── (independent, no deps)
S2 payloadVersion + dimensions   ───┘
S3 producedBy union extension    ─── depends on S1+S2
S4 privacy events (Class A)      ─── depends on S2
S5 IndexedDB event buffer (C6)   ─── depends on S2
                                                ↓
S6 webNavigation listeners (1.B) ─── depends on S2,S5
S7 engagement content script (1.A) ─ depends on S2,S5,S4
S8 copy/paste content script (1.H) ─ depends on S2,S5,S4
                                                ↓
S9  visit_resembles_visit (1.C)  ─── depends on S3,S6 (visits exist)
S10 union-find topic clusterer (1.D) ─ depends on S9 (similarity edges exist)
S11 visit_observed_on_replica (1.E) ─ depends on S6
S12 engagement classifier (1.G)  ─── depends on S7,S8 (engagement + lineage)
                                                ↓
S13 deterministic templates (1.I) ── depends on S10,S11,S12 (everything resolved)
S14 UI surfaces (1.J)            ─── depends on S13
                                                ↓
S15 e2e spec (1.K)               ─── depends on all of the above (lead-authored)
S16 docs                         ─── depends on S15 (lead-authored)
```

Two parallel waves possible:

- **Wave A** (S1 / S2 / S4 / S5) — locks + privacy events + storage substrate. Four
  Codex tasks, no inter-dependencies.
- **Wave B** (after Wave A lands) — S6 / S7 / S8 in parallel; S3 in parallel.
- **Wave C** — S9 / S10 / S11 / S12 in parallel.
- **Wave D** — S13 / S14 sequentially (lead-led integration).

### Subtask briefs (for Codex)

Each subtask is a self-contained brief Codex can execute. Lead writes the brief; user
spins Codex; user notifies lead on completion; lead integrates.

**S1 — Confidence enum + dashed CSS rendering** (Lock 1).
- Files: `packages/sidetrack-companion/src/connections/types.ts`,
  `packages/sidetrack-extension/entrypoints/sidepanel/style.css`,
  `packages/sidetrack-extension/src/sidepanel/connections/ConnectionsView.tsx`.
- Extend `ConnectionEdge.confidence` to `{'asserted' | 'observed' | 'inferred'}`.
- Migrate every existing edge stamp: user-entered → `'asserted'`, event-derived →
  `'observed'`, similarity / clustering → `'inferred'`.
- Add CSS rule `.confidence-inferred { stroke-dasharray: 4 2; opacity: 0.7; }` for
  the orbital SVG; analogous rule for the linked-panels view's edge lines.
- Update `connections/snapshot.test.ts` for the new enum.
- Acceptance: every edge in every existing test fixture maps cleanly to one of the
  three values. No existing test reports false confidence.

**S2 — `payloadVersion` + `dimensions` extension slot** (Lock 2).
- Files: every event-type interface under
  `packages/sidetrack-companion/src/{threads,workstreams,timeline,dispatches,annotations,queue,recall}/events.ts`
  + extension-side `packages/sidetrack-extension/src/timeline/events.ts`.
- Add `payloadVersion?: number` (default 1) and `dimensions?: Record<string, unknown>`
  to every event payload.
- Augment `ContractEntry` (`packages/sidetrack-companion/src/sync/contract/registry.ts:72-75`)
  with `currentPayloadVersion?: number`; stamp every entry. Registry coverage test
  asserts presence.
- Loosen runtime predicates (`isBrowserTimelineObservedPayload` etc.) to accept any
  `payloadVersion >= 1` and any `dimensions` shape.
- Acceptance: existing event log replays without modification; new optional fields
  are visible to producers but cause no test failures.

**S3 — `producedBy` provenance union extension** (Lock 3).
- Files: `packages/sidetrack-companion/src/connections/types.ts`.
- Extend `ConnectionEdge.producedBy` union with the new variants:
  - `{ source: 'visit-similarity'; revisionId: string }`
  - `{ source: 'topic-clusterer'; revisionId: string }`
  - `{ source: 'engagement-classifier'; revisionId: string }`
  - `{ source: 'snippet-lineage'; revisionId: string }`
  - `{ source: 'cross-replica' }` (no revisionId — deterministic)
- Existing variants (`'event-log'`, `'vault'`, `'timeline-projection'`) unchanged.
- Acceptance: type-checker accepts both old and new variants; no runtime change yet
  (downstream subtasks consume).

**S4 — Privacy events as Class A facts** (Lock 4).
- Files: `packages/sidetrack-companion/src/privacy/events.ts` (NEW),
  `packages/sidetrack-companion/src/privacy/projection.ts` (NEW),
  `packages/sidetrack-companion/src/privacy/projection.test.ts` (NEW),
  `packages/sidetrack-companion/src/sync/contract/registry.ts` (register).
- Event types: `privacy.gate.flipped`, `privacy.permission.granted`,
  `privacy.permission.revoked`. Schemas per § 1.F.
- Class B projection: replays events into current gate state; supports retroactive
  masking when `retroactiveMask: true` on revoke.
- Migration shim: SW-boot reads existing `chrome.storage.local['sidetrack.timeline.enabled']`,
  emits a `privacy.gate.flipped` event if no privacy events exist yet.
- Acceptance: gate flip drops subsequent observations from derived caches; cross-
  replica revoke replays correctly.

**S5 — IndexedDB Class F event buffer** (C6).
- Files: `packages/sidetrack-extension/src/background/storage/indexeddb-event-buffer.ts`
  (NEW), `packages/sidetrack-extension/src/background/storage/flush-scheduler.ts`
  (NEW), unit tests.
- Append-only event store keyed by `(streamName, lamport, replicaId)`.
- Batched writes ≤ 100 items / ≤ 1 s.
- `chrome.alarms`-driven flush at 60 s minimum.
- Deterministic in-memory adapter behind the same interface for tests.
- Manifest gains `unlimitedStorage`.
- Acceptance: 10 k-event drive-test passes; in-memory adapter passes the same
  contract tests as the IndexedDB adapter.

### Wave B — depends on Wave A

**S6 — webNavigation listeners + canonical URL + FNV-1a** (1.B).

*Worktree branch:* `codex/stage1-s6-webnavigation` off `feat/work-graph-mvp` (after Wave A merges).

*Depends on:* S2 (`payloadVersion` + `dimensions`), S5 (IDB buffer for the new event stream).

*Files (NEW unless noted):*
- `packages/sidetrack-extension/src/background/listeners/web-navigation.ts`
- `packages/sidetrack-extension/src/background/listeners/tabs.ts`
- `packages/sidetrack-extension/src/graph/canonical-url.ts`
- `packages/sidetrack-extension/src/graph/fnv1a.ts`
- `packages/sidetrack-extension/src/graph/canonical-url.test.ts`
- `packages/sidetrack-extension/src/graph/fnv1a.test.ts`
- `packages/sidetrack-extension/wxt.config.ts` (modify — add `webNavigation` to permissions)
- `packages/sidetrack-extension/entrypoints/background.ts` (modify — register listeners at top level)
- `packages/sidetrack-companion/src/sync/contract/registry.ts` (modify — register `navigation.committed` event type with `currentPayloadVersion: 1`, `allowedDimensions: ['provenance']`)

*Schemas:*

```ts
// navigation.committed event type
type NavigationCommittedPayload = {
  payloadVersion: 1;
  visitId: string;                              // canonicalUrl + commitTimestamp + replicaId
  url: string;
  canonicalUrl: string;
  documentId: string;
  parentDocumentId: string | null;
  tabSessionIdHash: string;                     // FNV-1a-32 of (tabId, browserSessionStart), salted
  windowSessionIdHash: string;                  // FNV-1a-32 of (windowId, browserSessionStart), salted
  openerVisitId: string | null;                 // null when openerTabId absent or opener gone
  previousVisitId: string | null;               // last visit on same tabSessionIdHash
  navigationSequence: number;                   // monotone within tabSessionIdHash
  transitionType: TransitionType;
  transitionQualifiers: TransitionQualifier[];
  commitTimestamp: number;
  dimensions?: { provenance?: Record<string, unknown> };
};
```

*Change shape:*
- Wire `chrome.webNavigation.onCommitted` (top-frame only — filter `details.frameId === 0`).
- Wire `chrome.tabs.onCreated` to capture `openerTabId` synchronously; maintain a SW
  in-memory `tabId → lastVisitId` cache hydrated lazily from the IDB stream on SW
  boot (the cache is a fast path, IDB is the source of truth).
- Resolve opener: when present, look up the opener's most recent
  `navigation.committed` for the matching tab; emit `openerVisitId`. When opener is
  absent or the tab is gone, emit `null` and rely on `previousVisitId` along the
  same `tabSessionIdHash`.
- Canonical URL normalizer strips: `utm_*`, `fbclid`, `gclid`, `srsltid`, `mc_cid`,
  `mc_eid`, `_ga`, `_gid`. Lowercases scheme + host. Removes default port (`:80`,
  `:443`). Drops fragment.
- FNV-1a 32-bit hash function. Salted with the existing `edgeReplicaId` so peers
  can't collide-spoof. Pure function; no global state.
- All listeners register at the top level of the SW module per MV3 discipline.

*Tests required:*
- `canonical-url.test.ts` — 30+ canonical-URL pairs covering each tracking-param,
  case-folding, port-stripping, fragment-dropping rule.
- `fnv1a.test.ts` — known-vector tests; collision check across 10 k synthetic inputs.
- `web-navigation.test.ts` — fixture-based test with simulated webNavigation events;
  asserts `openerVisitId` is `null` when opener was force-closed before the new tab
  emits its first navigation.
- `tabs.test.ts` — `onCreated` opener resolution; closed-opener fallback.

*Acceptance:*
- `vitest run` green; `wxt build` clean.
- Manifest declares `"webNavigation"` (verified by `cat .output/chrome-mv3/manifest.json`).
- `navigation.committed` events flow into the IDB buffer (S5) within 100 ms of
  `onCommitted` firing.
- Causal-spine e2e scenario (1.K-1) passes against this listener stack: address-bar
  type → `transitionType: 'typed'`; click link → `openerVisitId` populated; force-
  close opener → `openerVisitId: null`, `previousVisitId` populated.

---

**S7 — Engagement content script (1.A) + dynamic registration**.

*Worktree branch:* `codex/stage1-s7-engagement-script`.

*Depends on:* S2 (dimensions slot), S4 (privacy projection — gate state lookup),
S5 (IDB buffer for `engagement.interval.observed`).

*Files (NEW unless noted):*
- `packages/sidetrack-extension/src/content/engagement/visibility.ts`
- `packages/sidetrack-extension/src/content/engagement/scroll.ts`
- `packages/sidetrack-extension/src/content/engagement/aggregator.ts`
- `packages/sidetrack-extension/src/content/inject.ts` (NEW or modify if exists)
- `packages/sidetrack-extension/entrypoints/engagement.ts` (NEW — content script entry)
- `packages/sidetrack-extension/entrypoints/background.ts` (modify — `chrome.scripting.registerContentScripts` gated on privacy projection + `chrome.runtime.onMessage` handler for engagement-summary postbacks)
- `packages/sidetrack-extension/src/background/state/engagementCache.ts` (NEW — per-tab running totals, crash-safe)
- `packages/sidetrack-companion/src/sync/contract/registry.ts` (modify — register `engagement.interval.observed` and `engagement.session.aggregated` with `allowedDimensions: ['engagement']`)

*Schemas:*

```ts
type EngagementIntervalObservedPayload = {
  payloadVersion: 1;
  visitId: string;                          // links to navigation.committed
  intervalStart: number;
  intervalEnd: number;
  dimensions: {
    engagement: {
      activeMs: number;
      visibleMs: number;
      focusedWindowMs: number;
      idleMs: number;
      foregroundBursts: number;
      returnCount: number;
      scrollEvents: number;
      maxScrollRatio: number;               // 0..1, monotonically non-decreasing within visit
      copyCount: number;
      pasteCount: number;
    };
  };
};

type EngagementSessionAggregatedPayload = {
  payloadVersion: 1;
  visitId: string;
  sessionId: string;                        // browserSessionStart hash
  dimensions: {
    engagement: EngagementIntervalObservedPayload['dimensions']['engagement'];
  };
};
```

*Change shape:*
- Content script registers dynamically via `chrome.scripting.registerContentScripts`
  ONLY when both: privacy projection has `engagement` gate `'open'` AND host
  permission has been granted. SW reads the privacy projection on boot + subscribes
  to `chrome.runtime.onMessage` for `'sidetrack.privacy.gateChanged'` events to
  re-register / unregister.
- Content script captures counts + durations only. Listeners:
  - `document.addEventListener('visibilitychange', ...)` for visible / hidden flips.
  - `window.addEventListener('focus' / 'blur', ...)` for window-focus changes.
  - `document.addEventListener('scroll', throttled1Hz, { passive: true })` for
    scrollEvents counter + maxScrollRatio computation.
  - `chrome.idle.onStateChanged` (extension-side) for idle-threshold gating.
  - `document.addEventListener('copy' / 'paste', ...)` for copyCount / pasteCount
    (S8 will extend this listener; for S7, just maintain the count).
- Periodic 30 s sub-emit: `chrome.runtime.sendMessage` carries the running totals
  to the SW; SW merges into `engagementCache[tabId]`.
- Final emit on `visibilitychange` (hidden) / `pagehide` / `beforeunload`: same
  shape; SW marks the interval as final.
- SW per-tab cache survives content-script crashes: when `chrome.tabs.onRemoved`
  fires, SW emits the cached totals as the final
  `engagement.interval.observed`.

*Tests required:*
- `aggregator.test.ts` — pure-function tests for the running-totals merge.
- `engagementCache.test.ts` — SW-side cache survives simulated crashes.
- Integration test that drives a JSDOM-mocked content script through visibility +
  scroll + copy events and asserts the emitted payload shape.

*Acceptance:*
- `vitest run` green; `wxt build` clean.
- Privacy posture grep passes:
  `grep -rn 'event.key\|event.target.value\|getRangeAt\|clipboard.readText' packages/sidetrack-extension/entrypoints/engagement.ts` returns 0 matches.
- Engagement-classification e2e scenario (1.K-2) passes: 3 pages with distinct
  engagement profiles produce distinct `engagement.session.aggregated` records
  with the expected counter values.
- Privacy-revocation scenario (1.K-5) passes: gate flip to `closed` causes
  `chrome.scripting.unregisterContentScripts` to fire; no further engagement events
  are emitted.

---

**S8 — Copy/paste content script + simhash + 24-hour matching** (1.H).

*Worktree branch:* `codex/stage1-s8-copy-paste-lineage`.

*Depends on:* S2, S4, S5, S7 (extends the same content script — engagement registers
the listener; S8 extends with hashing + emit).

*Files (NEW unless noted):*
- `packages/sidetrack-extension/src/content/engagement/copy-paste.ts` (NEW)
- `packages/sidetrack-extension/src/graph/simhash64.ts` (NEW)
- `packages/sidetrack-extension/src/graph/simhash64.test.ts`
- `packages/sidetrack-extension/src/graph/normalize-selection.ts` (NEW — whitespace collapse, header/footer strip, timestamp drop)
- `packages/sidetrack-companion/src/snippets/events.ts` (NEW)
- `packages/sidetrack-companion/src/snippets/projection.ts` (NEW)
- `packages/sidetrack-companion/src/snippets/projection.test.ts`
- `packages/sidetrack-companion/src/sync/contract/registry.ts` (modify — register `selection.copied` / `selection.pasted` with `allowedDimensions: []` and explicit `rawTextStored: false` redaction in the predicate)
- `packages/sidetrack-companion/src/connections/types.ts` (modify — add `'snippet'` `ConnectionNodeKind`)
- `packages/sidetrack-companion/src/connections/snapshot.ts` (modify — Pass 10 emits snippet edges from snippets projection)

*Schemas:*

```ts
type SelectionCopiedPayload = {
  payloadVersion: 1;
  visitId: string;
  selectionHash: string;                    // SHA-256 of normalized text
  simhash64: string;                        // base64 of 64-bit SimHash
  charCount: number;
  lineCount: number;
  contentKindHint: 'code-block' | 'prose' | 'url' | 'mixed';
  rawTextStored: false;                     // contract assertion; predicate rejects true
};

type SelectionPastedPayload = {
  payloadVersion: 1;
  destinationKind: 'thread' | 'dispatch' | 'search' | 'note' | 'capture';
  destinationId: string;
  selectionHash: string;
  simhash64: string;
  charCount: number;
  rawTextStored: false;
};
```

*Change shape:*
- Content script extends the existing `copy` / `paste` listeners from S7 to capture
  the selection text via `window.getSelection().toString()` (or
  `event.clipboardData.getData('text/plain')` on paste). Hash IMMEDIATELY via
  `crypto.subtle.digest('SHA-256', ...)`; never assign the raw text to a variable
  whose lifetime exceeds the local synchronous block.
- Normalize selection before hashing: collapse whitespace, drop heuristic UI chrome
  (regex `^[A-Za-z\s]+\n=+\n` for markdown headers, `^\s*(?:#|\/\/|>)` line strips),
  drop pure timestamp lines (`/^\s*\d{4}-\d{2}-\d{2}/`).
- 64-bit SimHash via the standard 128-token rolling-hash construction over the
  normalized text. Pure function; deterministic; tested.
- Companion-side `snippets/projection.ts`: pure reducer over merged event log.
  For each `selection.pasted`, look back 24 hours for `selection.copied` events
  with matching `selectionHash` (exact) OR `simhash64` Hamming-≤3. Emit a
  `snippet` node + edges.
- New connections-snapshot Pass 10 reads the snippets projection + emits:
  `snippet_copied_from_visit` (`confidence: 'observed'`),
  `snippet_pasted_into_<dest>` (`confidence: 'observed'`),
  `snippet_reused_across_threads` (`confidence: 'inferred'`, when same `snippet_id`
  appears in ≥ 2 thread destinations).

*Tests required:*
- `simhash64.test.ts` — known-vector tests; Hamming distance computation; 1 000-pair
  paraphrase test asserting most pairs land in the < 5 Hamming band.
- `normalize-selection.test.ts` — whitespace, header strip, timestamp drop, Unicode.
- `snippets/projection.test.ts` — exact-hash match, fuzzy match within 24 h, no
  match across 24-h window.
- `connections/snapshot.test.ts` — Pass 10 emission with synthetic copy/paste fixtures.

*Acceptance:*
- `vitest run` green.
- Privacy posture grep:
  `grep -rn 'rawText\|\.toString()\|clipboardData' packages/sidetrack-extension/src/content/engagement/copy-paste.ts` shows that ALL string handling is followed by an immediate `crypto.subtle.digest` call within the same synchronous block.
- `selection.copied` and `selection.pasted` predicates REJECT any payload with
  `rawTextStored: true` (defense in depth).
- Snippet-lineage e2e scenario (1.K-3) passes: copy from one visit → paste into
  thread → connections snapshot has `snippet_copied_from_visit` +
  `snippet_pasted_into_thread` edges.

---

### Wave C — depends on Wave B

**Convergence note.** Four Wave C subtasks all touch the same two integration files:

- `packages/sidetrack-companion/src/sync/contract/connectionsMaterializer.ts` — the
  pipeline that runs producers in order. S9, S12 thread new dependencies in; S10
  depends on S9's output; S11 is independent.
- `packages/sidetrack-companion/src/connections/snapshot.ts` — pass numbers 7
  (S9 visit similarity), 8 (S10 topics), 9 (S11 cross-replica), and the engagement
  metadata stamp (S12). The pass numbering must NOT collide.
- `packages/sidetrack-companion/src/connections/types.ts` — S10 adds the `'topic'`
  node kind, three edge kinds; S11 adds one edge kind. Same union, two PRs.

**Lead's integration plan:** Wave C subtasks run in parallel Codex worktrees. Each
PR's diff against `connectionsMaterializer.ts`, `snapshot.ts`, and `types.ts` will
likely conflict at merge time. The lead resolves merge conflicts in those three
files at integration time using the canonical pass numbering (Pass 7=S9, Pass 8=S10,
Pass 9=S11, plus S12's metadata stamp inside Pass 3 where timeline-visit nodes are
emitted). Subtasks are otherwise self-contained: no Codex job edits another's
producer/test files.

**Recommended Codex parallelism:** all four can run simultaneously. S10 reads S9's
similarity output via `ConnectionsInput.visitSimilarity` (a new field). If S10 lands
before S9, S10's tests use a fixture-injected similarity input; integration becomes
green only after S9 lands. Same posture as how S3 was authored ahead of S6 in Wave B.

---

**S9 — `visit_resembles_visit` producer** (1.C).

*Worktree branch:* `codex/stage1-s9-visit-resembles`.

*Depends on:* S3 (`producedBy` union extension), S6 (`navigation.committed` events
exist in the merged log).

*Files (NEW unless noted):*
- `packages/sidetrack-companion/src/connections/visitSimilarity.ts` (NEW)
- `packages/sidetrack-companion/src/connections/visitSimilarity.test.ts`
- `packages/sidetrack-companion/src/producers/visit-resembles-revision.ts` (NEW)
- `packages/sidetrack-companion/src/sync/contract/connectionsMaterializer.ts` (modify — thread `embed` dep + revision-id manager; call `buildVisitSimilarity` before `buildConnectionsSnapshot`)
- `packages/sidetrack-companion/src/connections/snapshot.ts` (modify — Pass 7 emits `visit_resembles_visit` from injected similarity input)

*Reuse pointers (load-bearing — do NOT duplicate):*
- `embed()` from `packages/sidetrack-companion/src/recall/embedder.ts:55+` — pinned
  `Xenova/multilingual-e5-small`, 384-dim, q8/fp16/fp32 cascade, deterministic test
  embedder via `SIDETRACK_TEST_EMBEDDER=1`.
- Binary recall index V3 at `_BAC/recall/index.bin` (writer:
  `packages/sidetrack-companion/src/recall/indexWriter.ts`; reader:
  `packages/sidetrack-companion/src/recall/ranker.ts`). Schema fields: `modelId`,
  pinned revision, chunk schema version, schema capabilities, per-entry metadata,
  replica id, Lamport, tombstones, deterministic canonical ordering, source-scoped
  replacement.
- MiniSearch hybrid retrieval at `packages/sidetrack-companion/src/recall/ranker.ts`
  (`rankHybrid`). Existing fixed `lexical*0.3 + vector*0.5 + link*0.2` convex
  combination at threshold 0.55. Title/heading/text field weights and dotted-
  identifier tokenization already implemented.
- `RecallModelMissingError` typed error pattern at
  `packages/sidetrack-companion/src/recall/embedder.ts:55-65` — failure-cooldown
  analog for the visit-similarity step's no-op-on-error semantics.
- `auditRetention.ts` retention pattern for old Class E revisions.

*Schemas:*

```ts
// New ConnectionsInput field consumed by snapshot.ts Pass 7.
type VisitSimilarityEdge = {
  fromVisitKey: string;       // canonical URL of visit A
  toVisitKey: string;         // canonical URL of visit B
  cosine: number;             // 0..1
};

type VisitSimilarityRevision = {
  revisionId: string;         // sha256(modelFingerprint + featureSchemaVersion + inputVisitIdsSorted).slice(0, 16)
  modelId: 'Xenova/multilingual-e5-small';
  modelRevision: string;      // pinned HF commit hash
  featureSchemaVersion: number;
  threshold: number;          // T_sim, default 0.85
  edges: readonly VisitSimilarityEdge[];
  producedAt: number;
};

// Pure function signature.
type BuildVisitSimilarity = (
  entries: readonly TimelineEntry[],
  embed: (texts: readonly string[]) => Promise<readonly Float32Array[]>,
  options?: { threshold?: number; topK?: number; engagementGateMs?: number },
) => Promise<VisitSimilarityRevision>;
```

*Change shape:*
- `buildVisitSimilarity(entries, embed)` — pure function. Extracts a "visit corpus
  string" of `<title> + <hostname> + <URL path tokens>` per visit. Embeds with the
  `passage:` prefix discipline. Inserts into the recall index V3 with the recall
  pipeline's existing `insertEntry` API. **No new vector store; no new ANN library;
  no new embedding model.**
- For each visit `v`, retrieve top-K=50 candidates via `rankHybrid` (existing).
  Among those, emit `visit_resembles_visit(v → u)` when cosine on the `query:`-
  prefixed embedding of `v` vs the index entry for `u` exceeds `T_sim` (default
  0.85; exposed as a developer-build setting persisted in `chrome.storage.local`).
- Engagement gate: emit only when both endpoints have
  `dimensions.engagement.focusedWindowMs > 5000` (drops noisy hover-and-leave).
- Output: deterministically-sorted edges. Sort by `(fromVisitKey, toVisitKey)`
  lexically. Tie-break ties on cosine by lexical order.
- Persistence: Class E revision at `_BAC/connections/visit-similarity/<revisionId>.json`.
  Old revisions GCed via the existing audit-retention pattern.
- Pass 7 in `snapshot.ts`: emit `visit_resembles_visit` edges with
  `confidence: 'inferred'`, `producedBy: { source: 'visit-similarity', revisionId }`,
  `family: 'urlmatch'`.
- Failure mode: if `embed()` throws (`RecallModelMissingError` etc.), the similarity
  step no-ops; the snapshot still builds with every other edge intact. Materializer
  health surfaces `lastError`.

*Test scenarios (`visitSimilarity.test.ts`):*

- **Determinism — same input, byte-identical output.** Build twice with the same
  fixture; `JSON.stringify` of the revision (excluding `producedAt`) is identical.
- **Determinism — order-insensitive.** Permute the input `entries` array; assert
  output edges are byte-identical.
- **Threshold gate — boundary.** Two visits with cosine 0.849 → no edge. Cosine
  0.851 → edge.
- **Engagement gate — both endpoints.** A→B with A.focusedWindowMs=10000,
  B.focusedWindowMs=4999 → no edge. Both ≥ 5000 → edge.
- **Failure handling — embed throws.** Mock `embed` to throw; assert
  `buildVisitSimilarity` returns an empty-edge revision and emits a
  `materializer-error` log line; downstream snapshot still builds.
- **Top-K cutoff — does not emit edges below top-50.** Construct fixture with 60
  visits where rank 51 has cosine ≥ 0.85; assert that edge is NOT emitted.

*Test scenarios (`connectionsMaterializer.test.ts` integration):*

- **Pipeline runs visitSimilarity → snapshot end-to-end.** Inject deterministic
  test embedder; assert snapshot contains `visit_resembles_visit` edges with the
  expected `revisionId`.

*Fixtures:*

- `packages/sidetrack-companion/src/connections/__fixtures__/visitSimilarity-basic.json`
  — 5 visits, 2 of which share most of the title token set (high cosine), 3
  unrelated. Expected: 1 similarity edge.
- `packages/sidetrack-companion/src/connections/__fixtures__/visitSimilarity-engagement-gate.json`
  — 3 visits with varying focusedWindowMs straddling the 5000 ms gate. Expected:
  1 edge (the pair where both pass the gate).

*Acceptance:*

```sh
cd packages/sidetrack-companion
SIDETRACK_TEST_EMBEDDER=1 ./node_modules/.bin/vitest run src/connections/visitSimilarity.test.ts \
  src/sync/contract/connectionsMaterializer.test.ts                              # all green
./node_modules/.bin/tsc --noEmit -p tsconfig.json                                # silent
git diff --name-only main..HEAD | xargs grep -l 'sqlite-vec\|hnswlib\|usearch\|faiss\|@xenova/bge\|nomic-embed' 2>/dev/null
                                                                                 # 0 matches
git diff main..HEAD -- packages/sidetrack-companion/package.json                 # no new deps in dependencies
git diff main..HEAD -- packages/sidetrack-extension/package.json                 # no new deps
```

---

**S10 — Union-Find topic clusterer + `topic.lineage`** (1.D).

*Worktree branch:* `codex/stage1-s10-topic-clusterer`.

*Depends on:* S9 (`visit_resembles_visit` edges + similarity revision exist). Can
run in parallel with S9 if S10 uses a fixture-injected similarity input for tests;
integration becomes green when S9 lands.

*Files (NEW unless noted):*
- `packages/sidetrack-companion/src/connections/unionFind.ts` (NEW — path-compressed disjoint-set)
- `packages/sidetrack-companion/src/connections/unionFind.test.ts`
- `packages/sidetrack-companion/src/connections/topicId.ts` (NEW — content-derived id)
- `packages/sidetrack-companion/src/connections/topicId.test.ts`
- `packages/sidetrack-companion/src/connections/topicClusterer.ts` (NEW — clusterer + topic.lineage)
- `packages/sidetrack-companion/src/connections/topicClusterer.test.ts`
- `packages/sidetrack-companion/src/producers/topic-revision.ts` (NEW)
- `packages/sidetrack-companion/src/connections/types.ts` (modify — add `'topic'` `ConnectionNodeKind`, `'visit_in_topic'`, `'topic_in_workstream'`, `'topic.lineage'` edge kinds)
- `packages/sidetrack-companion/src/connections/snapshot.ts` (modify — Pass 8)
- `packages/sidetrack-extension/src/sidepanel/connections/edgeKinds.ts` (modify — register new kinds + 8th paper-warm tint)

*Reuse pointers:*
- `auditRetention.ts` retention pattern for old Class E revisions.
- `Web Crypto API` (`crypto.subtle.digest('SHA-256', ...)`) — already in use in
  the recall pipeline; do not introduce a new hash dep.

*Schemas:*

```ts
// New ConnectionNodeKind value: 'topic'
type TopicNodeMetadata = {
  memberCount: number;
  dominantWorkstreamId?: string;            // argmax workstream by member count; absent if no member has one
  representativeTitles: readonly string[];   // top-N by focusedWindowMs, capped at 5
  firstObservedAt: string;                   // ISO; min(member.firstObservedAt)
  lastObservedAt: string;                    // ISO; max(member.lastObservedAt)
  cohesion: number;                          // 0..1; mean cosine over the cluster's similarity edges
};

// New edge kinds:
//   visit_in_topic       (visit → topic)              confidence: 'inferred'
//   topic_in_workstream  (topic → workstream)         confidence: 'inferred'
//   topic.lineage        (topic_old → topic_new)      confidence: 'observed', kind: 'split' | 'merge'

type TopicRevision = {
  revisionId: string;     // sha256(visit-similarity revisionId + cosineThreshold + clustering algo version).slice(0, 16)
  visitSimilarityRevisionId: string;
  cosineThreshold: number;       // for membership, default 0.85 (matches S9)
  algorithmVersion: 'union-find:v1';
  topics: readonly {
    topicId: string;             // "topic:" + sha256(members.sort().join("\n")).slice(0, 16)
    memberCanonicalUrls: readonly string[];     // sorted ascending
    metadata: TopicNodeMetadata;
  }[];
  lineage: readonly {
    fromTopicId: string;
    toTopicId: string;
    kind: 'split' | 'merge';
    observedAt: string;          // ISO
  }[];
  producedAt: number;
};
```

*Change shape:*
- Path-compressed Union-Find with rank heuristic in `unionFind.ts`. O(α(n)) per
  union; deterministic iteration order over insertion sequence; expose
  `add(key)`, `union(a, b)`, `find(key)`, `members(componentRoot): readonly string[]`,
  `components(): readonly { root: string; members: readonly string[] }[]`.
- `topicId(members)` in `topicId.ts`. Content-derived: members sorted by canonical
  URL ascending, joined by `"\n"`, SHA-256, base64-url, sliced to 16 chars,
  prefixed `"topic:"`. Two replicas with the same membership produce the same id.
- `topicClusterer.ts`:
  1. Initialize Union-Find with all visit canonical URLs that have any similarity
     edge AND focusedWindowMs > 5000.
  2. Apply USER-ASSERTED edges first: any `in_thread` or `in_workstream` relation
     where both endpoints are visits. `uf.union(a, b)`.
  3. Apply COSINE edges: every `visit_resembles_visit` from S9 with cosine ≥ 0.85.
     `uf.union(a, b)`.
  4. For each component with `members.length ≥ 2`, compute `topicId`, gather
     metadata, emit a topic.
  5. Compute `topic.lineage` by diffing the previous revision's components
     against the current revision's. A previous component that's now split into
     two emits `kind: 'split'` from old → each new. A merge emits
     `kind: 'merge'` from each old → new.
- Pass 8 in `snapshot.ts`: read the active topic revision; for each topic, emit:
  - `topic` node with `metadata` from the revision.
  - `visit_in_topic` edges from each member visit to the topic
    (`confidence: 'inferred'`, `producedBy: { source: 'topic-clusterer', revisionId }`).
  - `topic_in_workstream` when ≥ 75 % of members share a `workstreamId`. Threshold
    exposed as a setting.
  - `topic.lineage` edges from the revision's `lineage` array
    (`confidence: 'observed'`, `producedBy: { source: 'topic-clusterer', revisionId }`).
- Persistence: Class E revision at `_BAC/connections/topics/<revisionId>.json`.
  Old revisions GCed via auditRetention.

*Test scenarios:*

`unionFind.test.ts`:
- Classic disjoint-set property tests (find, union, path compression).
- Deterministic iteration: insertion order A, B, C → `components()` returns the
  same root assignment as B, A, C in the SAME insertion sequence (the test verifies
  determinism for a fixed sequence).
- Path compression preserves component identity across deep find chains.

`topicId.test.ts`:
- Same membership → same id, regardless of input order. Permute member array,
  hash matches.
- Different membership → different id (delete one member, expect different id).

`topicClusterer.test.ts`:
- **Cosine threshold.** Cluster with all edges at cosine 0.84 → no topic. All
  edges at 0.86 → 1 topic with all 3 members.
- **User-asserted override.** 3 visits, no cosine edges, but 1 `in_thread` edge
  between two of them → 1 topic of 2 members.
- **Engagement gate.** A visit with focusedWindowMs=4000 is excluded from
  Union-Find inputs even if it has high-cosine edges.
- **Singleton suppression.** A 1-visit "cluster" emits no topic.
- **`topic.lineage` split.** Previous revision: topic X of 4 members. Current:
  one member's similarity edges have decayed below threshold; topic X splits
  into topic Y (3 members) and topic Z (1 member). Emit `topic.lineage(X, Y,
  kind: 'split')` AND `topic.lineage(X, Z, kind: 'split')`. (Z is a singleton
  so topic Z is NOT emitted but the lineage edge still records the split.)
- **`topic.lineage` merge.** Previous revision: topics X (3 members) + Y
  (2 members). Current: a new visit bridges them via similarity. Emit topic
  Z = X ∪ Y ∪ {bridge} and `topic.lineage(X, Z, kind: 'merge')`,
  `topic.lineage(Y, Z, kind: 'merge')`.
- **Cohesion metric.** A topic with 3 members and 3 cosine edges of values 0.85,
  0.90, 0.95 → cohesion = 0.90.
- **Determinism.** Build twice with the same input + same prior revision; output
  byte-identical (excluding `producedAt`).

*Fixtures:*

- `packages/sidetrack-companion/src/connections/__fixtures__/topic-basic.json` —
  6 visits forming 2 clusters (3 visits each).
- `packages/sidetrack-companion/src/connections/__fixtures__/topic-user-assertion.json`
  — Visits with weak cosine but strong user `in_thread` edges.
- `packages/sidetrack-companion/src/connections/__fixtures__/topic-lineage-split.json`
  — Previous revision + current revision pair demonstrating a split.
- `packages/sidetrack-companion/src/connections/__fixtures__/topic-lineage-merge.json`
  — Same for a merge.

*Acceptance:*

```sh
cd packages/sidetrack-companion
./node_modules/.bin/vitest run src/connections/unionFind.test.ts \
  src/connections/topicId.test.ts src/connections/topicClusterer.test.ts          # all green
./node_modules/.bin/tsc --noEmit -p tsconfig.json                                 # silent

# Cross-replica id determinism check (mock 2 replicas with the same membership)
./node_modules/.bin/vitest run src/connections/topicId.test.ts -t 'cross-replica' # green

cd packages/sidetrack-extension
./node_modules/.bin/wxt build                                                     # bundle clean
```

---

**S11 — `visit_observed_on_replica` producer** (1.E).

*Worktree branch:* `codex/stage1-s11-cross-replica-evidence`.

*Depends on:* S6 (`navigation.committed` events exist on multiple replicas). Can
run in parallel with S9 / S10 / S12 — its inputs are pure event-log reads, no
producer dependency.

*Files (NEW unless noted):*
- `packages/sidetrack-companion/src/materializers/cross-replica.ts` (NEW)
- `packages/sidetrack-companion/src/materializers/cross-replica.test.ts`
- `packages/sidetrack-companion/src/connections/snapshot.ts` (modify — Pass 9)
- `packages/sidetrack-companion/src/connections/types.ts` (modify — add `'visit_observed_on_replica'` edge kind)

*Reuse pointers:*
- `eventLog.readMerged()` from `packages/sidetrack-companion/src/sync/eventLog.ts`
  — gives the merged event stream (already used by `connectionsMaterializer.ts`).
- `BROWSER_TIMELINE_OBSERVED` constant if S6 routes timeline events through that;
  otherwise the new `'navigation.committed'` constant from S6's registration.

*Schemas:*

```ts
// New ConnectionEdgeKind value: 'visit_observed_on_replica'
// Edge shape:
{
  kind: 'visit_observed_on_replica',
  fromNodeId: 'timeline-visit:<canonical-url>',
  toNodeId: 'replica:<replica-id>',     // NEW node kind 'replica' (10th)
  confidence: 'observed',
  producedBy: { source: 'cross-replica' },
  observedAt: '<iso>',                  // first-observed-at on that replica
  family: 'urlmatch'
}

// Pure reducer signature.
type BuildCrossReplicaEdges = (
  merged: readonly AcceptedEvent[],
) => readonly CrossReplicaEdge[];
```

*Change shape:*
- Pure reducer over the merged event log. Filter `navigation.committed` events
  (or whichever Class F event-type carries the canonical URL — verify against
  S6's actual event-type constant).
- Group by `canonicalUrl`. For each group, emit `visit_observed_on_replica` for
  every distinct `dot.replicaId` other than the first-observing one. The edge's
  source is the canonical visit (`timeline-visit:<canonicalUrl>`); the target is
  a `replica:<replicaId>` node.
- New `'replica'` `ConnectionNodeKind` (10th) — minimal node, `metadata: { replicaId, firstSeenAt, lastSeenAt }`.
  Replica nodes don't get a paper-warm tint or special UI treatment in Stage 1
  (deferred to Stage 2 cross-device-continuation classifier work); they exist as
  a graph endpoint so the edge has somewhere to point.
- `confidence: 'observed'`, `producedBy: { source: 'cross-replica' }`. NO
  revisionId (deterministic Class B evidence — every replica with the same merged
  log produces the same edge, so revision tracking is meaningless).
- Family: `urlmatch` (content match, not navigation).
- Emit ONE edge per `(canonicalUrl, replicaId)` pair, even if the same replica
  observed the URL multiple times — first-observed-at on that replica wins for
  the edge timestamp.
- Sort emission deterministically: edges sorted by `(fromNodeId, toNodeId)`
  lexically.
- Pass 9 in `snapshot.ts`.

*Test scenarios (`cross-replica.test.ts`):*

- **Single replica.** Fixture with all events from one replicaId → no cross-replica
  edges emitted.
- **Two replicas, same URL.** Fixture: replica A observes `https://example.com/x`
  at T1; replica B observes the same URL at T2. Emit:
  - `visit_observed_on_replica('timeline-visit:https://example.com/x' → 'replica:A', observedAt: T1)`
  - `visit_observed_on_replica('timeline-visit:https://example.com/x' → 'replica:B', observedAt: T2)`
- **One replica observed many times.** Fixture: replica A observes URL at T1,
  T2, T3. Emit ONE edge with `observedAt: T1` (first-observed-at wins).
- **Three replicas, partially-overlapping URLs.** Replica A: {url1, url2}.
  Replica B: {url1, url3}. Replica C: {url2, url3}. Emit edges:
  - url1 → A (T_A1), B (T_B1)
  - url2 → A (T_A2), C (T_C2)
  - url3 → B (T_B3), C (T_C3)
- **Determinism.** Build twice; output byte-identical.

*Fixtures:*

- `packages/sidetrack-companion/src/materializers/__fixtures__/cross-replica-basic.json`
  — 2 replicas, 3 shared URLs, 2 unshared.

*Acceptance:*

```sh
cd packages/sidetrack-companion
./node_modules/.bin/vitest run src/materializers/cross-replica.test.ts            # green
./node_modules/.bin/tsc --noEmit -p tsconfig.json                                  # silent
```

Cross-replica e2e scenario (1.K-4) passes: simulate a second replica observing the
same canonical URL via the relay; assert `visit_observed_on_replica` is emitted on
both replicas; Flow Path renders a dashed cross-replica edge.

---

**S12 — Engagement classifier ruleset** (1.G).

*Worktree branch:* `codex/stage1-s12-engagement-classifier`.

*Depends on:* S7 (`engagement.session.aggregated` events), S8 (snippets projection
for `source_extracted` and `execution_source`). Can run in parallel with S9 / S10
/ S11 — it touches a different code path.

*Files (NEW unless noted):*
- `packages/sidetrack-companion/src/connections/engagementClassifier.ts` (NEW)
- `packages/sidetrack-companion/src/connections/engagementClassifier.test.ts`
- `packages/sidetrack-companion/src/producers/engagement-class-revision.ts` (NEW)
- `packages/sidetrack-companion/src/sync/contract/connectionsMaterializer.ts` (modify — thread classifier into the pipeline)
- `packages/sidetrack-companion/src/connections/snapshot.ts` (modify — emit
  `engagement.class` on `timeline-visit` node metadata in Pass 3 where timeline
  visits are emitted)
- `packages/sidetrack-companion/src/sync/contract/registry.ts` (modify — register
  `engagement-class-projection` as a Class E projection surface)

*Reuse pointers:*
- `auditRetention.ts` retention pattern.
- `Web Crypto API` for the rule-table hash (already used in recall pipeline).

*Schemas:*

```ts
// 7-class enum
type EngagementClass =
  | 'parked_background'
  | 'glanced'
  | 'skimmed'
  | 'engaged_read'
  | 'worked_on_reference'
  | 'source_extracted'
  | 'execution_source';

// Input shape (synthesized from S7 + S8 outputs by the materializer)
type EngagementClassifierInput = {
  visitId: string;
  canonicalUrl: string;
  engagement: {
    activeMs: number;
    visibleMs: number;
    focusedWindowMs: number;
    idleMs: number;
    foregroundBursts: number;
    returnCount: number;
    scrollEvents: number;
    maxScrollRatio: number;
    copyCount: number;
    pasteCount: number;
  };
  // From the snippets projection (S8). True if any selection.copied from this
  // visit appears as selection.pasted into a thread/dispatch/note/capture.
  hasDownstreamPasteLineage: boolean;
  // From the snippets projection. Distinct destination kinds across pastes.
  distinctPasteDestinationKinds: number;
};

type EngagementClassRevision = {
  revisionId: string;       // sha256('engagement-class:v1:rules' + sortedRuleTableHash).slice(0, 16)
  producerKey: 'engagement-class:v1:rules';
  ruleTableHash: string;    // sha256 of the canonical-form rule table (sorted rules)
  classifications: readonly {
    visitId: string;
    canonicalUrl: string;
    class: EngagementClass;
  }[];
  producedAt: number;
};

// Pure function signature
type ClassifyEngagement = (
  input: EngagementClassifierInput,
) => EngagementClass;
```

*Change shape:*
- Pure deterministic reducer per the 7-class table in § 1.G. Input: per-visit
  engagement aggregates + per-visit snippet-lineage flags.
- Rule application order matters (lower-numbered classes are checked first; first
  match wins). Order is the table order in § 1.G:
  1. `parked_background`
  2. `glanced`
  3. `skimmed`
  4. `engaged_read`
  5. `worked_on_reference`
  6. `source_extracted`
  7. `execution_source`
- However, classes 5/6/7 are STRICTLY MORE SPECIFIC than classes 3/4 (they
  require additional facts), so the implementation runs the most-specific check
  first and falls back. The Codex implementation should:
  - Check `execution_source` first.
  - Fall through to `source_extracted`.
  - Fall through to `worked_on_reference`.
  - Fall through to `engaged_read`.
  - Fall through to `skimmed`.
  - Fall through to `glanced`.
  - Default to `parked_background`.
- Output: a Class E revision keyed `engagement-class:v1:rules`.
  `revisionId = sha256('engagement-class:v1:rules' + ruleTableHash).slice(0, 16)`.
  `ruleTableHash` is the SHA-256 of the rule table serialized in canonical form
  (sorted by class name, with all numeric thresholds). The revision id changes
  ONLY when the rule table changes.
- Visit nodes get `metadata.engagement.class = '...'` from the active revision.
  Side panel "Focus View" tab groups by class.
- Persistence: Class E revision at `_BAC/connections/engagement-class/<revisionId>.json`.
- Future learned classifier ships under `engagement-class:v2:learned` with
  matching `revisionId` discipline; consumers pin which producer's output they
  surface.

*Test scenarios (`engagementClassifier.test.ts`):*

- **Class boundary — `parked_background`.** `focusedWindowMs=1500, activeMs=500`
  → `parked_background`. `focusedWindowMs=2500, activeMs=1500` → NOT
  `parked_background` (falls through).
- **Class boundary — `glanced`.** `activeMs=4500, maxScrollRatio=0.10, copyCount=0`
  → `glanced`. `activeMs=5500` → falls through.
- **Class boundary — `skimmed`.** `activeMs=10000, maxScrollRatio=0.30,
  scrollEvents=5, copyCount=0` → `skimmed`. `copyCount=1` → falls through.
- **Class boundary — `engaged_read`.** `activeMs=35000, maxScrollRatio=0.50,
  returnCount=2` → `engaged_read`. `copyCount=0` → stays at `engaged_read`.
- **Class boundary — `worked_on_reference`.** `engaged_read` profile + `copyCount=2`
  + `returnCount=2` → `worked_on_reference`.
- **Class boundary — `source_extracted`.** `worked_on_reference` profile +
  `hasDownstreamPasteLineage=true` → `source_extracted`.
- **Class boundary — `execution_source`.** `source_extracted` profile + `copyCount=3`
  + `distinctPasteDestinationKinds=2` → `execution_source`.
- **Determinism — same input → same output.** Single fixture, run 100 times,
  every run produces the same class.
- **Revision id stability — unchanged rule table → unchanged revisionId.** Boot
  the classifier twice; assert `revisionId` matches.
- **Revision id changes on rule-table mutation.** Modify a threshold;
  `revisionId` differs.

*Fixtures:*

- `packages/sidetrack-companion/src/connections/__fixtures__/engagement-7-classes.json`
  — One fixture per class plus one boundary-case fixture per class (14 total).

*Acceptance:*

```sh
cd packages/sidetrack-companion
./node_modules/.bin/vitest run src/connections/engagementClassifier.test.ts        # green
./node_modules/.bin/tsc --noEmit -p tsconfig.json                                  # silent
./node_modules/.bin/vitest run src/connections/engagementClassifier.test.ts -t 'determinism'  # 100 iterations green
```

Engagement-classification e2e scenario (1.K-2) passes: 3 pages with distinct
engagement profiles produce the expected `parked_background`, `skimmed`,
`engaged_read` classes.

---

### Wave D — depends on Wave C

**S13 — Deterministic templates** (1.I).

*Worktree branch:* `codex/stage1-s13-deterministic-templates`.

*Depends on:* S10 (topic nodes), S11 (cross-replica edges), S12 (engagement
classes). All three need to land before S13 can integrate; S13 can be authored
against fixtures of those outputs in parallel with Wave C if Codex prefers.

*Files (NEW unless noted):*
- `packages/sidetrack-extension/src/sidepanel/connections/why-related/reasons.ts` (NEW — Reason union per § 1.I)
- `packages/sidetrack-extension/src/sidepanel/connections/why-related/sort.ts` (NEW — fixed reason-code priority)
- `packages/sidetrack-extension/src/sidepanel/connections/why-related/render.ts` (NEW — pure switch over `Reason.code`)
- `packages/sidetrack-extension/src/sidepanel/connections/why-related/render.test.ts`
- `packages/sidetrack-extension/src/sidepanel/connections/topicLabel.ts` (NEW — pure function)
- `packages/sidetrack-extension/src/sidepanel/connections/topicLabel.test.ts`
- `packages/sidetrack-extension/src/sidepanel/connections/contextPack.ts` (NEW — pure Markdown reducer)
- `packages/sidetrack-extension/src/sidepanel/connections/contextPack.test.ts`

*Reuse pointers:*
- Existing `ConnectionsSnapshot`, `ConnectionEdge`, `ConnectionNode` types from
  `packages/sidetrack-companion/src/connections/types.ts` (re-imported by the
  extension via the existing `connectionsClient`).
- The new `EngagementClass` enum from S12.
- The new `TopicNodeMetadata` shape from S10.
- The existing markdown utilities under `packages/sidetrack-extension/src/util/`
  if any (Codex should grep — do not introduce a new markdown lib).

*Schemas:*

```ts
// reasons.ts — full union per § 1.I (12 variants total).
export type Reason =
  | { code: 'SAME_THREAD'; threadId: string; threadName: string }
  | { code: 'SAME_TOPIC'; topicId: string; cohesion: number }
  | { code: 'COSINE_ABOVE_THRESHOLD'; cosine: number; threshold: number }
  | { code: 'OPENER_CHAIN'; depth: number; viaTabSessionIdHash: string }
  | { code: 'PREVIOUS_VISIT_IN_TAB_SESSION'; tabSessionIdHash: string }
  | { code: 'TRANSITION_TYPE'; transitionType: string }
  | { code: 'TRANSITION_QUALIFIER'; qualifier: string }
  | { code: 'COPIED_FROM'; snippetId: string }
  | { code: 'PASTED_INTO'; snippetId: string; destinationKind: string }
  | { code: 'OBSERVED_ON_OTHER_REPLICA'; replicaId: string }
  | { code: 'LEXICAL_OVERLAP'; topTokens: readonly string[] }
  | { code: 'LINK_OUT_FROM' | 'LINK_IN_TO'; otherVisitId: string };

// sort.ts — priority order (low number = render first).
export const REASON_PRIORITY: Record<Reason['code'], number> = {
  SAME_THREAD: 1,
  COPIED_FROM: 2, PASTED_INTO: 2,
  OPENER_CHAIN: 3, PREVIOUS_VISIT_IN_TAB_SESSION: 3,
  TRANSITION_TYPE: 4, TRANSITION_QUALIFIER: 4,
  OBSERVED_ON_OTHER_REPLICA: 5,
  SAME_TOPIC: 6,
  COSINE_ABOVE_THRESHOLD: 7,
  LINK_OUT_FROM: 8, LINK_IN_TO: 8,
  LEXICAL_OVERLAP: 9,
};

// render.ts
export const renderReason = (r: Reason): string => {
  switch (r.code) {
    case 'SAME_THREAD': return `Same thread: ${r.threadName}`;
    case 'SAME_TOPIC': return `Same topic (cohesion ${r.cohesion.toFixed(2)})`;
    case 'COSINE_ABOVE_THRESHOLD': return `Title similarity ${r.cosine.toFixed(2)} ≥ ${r.threshold.toFixed(2)}`;
    case 'OPENER_CHAIN': return `Opened from another visit (${r.depth} hop${r.depth === 1 ? '' : 's'})`;
    case 'PREVIOUS_VISIT_IN_TAB_SESSION': return `Previous visit in the same tab session`;
    case 'TRANSITION_TYPE': return `Navigation transition: ${r.transitionType}`;
    case 'TRANSITION_QUALIFIER': return `Navigation qualifier: ${r.qualifier}`;
    case 'COPIED_FROM': return `Snippet copied from this page`;
    case 'PASTED_INTO': return `Pasted into ${r.destinationKind}`;
    case 'OBSERVED_ON_OTHER_REPLICA': return `Also observed on replica ${r.replicaId}`;
    case 'LEXICAL_OVERLAP': return `Shared terms: ${r.topTokens.slice(0, 3).join(', ')}`;
    case 'LINK_OUT_FROM': return `This page links to that one`;
    case 'LINK_IN_TO': return `That page links to this one`;
  }
};

// topicLabel.ts
export const topicLabel = (t: { members: readonly { canonicalUrl: string; title: string; focusedWindowMs: number }[]; cohesion: number }): { label: string; tooltip: string } => {
  const top = t.members.slice().sort(
    (a, b) => b.focusedWindowMs - a.focusedWindowMs || a.canonicalUrl.localeCompare(b.canonicalUrl)
  )[0];
  return {
    label: top?.title || top?.canonicalUrl || '(untitled topic)',
    tooltip: `cohesion=${t.cohesion.toFixed(2)} · members=${t.members.length}`,
  };
};
```

*Change shape:*
- `Reason` union type per the schema above. 13 codes total. Two of those codes
  (`LINK_OUT_FROM`, `LINK_IN_TO`) share a discriminant — Codex should expand into
  separate const arms for clarity.
- Renderer: pure switch over `code` emitting parallel-structured bullets. The
  string output is locale-independent (English; future locale work uses an i18n
  layer that's NOT in Stage 1 scope).
- Sort: `Reason[]` → sorted by `REASON_PRIORITY[r.code]` ascending; ties broken
  by stringified payload lexically.
- Topic label = top member by `focusedWindowMs` (ties broken by canonical URL
  ascending). Tooltip carries cohesion + memberCount.
- Context Pack = pure Markdown reducer over `(topic, threads, dispatches,
  snippets, userNotes)`. Sections per § 1.I; "Open Questions" extracted from
  user-authored notes only (regex `/.*\?\s*$/u`, length 8..200 chars). Section
  omitted when no extractable question exists.
- All functions are PURE (no I/O; no `Date.now()` — caller passes a clock).
  Byte-deterministic outputs on the same inputs.

*Test scenarios:*

`reasons.test.ts` — type-only test that the union exhaustively covers every
producer-emitted reason; relies on `never` exhaustiveness check.

`sort.test.ts`:
- **Priority order.** Mixed `Reason[]` with one of each kind; assert sorted
  output matches the priority table above.
- **Tie-break stability.** Two `COSINE_ABOVE_THRESHOLD` reasons with different
  payloads → sorted by stringified payload lexically.

`render.test.ts`:
- **Every code renders.** One fixture per code (13 total); assert exact string
  output. This is the byte-determinism guard.
- **Locale-stable.** Two runs of the same fixture; `JSON.stringify` of the
  rendered output is identical.

`topicLabel.test.ts`:
- **Top-by-focusedWindowMs.** 3 members with focusedWindowMs 5000 / 10000 / 7500
  → label = title of the 10000 member.
- **Tie-break by canonical URL ascending.** Two members with focusedWindowMs
  10000 → label = title of the lexically-lower canonical URL.
- **Empty title fallback.** Top member's title is empty string → label = its
  canonicalUrl.
- **Empty topic fallback.** No members → label = `'(untitled topic)'`.

`contextPack.test.ts`:
- **All sections rendered.** Fixture with topic + threads + dispatches +
  snippets + 2 user-authored open questions → Markdown contains all 5 sections.
- **Empty-section omission.** Fixture with no dispatches → "Dispatches" section
  is absent from output.
- **Open Questions extraction.** User note containing 5 lines, 2 ending in `?`
  → both extracted. Note containing only declarative text → "Open Questions"
  section absent.
- **Snippet hash-only.** Snippet with `rawTextStored: false` renders as
  `"(hashed)"`; snippet with `rawTextStored: true` renders the first 80 chars.
- **Determinism.** Same input twice → byte-identical Markdown.

*Fixtures:*

- `packages/sidetrack-extension/src/sidepanel/connections/__fixtures__/reasons-all.json`
  — One fixture per `Reason.code` (13 total).
- `packages/sidetrack-extension/src/sidepanel/connections/__fixtures__/topic-label-cases.json`
  — Top-by-focus, tie-break, empty fallbacks.
- `packages/sidetrack-extension/src/sidepanel/connections/__fixtures__/context-pack-full.json`
  — Full-content fixture for the Context Pack reducer.
- `packages/sidetrack-extension/src/sidepanel/connections/__fixtures__/context-pack-omit-sections.json`
  — Fixture with intentionally empty sections.

*Acceptance:*

```sh
cd packages/sidetrack-extension
./node_modules/.bin/vitest run src/sidepanel/connections/why-related/ \
  src/sidepanel/connections/topicLabel.test.ts \
  src/sidepanel/connections/contextPack.test.ts                                    # all green
./node_modules/.bin/tsc --noEmit -p tsconfig.json                                  # silent
```

Determinism-of-explanations e2e scenario (1.K-7) passes: same fixture, two runs,
byte-identical reason-code output. No outbound network calls (asserted by
test-suite-wide network mock).

---

**S14 — UI surfaces** (1.J).

*Worktree branch:* `codex/stage1-s14-ui-surfaces`.

*Depends on:* S13 (templates), S1 (confidence enum + dashed CSS), S10 (topic
nodes), S11 (cross-replica edges), S12 (engagement classes). Most depended-on
subtask in the plan; runs near-last.

*Files (NEW unless noted):*
- `packages/sidetrack-extension/src/sidepanel/connections/FlowPathView.tsx` (NEW)
- `packages/sidetrack-extension/src/sidepanel/connections/FlowPathView.test.tsx` (NEW)
- `packages/sidetrack-extension/src/sidepanel/connections/FocusView.tsx` (NEW)
- `packages/sidetrack-extension/src/sidepanel/connections/FocusView.test.tsx` (NEW)
- `packages/sidetrack-extension/src/sidepanel/connections/WhyRelatedPanel.tsx` (NEW)
- `packages/sidetrack-extension/src/sidepanel/connections/WhyRelatedPanel.test.tsx` (NEW)
- `packages/sidetrack-extension/src/sidepanel/connections/ContextPackComposer.tsx` (NEW)
- `packages/sidetrack-extension/src/sidepanel/connections/ContextPackComposer.test.tsx` (NEW)
- `packages/sidetrack-extension/src/sidepanel/connections/ConnectionsView.tsx` (modify — tab routing)
- `packages/sidetrack-extension/src/sidepanel/connections/connectionsClient.ts` (modify — read endpoints for label / why-related / context-pack via the existing chrome.runtime message-proxy pattern)
- `packages/sidetrack-extension/entrypoints/sidepanel/style.css` (modify — Flow Path linear-timeline layout, Focus View card grid, topic + snippet tints)
- `packages/sidetrack-extension/tests/unit/connections/network-mock.test.ts` (NEW — assert no LLM-shaped fetch calls)

*Reuse pointers:*
- `ConnectionsView.tsx` existing structure — keep as the entry point, add tabs
  for the four new sub-views.
- `connectionsClient.ts` existing message-proxy pattern (chrome.runtime
  sendMessage / response handling) — extend to add 3 new endpoints, do not
  introduce direct `fetch()` calls from the side panel.
- Existing `paper-warm` 8-tint palette in `style.css` for node-kind tints — S10
  already added the 8th tint for `topic`; this brief adds the 9th for `snippet`.
- Existing tab-switching pattern in the side panel (workstream / Connections
  tabs) — mirror that pattern for the 4 sub-tabs inside Connections.

*Component contracts:*

```tsx
// FlowPathView.tsx
type FlowPathViewProps = {
  visits: readonly TimelineVisit[];
  navigationEdges: readonly NavigationEdge[];   // previousVisitId / openerVisitId edges
  crossReplicaEdges: readonly CrossReplicaEdge[];
  onNodeClick: (visitId: string) => void;       // opens WhyRelatedPanel
};

// FocusView.tsx
type FocusViewProps = {
  topics: readonly TopicNode[];
  visitsByTopic: Record<string, readonly TimelineVisit[]>;
  engagementClassesByVisit: Record<string, EngagementClass>;
  onTopicClick: (topicId: string) => void;
  onVisitClick: (visitId: string) => void;
};

// WhyRelatedPanel.tsx
type WhyRelatedPanelProps = {
  fromVisitId: string;
  toVisitId?: string;            // when comparing pair
  toTopicId?: string;            // when comparing visit-to-topic
  reasons: readonly Reason[];    // pre-sorted by S13's sort.ts
  showOnlyUserAsserted: boolean;
  onToggleAssertedOnly: () => void;
  onClose: () => void;
};

// ContextPackComposer.tsx
type ContextPackComposerProps = {
  workstreamId: string;
  // The composer fetches the topic + threads + dispatches + snippets via
  // connectionsClient and runs the S13 contextPack reducer locally.
  onClose: () => void;
};
```

*Change shape:*
- Flow Path tab: directed temporal view. Layout: linear, left-to-right by
  `commitTimestamp`, grouped vertically by `tabSessionIdHash`. Edges drawn from
  `previousVisitId` (solid) and `openerVisitId` (solid). Cross-replica
  continuations from `visit_observed_on_replica` render dashed (S1's
  `.confidence-inferred` class — but wait: cross-replica edges have
  `confidence: 'observed'`, NOT `'inferred'`. They render dashed by a separate
  CSS class `.cx-edge-cross-replica` to distinguish from inference dashing).
  Hover reveals engagement class via tooltip. Click opens WhyRelatedPanel.
- Focus View tab: topic-centric. Topic cards in a responsive grid; each card
  shows representative title, member count, cohesion bar, dominant workstream
  chip if present, and an expand button revealing member visits ordered by
  `focusedWindowMs`. Visits inside a card show their engagement class as a
  colored dot.
- Why Related panel: side-drawer that opens on edge or visit-pair click. Renders
  the Reason list from S13. Toggle "Show only user-asserted" filters out reasons
  with `confidence: 'inferred'`.
- Context Pack composer: per-workstream button labeled "Compose Context Pack".
  On click, gathers the workstream's topic / threads / dispatches / snippets via
  `connectionsClient`, runs the S13 contextPack reducer, displays the resulting
  Markdown in a modal with a "Copy to clipboard" button. Never opens a network
  connection.
- Network-mock: a Playwright `context.route()` rule in the e2e fails any outbound
  request matching `*ollama*`, `*openai*`, `*anthropic*`, `*claude*.ai`,
  `*completions*`, `api.openai.com`, `api.anthropic.com` patterns. The unit
  suite mirrors via a global `vi.spyOn(globalThis, 'fetch')` that throws on
  matching URLs.

*Test scenarios:*

`FlowPathView.test.tsx`:
- **Renders all visits.** Fixture with 6 visits across 2 tab sessions; assert
  6 visit nodes + 4 navigation edges (3 within each tab session) render.
- **Cross-replica edges dashed.** Fixture with one cross-replica edge; assert
  the edge has `.cx-edge-cross-replica` class.
- **Click handler.** Click a visit; assert `onNodeClick` fires with the visit id.

`FocusView.test.tsx`:
- **Topics grouped.** Fixture with 2 topics + 4 visits; assert 2 cards rendered.
- **Engagement class dots.** Each visit shows the right colored dot for its class.
- **Workstream-asserted weighting.** Topic with a `topic_in_workstream` edge
  renders with a "Workstream" chip on the card.

`WhyRelatedPanel.test.tsx`:
- **All Reason kinds render.** Fixture with one of each Reason → all 13 bullets
  visible.
- **Toggle filters inferred.** Mixed Reason list; toggle on → only
  user-asserted-priority reasons remain.

`ContextPackComposer.test.tsx`:
- **Composes Markdown.** Stubbed connectionsClient returns a fixture; assert
  Markdown matches the S13 reducer output.
- **Copy-to-clipboard.** Mock `navigator.clipboard.writeText`; click "Copy";
  assert the mock was called with the Markdown.
- **No network calls.** With the network-mock active, render the composer +
  copy → no fetch firings on LLM-shaped URLs.

`network-mock.test.ts`:
- **Suite-wide.** Render any combination of the four surfaces; assert
  `globalThis.fetch` is never called with an LLM-shaped URL.

*Acceptance:*

```sh
cd packages/sidetrack-extension
./node_modules/.bin/vitest run src/sidepanel/connections/                          # all green
./node_modules/.bin/vitest run tests/unit/connections/network-mock.test.ts         # green
./node_modules/.bin/tsc --noEmit -p tsconfig.json                                  # silent
./node_modules/.bin/wxt build                                                      # bundle clean
```

All four surfaces visible in the e2e (1.K). Lighthouse axe-core run on each
surface returns 0 critical accessibility issues (manual verification step;
documented in S15's e2e checklist).

---

### Wave E — sequential, lead-authored

**S15 — Browser e2e (`connections-mvp-user-story.spec.ts`)** (1.K).

*Branch:* lands directly on `feat/work-graph-mvp` (or successor implementation
branch) authored by lead.

*Depends on:* all of S1–S14.

*Files (NEW):*
- `packages/sidetrack-extension/tests/e2e/connections-mvp-user-story.spec.ts`
- `packages/sidetrack-extension/tests/e2e/helpers/network-mock.ts` (NEW — shared LLM-network-block helper)

*Scope:* the seven scenarios in § 1.K, plus the cross-replica privacy revoke
sub-scenario (1.K-A). Network-mock asserts no outbound LLM-shaped requests
across all scenarios.

*Acceptance:*
- The full e2e passes against the deterministic test embedder.
- Existing connections e2e suite (`connections-multiflow.spec.ts`,
  `connections-real-tabs.spec.ts`, `connections-user-path.spec.ts`,
  `connections-cross-replica-browser.spec.ts`) continues to pass (regression).

---

**S16 — Documentation**.

*Branch:* same as S15.

*Files:*
- `docs/timeline.md` (modify) — engagement (counts + durations only) +
  provenance dimensions; explicit "no event.key, no event.target reads" privacy
  claim; copy/paste hash-only posture.
- `docs/architecture.md` (NEW) — the two-tier edge model; Class A–F roles in the
  work graph; the IndexedDB decision; the privacy projection; roadmap stages.
- `docs/proposals/work-graph-stage1-mvp.md` — mark as "implemented" with a link
  back to the implementation PR(s).

*Acceptance:*
- Docs reviewed; links resolve; no stale fixtures referenced.

### Codex hand-off protocol

1. Lead writes a subtask brief (above format) and pastes it into a chat with the user.
2. User spins Codex on that brief.
3. Codex delivers code; user signals lead "S6 done" (or similar).
4. Lead reviews the diff, integrates, runs tests, and either marks the subtask
   complete or returns it to user with corrections.
5. Subtasks in the same wave run in parallel; subtasks across waves serialize on
   the dependency graph above.

The lead never holds the implementation queue alone — every subtask brief is small
enough that Codex can execute it in one batch, and the lead's role is brief
authorship + integration review, not direct coding.

## The most important design principle

> **Facts are event-sourced. Interpretations are versioned. Suggestions are
> explainable. User organization is authoritative. No inference requires GPU /
> Apple-Silicon hardware.**

Every Stage 2-3 PR must preserve this. Every line of code in this PR (locks 1-4 +
Stage 1.A-K) is what makes it preservable.

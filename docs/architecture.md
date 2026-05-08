# Sidetrack architecture (Stage 1)

This document is the canonical Stage 1 architecture reference. Detailed
sub-task plans live in [`docs/proposals/work-graph-stage1-mvp.md`](proposals/work-graph-stage1-mvp.md).
This file is the load-bearing summary that survives even when the
proposal becomes historical.

## Northern star

Sidetrack is a **temporal behavioral work graph** for the modern browser
worker. It observes — with explicit user consent — what the user reads,
what they navigate from and to, what they engage with vs. abandon, and
what they copy/paste between contexts. From those facts it builds an
event-sourced graph that the user can replay, query, label, and
re-organize.

Two non-negotiable properties define the product:

1. **Authoritative user organization.** The user's manual labels,
   threads, dispatches, snippets, and notes always outrank inferred
   structure.
2. **Hardware-neutral inference.** Sidetrack runs in any Manifest V3
   browser on any consumer machine without assuming a discrete GPU,
   Apple Silicon, or an AMD APU with usable shared memory. **Stage 1
   ships zero LLM inference code.** The only neural component on the
   critical path is the existing WASM-backed `multilingual-e5-small`
   embedder, which runs on CPU in any modern browser / Node.

## Architectural locks (invariants)

Four locks hold the architecture together. New work must respect them.

### Lock 1 — Confidence enum

Every node and edge carries
`confidence ∈ {'asserted', 'observed', 'inferred'}`:

- `'asserted'` = user said so.
- `'observed'` = directly captured event.
- `'inferred'` = derived by a producer.

Inferred edges render with a dashed CSS stroke (`stroke-dasharray: 4 2`).
Enforced in the renderer, not by content.

**Compatibility with old snapshots.** Pre-Stage-1 snapshots carry the
legacy `'explicit' | 'deterministic'` enum. A reader-side normalizer
maps `explicit → asserted` and `deterministic → observed`. Migration
is read-time, not by mutating files.

### Lock 2 — `payloadVersion` + `dimensions` extension slot

Every Class F event and every replayable Class B/D/E artifact has:

- `payloadVersion: number` (monotone).
- `dimensions: Record<string, unknown>` (open extension).

New behavior fields are added through `dimensions`, never via positional
schema mutation. Reducers read `payload.dimensions?.<key> ?? undefined`
defensively — unknown keys are ignored, never cause failures.

**Dimensions safety:** the slot is bounded at three layers:

1. **Hard size cap.** `JSON.stringify(dimensions)` ≤ 4 KB at the
   producer. The runtime predicate rejects oversize payloads.
2. **Allowed-dimension manifest per event family.** Each `ContractEntry`
   declares an `allowedDimensions: readonly string[]` whitelist.
   Unknown keys are stripped at ingest (HTTP route + `importPeerEvent`
   + relay subscriber path all share one `sanitizeDimensions` helper).
3. **Redaction at ingest.** String values are checked against email /
   long-token / card-like regex. Matches are replaced with
   `'[redacted]'` and recorded in `dimensions._redacted: ['<key>', ...]`.

Per-family preserve / drop policy: timeline + engagement + selection
events preserve dimensions; all canonical-fact event types
(workstream / thread / dispatch / annotation / queue / capture /
privacy) drop dimensions on ingest.

### Lock 3 — `producedBy` provenance

Every derived edge records:

```ts
producedBy:
  | { source: 'event-log'; eventType: string; dot: { replicaId, seq } }
  | { source: 'vault'; key: string }
  | { source: 'timeline-projection' }
  | { source: 'visit-similarity'; revisionId: string }
  | { source: 'topic-clusterer'; revisionId: string }
  | { source: 'engagement-classifier'; revisionId: string }
  | { source: 'snippet-lineage'; revisionId: string }
  | { source: 'cross-replica' }
  // future: { source: 'ranker' | 'small-llm'; revisionId: string }
```

`revisionId` is a Class E pointer — opaque to consumers, traceable to a
frozen model + feature schema. Two replicas with different model
versions emit edges with different `revisionId`s for the same input;
the UI can filter by source / version.

### Lock 4 — Privacy gates as Class A facts

Privacy state changes are facts on the timeline, not flags in a
settings store:

```
privacy.gate.flipped       { gate, state, actor, reason? }
privacy.permission.granted { permission, scope }
privacy.permission.revoked { permission, scope, retroactiveMask }
```

Replicas materialize from the event stream so revoking on Replica α
propagates to β through Sync Contract Class A delivery, including
retroactive masking of any derived artifact whose `inputs[]` reference
a now-forbidden source.

**Conflict resolution under offline divergence:** LWW by
`(observedAt, replicaId)`. Two replicas replaying the same merged log
converge on the same final state. No coordination service required.

**What gates block:** edge observation (extension side, fast-path
cache hydrated from the projection) AND companion materialization
(per-window mask in derived caches). Observation block prevents new
data within the current replica; materialization block hides existing
data within a window across all replicas.

**Retroactive masking is derived-view masking, not destructive event
deletion.** Old events stay in the log; the reducer excludes events
whose `observedAt` falls in a `closed` window from derived caches. If
the user later flips back to `open`, those events become visible
again. Hard deletion would be a separate `privacy.event.tombstoned`
event type (out of scope for Stage 1).

## Class A–F roles in the work graph

| Class | Role | Stage 1 examples |
|---|---|---|
| **A** Aggregate projection | Explicit user / system facts. Definitive, replicated. | thread / workstream / dispatch / annotation / queue / capture / **privacy events** (NEW) |
| **B** Derived cache | Deterministic reductions. Replicas agree; rebuilds from the event log. | recall index, timeline projection, connections snapshot, **privacy projection** (NEW), **storage health** (NEW) |
| **C** Local-only | Per-replica audit trails. | capture audit JSONL |
| **D** Identity / auth | Slot exists; no concrete entries yet. | (deferred) |
| **E** Extraction revision | Versioned semantic outputs with active-revision policy. | extraction revisions, **visit-similarity revision**, **topic revision**, **engagement-class revision**, **snippet-lineage revision** (all NEW in Stage 1) |
| **F** Plugin-tier bounded | Observations from the extension. | `browser.timeline.observed`, **`navigation.committed`**, **`engagement.interval.observed`**, **`engagement.session.aggregated`**, **`selection.copied`**, **`selection.pasted`** (all NEW in Stage 1) |

The two-tier edge model maps directly:

- **Evidence edges** live in Class B. Deterministic functions of the
  merged event log. Two replicas agree.
- **Inference edges** live in Class E (ranker / embedding / clustering
  / LLM outputs). Each replica computes from its local model and
  feature revision. Edges carry `producedBy: { source, revisionId }`
  provenance.

Cross-replica posture: **facts ferry, opinions don't.**

## Storage substrate

Stage 1 (C6) introduces an **IndexedDB-backed Class F event buffer**
for high-volume append-only streams. The decision rationale:

- `chrome.storage.local` is ~10 MB capped (5 MB pre-Chrome 114),
  JSON-stringifies the entire value of any changed key on every write.
  Behavioral event streams that include per-interval engagement records
  on dozens of tabs can exceed comfortable quota in a session-week.
- IndexedDB is available to MV3 service workers, has no fixed cap
  (origin quota), supports range queries on indexed keys, and has
  documented batched-cursor patterns that outperform per-item access.
- Manifest declares `unlimitedStorage` so both substrates are exempt
  from eviction.

**Streams and retention:**

| Stream | Window | Reason |
|---|---|---|
| `navigation.committed` | 90 days | Causal spine; Stage-2 ranker needs history |
| `engagement.interval.observed` | 30 days | High volume; aggregates persist longer |
| `engagement.session.aggregated` | indefinite | Already aggregated; ~KB/session |
| `selection.copied` / `selection.pasted` | 90 days | Low volume; load-bearing for lineage |
| `privacy.gate.flipped` / `permission.*` | indefinite | Privacy timeline must be replayable |
| `storage.*` (health / quota events) | 30 days | Operational noise |

**Backpressure & quota failure:** `navigator.storage.estimate()` polled
every flush cycle. At ≥ 80 % a `storage.quota.warning` event emits; at
≥ 95 % the buffer switches to per-stream drop-oldest mode and emits
`storage.quota.exceeded`. `QuotaExceededError` is caught with one
retry after evicting the oldest 10 % of records.

**MV3 lifecycle discipline:** all listeners (`webNavigation.onCommitted`,
`tabs.onCreated`, `idle.onStateChanged`, `runtime.onMessage`) register
synchronously at the top of the service worker. No state lives in
module globals between worker restarts; everything that must survive
is in IndexedDB or `chrome.storage.local`. `chrome.alarms` (minimum
1-minute period) drives periodic flush of in-memory event batches.

**Schema versioning:** object-store keys carry a version prefix
(`<streamName>:v<n>:<lamport>:<replicaId>`). A `_schema` store records
per-stream version. SW boot runs forward-only migrations on version
drift; idempotent on re-run.

## Model registry (Stage 2/3 — Class E revision policy)

Stage 2/3 introduces multiple ML-derived artifacts on top of the deterministic
Stage 1 surfaces. They all share one revision policy via Class E.

### Revision artifact kinds

| Producer | Class E key | Inputs | Output edges/nodes |
|---|---|---|---|
| Visit similarity | `visit-resembles:v1:cosine` | merged event log + recall index V3 + `multilingual-e5-small` | `visit_resembles_visit` (Pass 7) |
| Topic clusterer (Union-Find) | `topic-revision:v1:union-find` | similarity edges + user-asserted edges | `topic` nodes + `visit_in_topic` + `topic_in_workstream` (Pass 8) |
| Topic clusterer (HDBSCAN) | `topic-revision:v2:hdbscan` | same | same — alternative clusterer; user pins which revision the UI surfaces |
| Engagement classifier (rules) | `engagement-class:v1:rules` | engagement aggregates + snippet lineage | `engagement.class` metadata on visit nodes (Pass 3) |
| Cross-replica continuation (LightGBM) | `continuation-classifier:v1:lightgbm` | `visit_observed_on_replica` + Stage 2 features | `visit_continues_visit` (Pass 11) |
| Closest-visit ranker (LightGBM/LambdaMART) | `closest-visit:v1:lightgbm-lambdamart` | candidate-gen + feature-extraction + feedback-projection | `closest_visit` (Pass 12) with per-feature contributions |

Future revisions add a new key (e.g., `closest-visit:v2:learned-from-feedback`)
without touching prior revisions. Old revisions stay queryable for audit.

### Revision id (deterministic)

```
revisionId = sha256(
  producer-key + ':' +
  feature-schema-version + ':' +
  model-fingerprint + ':' +
  input-state-hash
).slice(0, 16)
```

Two replicas with the same merged event log + same model produce the same
revisionId. Different replicas with different model versions produce
different revisionIds — the `producedBy: { source, revisionId }` provenance
on every edge makes both observable.

### Active revision selection

The companion exposes one **active** revision per producer-key namespace.
The default-active is the latest `revisionId` written for that key; the user
can pin a specific revision via the side-panel Producer Pin UI (S27).
Pinning is local to the user-replica (stored in `chrome.storage.local`).

### Retention

Old revision artifacts live under
`_BAC/connections/<producer>/<revisionId>.json`. The existing
`auditRetention.ts` policy applies: keep the active revision + the
most-recent N inactive revisions per producer-key (default N=5). Older
revisions GC-collected on a daily alarm.

### Retraining loop (Stage 3 — S25)

Feedback projection (S24) aggregates `user.organized.item`,
`user.engagement.relabeled`, `user.flow.{confirmed,rejected}`,
`user.topic.renamed`, `user.snippet.promoted` into a training-label dataset.

S25's retrain loop watches the projection's `trainingDatasetHash` and
triggers a re-train when the hash delta exceeds a threshold (default: 50
new labels). A new `closest-visit:v1:lightgbm-lambdamart` revision is
produced; the companion-side `LoadedClosestVisitRanker` lifecycle reloads
the model on the next snapshot drain.

The user sees: "Ranker v3 (learned from 142 corrections)" in the side panel;
clicking the pin freezes the surfaced ranker to the user's preferred
revision while letting the system continue accumulating new revisions for
audit.

### Debug-pack export (Stage 2 — S22)

MCP tool `sidetrack.debug.explainRanking({ from, to })` returns:

```ts
{
  features: CandidatePairFeatures;           // computed live for the pair
  modelVersion: string;
  revisionId: string;
  score: number;
  contributions: ReadonlyArray<{ feature: string; weight: number }>;
  sortedReasonCodes: ReadonlyArray<{ code: string; payload: object }>;
}
```

Every score reproducible from `(event log + revisionId)`. This is what
makes the ranker auditable.

### Hardware-neutrality preserved through Stage 2/3

Every Stage 2/3 producer runs on CPU:

- LightGBM via `wlearn-lightgbm` Node binding (pre-built binaries; no
  compiler toolchain needed on the user's machine).
- HDBSCAN via in-house pure-TS implementation.
- ANN index via `usearch` (pre-built binaries).
- Embeddings via the existing WASM-backed `multilingual-e5-small`.

No GPU dependency; no Apple Silicon assumption; no external API calls.
Stage 1's "no inference requires GPU / Apple-Silicon hardware" guarantee
extends through Stage 2/3 unchanged.

## Reused production components (load-bearing)

Stage 1 must not duplicate or wrap these:

1. **The recall embedder** — `multilingual-e5-small` via
   `@huggingface/transformers` (`Xenova/multilingual-e5-small`, pinned
   HF revision, 384 dims, `query:` / `passage:` prefix discipline,
   deterministic test embedder). Used by Stage 1 only for visit
   similarity (1.C). Do not introduce `bge`, `Nomic`, or
   `EmbeddingGemma`.
2. **The binary recall index V3** at `_BAC/recall/index.bin`. With
   `modelId`, pinned model revision, chunk schema version, schema
   capabilities, per-entry metadata, replica id, Lamport, tombstones,
   deterministic canonical ordering, source-scoped replacement. Stage 1
   inserts visit embeddings through this path. Do not introduce
   `sqlite-vec`, `hnswlib`, USearch, or Faiss.
3. **MiniSearch + cosine + RRF hybrid retrieval.** With title /
   heading / text field weights and dotted-identifier tokenization.
   Stage 1 keeps the existing fixed `lexical*0.3 + vector*0.5 +
   link*0.2` convex combination at threshold 0.55. **Do not introduce
   a learned ranker (LightGBM / XGBoost / LambdaMART) in Stage 1.**
4. **The deterministic test embedder pattern.** Mirrored by the
   IndexedDB layer (1.F) so tests don't require a real IndexedDB.
   Mirrored by the Why Related ranker (1.I) so the reason-code output
   is byte-deterministic in tests.
5. **Sync Contract v1.** Class A–F, plugin-only / companion / relay
   modes, replayable materializers. All new event types in 1.A, 1.B,
   1.F, 1.H slot into the existing Class F edge; all Class B/D/E
   producers run in companion or in plugin-only fallback. No new
   transport.

## Roadmap (deferred to separate PRs)

| Stage | Capability | Trigger to start |
|---|---|---|
| 2 | Learned ranker for `closest_visit` (LightGBM / XGBoost LambdaMART) over the existing scoring features plus behavior features | ≥ N weeks of single-user behavior + user-labeled positive/negative pairs |
| 3 | Supervised feedback loop on user accepts/rejects; producer-versioned Class E revisions | Stage 2 in production with telemetry |
| Future | Optional cloud-LLM enhancement (user supplies own API key) for label / Why Related / Context Pack prose | Class E revision pattern from Stage 1 makes this purely additive |
| Future | Cross-replica continuation classifier (the inference edge atop `visit_observed_on_replica`) | Ground-truth dataset + Stage 2 ranker |
| Future | ANN indexes (USearch / hnswlib / Faiss) | Cosine retrieval over flat float32 stops being interactive |
| Future | HDBSCAN / centroid-stable clustering | Topic id churn from Union-Find becomes a measured user complaint |
| Future | Visual fingerprinting / DOM / screenshot pHash | Need for visual revisitation that text embeddings do not solve |

## The most important design principle

> **Facts are event-sourced. Interpretations are versioned. Suggestions
> are explainable. User organization is authoritative. No inference
> requires GPU / Apple-Silicon hardware.**

Every Stage 2-3 PR must preserve this. Every line of code in the Stage
1 implementation is what makes it preservable.

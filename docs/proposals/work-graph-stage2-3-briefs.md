# Stage 2/3 sub-task briefs

Dispatch-ready briefs for Codex. Each brief is self-contained: file
paths, schemas, change shapes, tests, fixtures, acceptance commands.
Codex pulls a brief from here, executes, marks the box `[x]` in
[PR #105's body](https://github.com/zyingfei/switchboard/pull/105),
and pushes to a branch named `codex/stage2-3-s<n>-<slug>`.

Lead resolves merge conflicts at integration time. Lead's review of a
Codex commit lands fixes as **new** commits (no amend).

Reuse pointers (load-bearing — do NOT duplicate):

- `embed()` from `packages/sidetrack-companion/src/recall/embedder.ts`
  — `Xenova/multilingual-e5-small`, deterministic test embedder via
  `SIDETRACK_TEST_EMBEDDER=1`.
- Binary recall index V3 at `_BAC/recall/index.bin`.
- MiniSearch + cosine + RRF hybrid retrieval.
- IndexedDB Class F event buffer (Stage 1 S5).
- Privacy projection (Stage 1 S4).
- All Stage 1 producers (visit-similarity, topic-clusterer,
  engagement-classifier, snippet-lineage, cross-replica) as inputs.

## Wave A — foundational (parallel)

### S17 — Candidate-generation framework

*Worktree:* `codex/stage2-3-s17-candidate-gen`. *Independent.*

*Files (NEW unless noted):*
- `packages/sidetrack-companion/src/ranker/candidates.ts` (NEW)
- `packages/sidetrack-companion/src/ranker/candidates.test.ts`
- `packages/sidetrack-companion/src/ranker/types.ts` (NEW — shared ranker types)

*Schema:*
```ts
export type CandidateSource =
  | 'same_workstream'
  | 'opener_chain'
  | 'navigation_chain'
  | 'same_canonical_url'
  | 'same_repo_or_domain'
  | 'same_search_query'
  | 'same_copied_snippet'
  | 'same_title_path_tokens'
  | 'embedding_neighborhood'
  | 'cross_replica_continuation'
  | 'random_unrelated'        // negative-candidate generator (S19) uses this
  | 'recently_skipped';       // S19

export type Candidate = {
  fromVisitId: string;
  toVisitId: string;
  sources: readonly CandidateSource[];   // why this candidate was generated
  generatedAt: number;
};

export type GenerateCandidates = (
  fromVisitId: string,
  context: { merged: AcceptedEvent[]; existingEdges: ConnectionEdge[] },
) => readonly Candidate[];
```

*Change shape:*
- One generator function per `CandidateSource`. Each returns a
  `readonly Candidate[]`.
- A top-level `generateCandidates(fromVisitId, context)` runs all
  generators + dedupes by `(fromVisitId, toVisitId)` keeping the union
  of `sources`.
- Generators are PURE — no I/O, no `Date.now()`. Deterministic given
  the same merged event log.

*Tests:*
- One fixture per source covering the positive case + an empty-input
  check.
- Dedup test: two sources both nominate the same pair → output has
  one Candidate with both sources.
- Determinism test: shuffle merged log; output stable.

*Acceptance:*
```sh
cd packages/sidetrack-companion
./node_modules/.bin/vitest run src/ranker/candidates.test.ts        # green
./node_modules/.bin/tsc --noEmit -p tsconfig.json                   # silent
```

---

### S23 — Feedback event types + registry

*Worktree:* `codex/stage2-3-s23-feedback-events`. *Independent.*

*Files (NEW unless noted):*
- `packages/sidetrack-companion/src/feedback/events.ts` (NEW)
- `packages/sidetrack-companion/src/feedback/events.test.ts`
- `packages/sidetrack-companion/src/sync/contract/registry.ts` (modify)

*Schemas:*
```ts
export const USER_ORGANIZED_ITEM = 'user.organized.item';
export const USER_ENGAGEMENT_RELABELED = 'user.engagement.relabeled';
export const USER_FLOW_CONFIRMED = 'user.flow.confirmed';
export const USER_FLOW_REJECTED = 'user.flow.rejected';
export const USER_TOPIC_RENAMED = 'user.topic.renamed';
export const USER_SNIPPET_PROMOTED = 'user.snippet.promoted';

export type UserOrganizedItemPayload = {
  payloadVersion: 1;
  itemKind: 'thread' | 'workstream' | 'visit' | 'topic' | 'snippet';
  itemId: string;
  action: 'move' | 'merge' | 'split' | 'rename' | 'promote' | 'ignore';
  fromContainer?: string;     // workstream-id / topic-id / etc.
  toContainer?: string;
  details?: { rename?: string; mergeMembers?: readonly string[]; splitInto?: readonly string[] };
};

// Similar predicates for the other four.
```

*Change shape:*
- Six new Class A event types per § 1.F-equivalent of the Stage 1
  privacy events.
- All carry `payloadVersion: 1`, `dimensions: undefined`
  (`allowedDimensions: []`).
- Register in `CONTRACT_REGISTRY` with `currentPayloadVersion: 1` and
  `recovery: 'class-A'` (canonical, syncable).
- Predicates reject any payload missing required fields; runtime guard.

*Tests:*
- Type-guard positive + negative for each event.
- Registry coverage: every event has a `currentPayloadVersion`.

*Acceptance:* `vitest run src/feedback/` green; registry test green.

---

### F3-partial — DOM-skeleton hash

*Worktree:* `codex/stage2-3-f3-dom-hash`. *Independent.*

*Files (NEW):*
- `packages/sidetrack-extension/src/content/visual/dom-hash.ts`
- `packages/sidetrack-extension/src/content/visual/dom-hash.test.ts`
- `packages/sidetrack-extension/src/graph/dom-skeleton.ts`
- `packages/sidetrack-extension/entrypoints/visual-fingerprint.ts`
- `packages/sidetrack-companion/src/visual/events.ts`
- `packages/sidetrack-companion/src/visual/projection.ts`
- `packages/sidetrack-companion/src/sync/contract/registry.ts` (modify)
- `packages/sidetrack-companion/src/connections/snapshot.ts` (modify — emit `visit_in_template`)

*Schema:*
```ts
// Class F event
export const VISUAL_FINGERPRINT_OBSERVED = 'visual.fingerprint.observed';
export type VisualFingerprintObservedPayload = {
  payloadVersion: 1;
  visitId: string;
  domHash: string;        // SHA-256 of the canonical-form DOM skeleton
  observedAt: string;
  // NO pHash, NO screenshot, NO contents.
};

// New edge kind in connections snapshot
//   visit_in_template (visit → template:<domHash>)
//   confidence: 'observed', producedBy: { source: 'event-log' }
//   family: 'urlmatch'
```

*Change shape:*
- Content script extracts the DOM skeleton: tag-name tree only, no
  text contents, no attribute values (only class/id presence as a
  boolean). Stable normalized form.
- Hash via `crypto.subtle.digest('SHA-256', ...)`.
- Emitted as Class F event; SW writes to IndexedDB buffer (Stage 1 S5).
- Privacy gate: `privacy.gate.flipped({ gate: 'visual.fingerprint',
  state: 'open' })` required before content script registers.
- Reducer pass emits `visit_in_template` edges grouping visits by
  `domHash`.

*Tests:*
- DOM-skeleton normalization: same DOM skeleton → same hash, even if
  text/attributes change.
- Privacy gate: closed → no events emitted.
- Reducer: 3 visits with same domHash → 3 `visit_in_template` edges
  pointing to one template node.

*Acceptance:*
- Privacy posture grep:
  `grep -rn 'innerText\|textContent\|getAttribute\|innerHTML' packages/sidetrack-extension/src/content/visual/` returns 0 matches.
- New event registered with `allowedDimensions: []`.

---

### F4 — ANN index wrapping recall V3

*Worktree:* `codex/stage2-3-f4-ann-index`. *Independent.*

*Files (NEW unless noted):*
- `packages/sidetrack-companion/src/recall/ann-index.ts` (NEW — wraps existing index)
- `packages/sidetrack-companion/src/recall/ann-index.test.ts`
- `packages/sidetrack-companion/src/recall/ranker.ts` (modify — switch from flat scan to ANN where useful)
- `packages/sidetrack-companion/src/connections/visitSimilarity.ts` (modify — same)

*Reuse pointers:*
- `usearch` is a CPU-only HNSW library with TypeScript bindings; pinned
  version in `package.json`. **Add as a single new dep — this is the
  only Stage 2/3 binary dep.**

*Change shape:*
- Wrap the existing recall index V3 reader: build an in-memory HNSW
  index over the binary index's vectors at SW boot; serve top-K queries
  from HNSW; fall back to the existing flat-scan `rankHybrid` path
  when HNSW is unavailable (CPU budget, environment issue).
- Index lifecycle: rebuild on `_BAC/recall/index.bin` change; cached
  per-revision.
- No mutation of `index.bin`; ANN is read-only over the existing bytes.

*Tests:*
- Top-K query parity: HNSW result set ⊇ flat-scan top-K (HNSW may
  return extras due to approximate recall).
- Failure path: when usearch fails to load, falls back to flat scan
  with a logged warning.

*Acceptance:* `vitest run` green; bundle size delta for the new dep
documented in the commit message; existing connections-similarity
tests still pass byte-identical.

---

### F5 — HDBSCAN clusterer (alternative for topics)

*Worktree:* `codex/stage2-3-f5-hdbscan`. *Independent.*

*Files (NEW unless noted):*
- `packages/sidetrack-companion/src/connections/hdbscanClusterer.ts` (NEW)
- `packages/sidetrack-companion/src/connections/hdbscanClusterer.test.ts`
- `packages/sidetrack-companion/src/sync/contract/connectionsMaterializer.ts` (modify — pluggable clusterer; Union-Find stays default)

*Reuse pointers:*
- `density-clustering` npm package OR a pure-TS HDBSCAN port.
  Choose the smaller dep that has zero native bindings (we want WASM
  / pure-JS only). Preferred: write a tiny in-house HDBSCAN over the
  similarity edges — the algorithm is ~200 lines and we already have
  the mutual-reachability graph.

*Change shape:*
- Input: same as `topicClusterer.ts` (similarity edges + user-asserted
  edges).
- Output: same Topic shape (drop-in replacement for Union-Find when
  selected via revisionId namespace).
- New revision key: `topic-revision:v2:hdbscan`. Existing
  `topic-revision:v1:union-find` continues to ship; user pins which.

*Tests:*
- Determinism: same input → byte-identical output.
- Comparison fixture: 10-visit cluster with 1 outlier — Union-Find
  groups all 10; HDBSCAN groups 9 + marks 1 as noise.
- Cohesion metric stability across the two clusterers.

*Acceptance:* `vitest run` green; new revision key registered;
existing Union-Find revision still produced.

---

## Wave B — depends on Wave A

### S18 — Feature engineering + extraction layer

*Worktree:* `codex/stage2-3-s18-features`. *Depends on S17, S23.*

*Files (NEW):*
- `packages/sidetrack-companion/src/ranker/features.ts`
- `packages/sidetrack-companion/src/ranker/features.test.ts`
- `packages/sidetrack-companion/src/ranker/feature-schema.ts` (versioned schema)

*Schema:*
```ts
export const FEATURE_SCHEMA_VERSION = 1;

export type CandidatePairFeatures = {
  schemaVersion: typeof FEATURE_SCHEMA_VERSION;
  // Boolean (0 / 1) or count features
  same_workstream: 0 | 1;
  opener_chain_depth: number;
  in_navigation_chain: 0 | 1;
  same_canonical_url: 0 | 1;
  same_host: 0 | 1;
  same_repo: 0 | 1;
  same_search_query: 0 | 1;
  same_copied_snippet_count: number;
  shared_title_tokens: number;
  shared_path_tokens: number;
  // Continuous features
  cosine_similarity: number;            // 0..1 from existing recall index
  recency_score_from: number;           // exp(-age_days / 30)
  recency_score_to: number;
  engagement_class_match: 0 | 1;
  return_count_from: number;
  return_count_to: number;
  // User-asserted features (explicit signal)
  user_asserted_in_thread: 0 | 1;
  user_asserted_in_workstream: 0 | 1;
};

export type ExtractFeatures = (
  candidate: Candidate,
  context: { merged: AcceptedEvent[]; snapshot: ConnectionsSnapshot },
) => CandidatePairFeatures;
```

*Change shape:*
- One pure function per feature; composed into `extractFeatures`.
- All features computable from the merged event log + the current
  connections snapshot. No recomputation of embeddings — read from
  the existing recall index entries.
- Feature schema version bumps when fields are added/changed; ranker
  pins to a specific version.

*Tests:*
- One unit test per feature with fixture-based input/expected output.
- Schema-version stability: serializing the same features twice →
  byte-identical.
- Boundary: missing engagement class → `engagement_class_match: 0`.

---

### S19 — Negative-candidate producer

*Worktree:* `codex/stage2-3-s19-negatives`. *Depends on S17.*

*Files (NEW):*
- `packages/sidetrack-companion/src/ranker/negatives.ts`
- `packages/sidetrack-companion/src/ranker/negatives.test.ts`

*Schema:*
- Re-uses `Candidate` type from S17 with `sources: ['random_unrelated']`
  or `['recently_skipped']`.

*Change shape:*
- `randomUnrelated(fromVisitId, allVisits, count, seed)` —
  deterministic seeded sampler picks `count` visits NOT connected to
  `fromVisitId` by any edge in the snapshot.
- `recentlySkipped(fromVisitId, userActions, windowDays)` — visits the
  user explicitly skipped or rejected (via S23 `user.flow.rejected`)
  in the last `windowDays`.
- Both produce per-pair `Candidate` records with the corresponding
  source tag.

*Tests:*
- Seed determinism: same seed → same random sample.
- Excludes connected pairs.
- Recently-skipped: pulls from `user.flow.rejected` events only.

---

### S24 — Feedback projection

*Worktree:* `codex/stage2-3-s24-feedback-projection`. *Depends on S23.*

*Files (NEW unless noted):*
- `packages/sidetrack-companion/src/feedback/projection.ts`
- `packages/sidetrack-companion/src/feedback/projection.test.ts`
- `packages/sidetrack-companion/src/sync/contract/registry.ts` (modify — register projection surface)

*Schema:*
```ts
export type FeedbackProjection = {
  schemaVersion: 1;
  // Per-item user actions, keyed by item id.
  perItem: Record<string, readonly UserAction[]>;
  // Aggregate counts for ranker training:
  //   positive labels (user moved-into / promoted / confirmed)
  //   negative labels (user rejected / removed / split)
  positiveLabels: readonly { fromId: string; toId: string; weight: number }[];
  negativeLabels: readonly { fromId: string; toId: string; weight: number }[];
};
```

*Change shape:*
- Pure reducer over the merged log filtered to feedback events.
- Aggregates per-item action history + emits training-label datasets.
- Re-runs deterministically; output byte-identical for the same input.

---

### F2 — Cross-replica continuation classifier

*Worktree:* `codex/stage2-3-f2-continuation`. *Depends on Stage 2 features pipeline (S18).*

*Files (NEW):*
- `packages/sidetrack-companion/src/continuation/classifier.ts`
- `packages/sidetrack-companion/src/continuation/classifier.test.ts`
- `packages/sidetrack-companion/src/connections/snapshot.ts` (modify — Pass 11 emits `visit_continues_visit`)

*Schema:*
```ts
// New ConnectionEdgeKind: 'visit_continues_visit'
// Family: 'flow', confidence: 'inferred',
// producedBy: { source: 'continuation-classifier', revisionId }
```

*Change shape:*
- Input: pairs of cross-replica visits (same canonicalUrl, different
  replicaId) — sourced from the existing `visit_observed_on_replica`
  edges (Stage 1 S11).
- Features (same schema as S18 plus device-continuation-specific):
  same workstream, time-since-prior-visit, engagement-class match,
  copy/paste lineage continuity.
- Deterministic v1 classifier: weighted feature scorer over same
  canonical URL, same workstream, engagement-class match, time
  proximity, copy/paste continuity, and cosine similarity.
- Edge emitted at score ≥ 0.7. A learned LightGBM continuation
  revision can replace this later under a new revision id.

---

## Wave C — depends on Wave B

### S20 — LightGBM/LambdaMART ranker

*Worktree:* `codex/stage2-3-s20-ranker`. *Depends on S18, S19.*

*Files (NEW):*
- `packages/sidetrack-companion/src/ranker/train.ts`
- `packages/sidetrack-companion/src/ranker/predict.ts`
- `packages/sidetrack-companion/src/ranker/predict.test.ts`
- `packages/sidetrack-companion/src/producers/closest-visit-revision.ts`

*Reuse pointers:*
- `lightgbm` Node binding OR `xgboost` Node binding. Choose whichever
  has a smaller install footprint AND ships pre-built binaries for
  macOS arm64 + Linux x64 (so users don't need a C++ toolchain).
  **Single new heavy dep; document footprint in the commit message.**

*Schema:*
```ts
export type RankerRevision = {
  revisionId: string;            // sha256(model_version + feature_schema_version + training_label_dataset_hash).slice(0, 16)
  modelVersion: 'lightgbm-lambdamart-v1';
  featureSchemaVersion: 1;
  trainingDatasetHash: string;
  trainedAt: number;
  modelBytes: ArrayBuffer;       // serialized LightGBM model
};

export type RankerPredict = (
  features: CandidatePairFeatures,
  model: LightGBMModel,
) => { score: number; contributions: Record<keyof CandidatePairFeatures, number> };
```

*Change shape:*
- Training: `train.ts` consumes feedback projection (S24) +
  candidate-generation features (S17 + S18 + S19); produces a serialized
  LightGBM model + reproducible `revisionId`.
- Prediction: `predict.ts` loads the active model + scores any
  `CandidatePairFeatures` → score + per-feature contributions
  (LightGBM `pred_contrib=true`).
- Class E revision at `_BAC/connections/closest-visit/<revisionId>.json`
  (model bytes base64-encoded; manifest separate from model so the
  revision is listable without loading the model).

*Tests:*
- Train on a synthetic 100-pair dataset → predict on a held-out pair →
  assert score correlation with label.
- Determinism: same training dataset hash + same seed → same
  `revisionId`.
- Per-feature contribution sums approximate score (within LightGBM's
  numerical tolerance).

---

### S21 — `closest_visit` edge emission

*Worktree:* `codex/stage2-3-s21-closest-visit-edge`. *Depends on S20.*

*Files (NEW unless noted):*
- `packages/sidetrack-companion/src/connections/snapshot.ts` (modify — Pass 12 emits closest_visit)
- `packages/sidetrack-companion/src/connections/types.ts` (modify — add `closest_visit` edge kind)
- `packages/sidetrack-extension/src/sidepanel/connections/edgeKinds.ts` (modify — register new kind)

*Schema:*
```ts
// New ConnectionEdgeKind: 'closest_visit'
// Family: 'urlmatch' (content+behavior similarity)
// confidence: 'inferred'
// producedBy: { source: 'ranker', revisionId }
// metadata: { score: number; topContributions: ReadonlyArray<{ feature: string; weight: number }> }
```

*Change shape:*
- Pass 12 in `snapshot.ts`: per visit, take top-K closest_visit edges
  by ranker score (default K=5). Drop below score threshold (0.3).
- Each edge carries the top-3 feature contributions in metadata so the
  Why Related panel renders them as reasons.

*Tests:* fixture-based — given a known ranker model + candidate set,
the snapshot has the expected top-K edges with correct scores +
contributions.

---

### S22 — Debug-pack MCP tool

*Worktree:* `codex/stage2-3-s22-debug-pack`. *Depends on S21.*

*Files (NEW unless noted):*
- `packages/sidetrack-companion/src/mcp/explainRanking.ts`
- `packages/sidetrack-companion/src/mcp/explainRanking.test.ts`
- `packages/sidetrack-companion/src/mcp/server.ts` (modify — register tool)

*Schema:*
```ts
// MCP tool: sidetrack.debug.explainRanking
// Input: { from: string; to: string }   (visit ids or canonical URLs)
// Output: {
//   features: CandidatePairFeatures;
//   modelVersion: string;
//   revisionId: string;
//   score: number;
//   contributions: ReadonlyArray<{ feature: string; weight: number }>;
//   sortedReasonCodes: ReadonlyArray<{ code: string; payload: object }>;
// }
```

*Change shape:*
- Pure MCP read: rebuild features for the given pair on demand,
  predict via the active ranker, return everything for inspection.

*Tests:* fixture pair → exact JSON output stable across runs.

---

### S25 — Ranker retraining loop

*Worktree:* `codex/stage2-3-s25-retrain`. *Depends on S20 + S24.*

*Files (NEW unless noted):*
- `packages/sidetrack-companion/src/ranker/retrain.ts`
- `packages/sidetrack-companion/src/ranker/retrain.test.ts`
- `packages/sidetrack-companion/src/sync/contract/connectionsMaterializer.ts` (modify — schedule retrain on feedback-projection delta)

*Change shape:*
- Periodic retrain: triggered when feedback projection's training-label
  dataset hash changes by more than a threshold (e.g., 50 new labels).
- Each retrain produces a new `RankerRevision` (S20). Old revisions
  stay queryable; user can pin via UI (S27).

---

### S26 — Side-panel feedback-capture UI

*Worktree:* `codex/stage2-3-s26-feedback-ui`. *Depends on S23.*

*Files (NEW unless noted):*
- `packages/sidetrack-extension/src/sidepanel/feedback/FeedbackButtons.tsx` (NEW)
- `packages/sidetrack-extension/src/sidepanel/feedback/FeedbackButtons.test.tsx`
- `packages/sidetrack-extension/src/sidepanel/connections/{ConnectionsView,WhyRelatedPanel,FlowPathView,FocusView}.tsx` (modify — add feedback affordances)
- `packages/sidetrack-extension/src/sidepanel/connections/connectionsClient.ts` (modify — add user-action POST helpers)

*Change shape:*
- Per-edge: thumbs-up / thumbs-down → fires `user.flow.confirmed/.rejected`.
- Per-topic: rename inline → fires `user.topic.renamed`.
- Per-snippet: "promote to source" → fires `user.snippet.promoted`.
- Per-thread / workstream: existing move/merge/split flows already in
  the side panel — wire them to fire `user.organized.item` (currently
  some fire chrome.storage updates only).

*Tests:* component-level snapshot tests + a network-mock test that
asserts each button click POSTs the right event to the companion.

---

### S27 — Producer-pin UI

*Worktree:* `codex/stage2-3-s27-producer-pin`. *Depends on S25 + S26.*

*Files (NEW):*
- `packages/sidetrack-extension/src/sidepanel/connections/ProducerPin.tsx`
- `packages/sidetrack-extension/src/sidepanel/connections/ProducerPin.test.tsx`

*Change shape:*
- Surface in Why Related panel: "this score from ranker-v3 (learned
  from 142 corrections); pin this version".
- Pinning writes to `chrome.storage.local` per-user-per-producer; UI
  filters consumed Class E revisions to the pinned set.
- "Unpin" button reverts to active revision.

*Tests:* component snapshot + storage write/read round-trip.

---

## Wave D — sequential, lead-led

### L1 — Stage 2/3 e2e suite

*Branch:* lands on `feat/work-graph-stage2-3` directly by lead.
*Depends on:* all of S17–S27 + F2–F5.

*File:* `packages/sidetrack-extension/tests/e2e/connections-stage2-3-user-story.spec.ts` (NEW)

*Scope:* drives the feedback-driven training cycle end-to-end:
1. UI-driven Stage 1 setup (workstream + timeline + permission).
2. Drive 10-15 navigations producing topic candidates.
3. User feedback: thumbs-down a `visit_resembles_visit` edge (rejects
   it); rename a topic; promote a snippet.
4. Wait for ranker to retrain (force via runtime message).
5. Assert a new `RankerRevision` exists; assert the rejected edge has
   lower score in the new revision.
6. Open the debug-pack MCP tool, assert per-feature contributions are
   visible.

### L2 — Update `docs/architecture.md`

*Branch:* same. Add a "Model registry" section covering Class E
revision policy, retention, pinning, and how the ranker / classifier /
clusterer revisions interact.

### L3 — Sub-task briefs (this doc)

Already authored.

---

## Codex hand-off protocol

For each unchecked sub-task in [PR #105's body](https://github.com/zyingfei/switchboard/pull/105):

1. User spins Codex on the brief in this doc.
2. Codex creates worktree branch, executes, runs tests, pushes.
3. Codex marks the box `[x]` in PR #105's body.
4. Lead receives a notification (10-min monitor); reviews the diff;
   integrates conflicts in shared files (`snapshot.ts`,
   `connectionsMaterializer.ts`, `types.ts`, `ConnectionsView.tsx`).
5. Lead lands fixes as new commits.
6. Once all unchecked boxes are checked: lead authors L1 e2e + L2
   docs; PR moves out of draft; PR merges to main.

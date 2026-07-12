# Recall + Ranker V2 Hard Replacement — Design Doc

**Status**: Approved, in-progress
**Date**: 2026-05-26
**Branch**: `feat/recall-ranker-v2-replacement`
**Author**: yingfei (with claude assistance)

## Context

The current ranker has three structural faults made visible across recent
dogfood + investigation:

1. **Training labels don't match serving.**
   `deriveNegativeVisitPairLabelsFromSnapshot` (`ranker/retrain.ts`)
   Cartesian-expands one user "ignore" event over CURRENT snapshot container
   membership. The trained ranker sees pairs the user never saw. The live test
   vault drifted 4731 → 4040 negatives between training runs with zero new user
   feedback — the silent re-labeling that broke the original retrain gate.

2. **8:1 class imbalance is engineering, not reality.**
   481 moves → 481 positives; 97 ignores × ~40-member current containers →
   ~3880 expanded negatives. Most expanded negatives are easy and dilute
   gradient. The Step-7 `container_negative_match` feature was a band-aid
   asking the model to discount the artifact instead of removing it.

3. **Validation is in-sample-ish.**
   The combiner ship-gate was removed (Codex HIGH finding) because rows used
   to fit weights were also used to validate. Even where rows are held out,
   sibling rows from the same Cartesian expansion remain in training —
   correlated negatives that inflate apparent metrics.

This doc directs a **hard replacement**: event-sourced labels, group-level
LambdaMART, schema v6 with retrieval + chunk-vector features, ship-gate against
the production /v2 retrieval baseline, cross-encoder rerank on by default in
dogfood, single SQLite vector source of truth. No flag coexistence; no
preservation of the old expansion path for serving or evaluation; no implicit
positive-signal mining (explicit feedback only).

## Decisions (from alignment)

- **Snapshot vs replay**: **Both**. Snapshot for new /v2 traffic (durable);
  reconstruction for historical feedback (where snapshot didn't exist yet).
- **Implicit positives**: **NO**. Explicit feedback only:
  move / promote / confirm / snippet-promoted / flow-confirmed (positive);
  ignore / reject / flow-rejected (negative); unjudged candidates are
  unlabeled, not hard negatives.
- **Online RankNet head**: **Not in this scope.** Decision deferred to a
  follow-up workstream after v6 batch is stable.
- **Cross-encoder feature**: **Yes, AND keep as rerank stage.** The
  cross-encoder fires once in /v2/recall (rerank stage, on by default); its
  score flows as a feature into the downstream LightGBM ranker. No double
  encoding.
- **Bootstrap from old labels**: **NO**. Hard replacement; accept cold-start
  sparsity. v5 LightGBM keeps serving until v6 passes the production-baseline
  gate.

## Target architecture

```
USER ACTION on served context
    ↓
recall.served + recall.action events
(immutable, append-only, sequence-ordered)
    ↓
deterministic label projection
(event-scoped; no snapshot peek)
    ↓
group-level training:
  group = served context (snapshot) OR feedback event (replay /v2)
  candidates = /v2 recall lanes
    (FTS5 + sqlite-vec + graph + RRF + dedupe + suppress + MiniLM rerank)
  labels = explicit feedback only
    ↓
CandidatePairFeatures schema v6:
  existing 33 features (minus container_negative_match)
  + chunk-vector pair features (3)
  + retrieval-derived features (~11)
    ↓
LightGBM LambdaMART
(LambdaRank objective, group= impression boundaries)
    ↓
ship-gate vs production /v2 baseline
(raw-event / served-context metrics)
    ↓
CFT + companion dogfood
(new defaults active immediately)
```

## Phased execution

Phases land in this order on `feat/recall-ranker-v2-replacement`. Each phase
has a clean stopping point that doesn't break serving; v5 LightGBM keeps
serving until Phase 6 explicitly promotes v6.

### Phase 0 — Impression logging (Deliverables 2, 4 plumbing)

**Goal**: durable record of every served context + every user action against
it. Zero serving change.

- New event types in `recall/eventTypes.ts`:
  - `recall.served`: `{ servedContextId, query, sessionContext, response:
    { results: RecallCandidate[], meta }, suppressionDecisions, sequenceNumber,
    eventTime }`
  - `recall.action`: `{ servedContextId, entityId, actionKind:
    "click" | "open_new_tab" | "snippet_promote" | "flow_confirm" |
    "flow_reject" | "move" | "promote" | "ignore" | "reject", eventTime }`
  - `recall.action` only fires on the **explicit** kinds above. Dwell / hover /
    expand-why are intentionally NOT logged as actions.
- `recall-v2/pipeline.ts` writes `recall.served` on every successful response
  (POST-suppression results, with rerank annotations).
- Background SW + sidepanel wire `recall.action` from existing user-action
  paths; new wiring for click + open-new-tab from popover / sidepanel result
  rows.
- Health: append `recall.servedCount` + `recall.actionCount` to existing
  event-log diagnostics.

**Done when**: every /v2/recall response writes a `recall.served`; user actions
on results land as `recall.action` events tied by `servedContextId`.

### Phase 1 — Remove Cartesian expansion (Deliverable 1)

**Goal**: kill the snapshot-derived label fan-out.

- Delete `deriveNegativeVisitPairLabelsFromSnapshot` and
  `augmentFeedbackWithVisitPairLabels` (`ranker/retrain.ts`).
- Container-level negative labels remain in feedback projection but stay
  event-scoped: `{ anchorId, containerId, polarity: "negative", eventTime,
  containerRevisionId?, servedContextId? }`. No expansion.
- Remove `container_negative_match` feature from the schema and from feature
  extraction (`ranker/feature-schema.ts`, `ranker/features.ts`).
- Health adds `expandedNegativeCount` (must be 0), `labelDriftWithoutFeedback`
  (must be 0).
- v5 model keeps serving.

**Tests**:
- **Label Stability Test**: same event log + snapshot churn → identical labels
  (`labelDriftWithoutFeedback = 0`)
- **No Expansion Test**: container-level ignore event → no pairwise negatives
  generated (`expandedNegativeCount = 0`)

### Phase 2 — Schema v6: chunk-vector + retrieval features (Deliverables 6, 7)

**Goal**: enrich the feature vector with signals that today get pooled away or
that the ranker is blind to.

**Per-chunk vector persistence** (prerequisite):
- Unify `page-content/store.ts:splitPageContentIntoChunks` and
  `page-evidence/embedding.ts:splitDocEmbeddingChunks` into one chunking pass.
  Single chunk size, single boundary policy.
- Persist `chunkEmbeddingVector` per chunk in the SQLite-backed document store.
- One-time backfill: re-embed existing pages chunk-by-chunk
  (~25 minutes for current vault).

**Schema v6** (`ranker/feature-schema.ts`):

Add chunk-vector pair features:
- `max_chunk_pair_vector_cosine`
- `top3_mean_chunk_pair_vector_cosine`
- `chunk_pair_vector_support_count`

Add retrieval-derived features:
- `bm25_score`, `bm25_rank`
- `dense_doc_score`, `dense_doc_rank`
- `rrf_score`, `rrf_rank`
- `graph_similarity_rank`
- `candidate_source_flags` (bitmask: page_content | timeline_visit |
  chat_turn | semantic_query | graph_neighbor)
- `served_position`
- `cross_encoder_score` (from /v2/recall rerank when present)
- `cross_encoder_rank_delta`

Remove `container_negative_match`.

Bump `FEATURE_SCHEMA_VERSION` 5 → 6.

Feature extraction:
- Chunk-vector features in `connections/visitSimilarity.ts:chunkSupportFor`
  alongside lexical chunk scoring (per-chunk vector cosine MaxSim).
- Retrieval features populated from `recall.served` (snapshot path) or from
  re-running /v2/recall (reconstruction path).
- Missing retrieval features must be **explicit and audited**, not silently
  zeroed.

**Tests**:
- **Chunk-Vector Feature Test**: long-document fixture where only one
  paragraph pair is semantically related →
  `max_chunk_pair_vector_cosine > docVector-only similarity`,
  `chunk_pair_vector_support_count > 0`.

### Phase 3 — Group-level training (Deliverable 3)

**Goal**: replace `retrain.ts`'s per-row training with group-level LambdaMART
over impressions and feedback events.

New `ranker/retrain-impressions.ts`:

- **Group construction**:
  - **Snapshot path** (preferred): one `recall.served` event → one group;
    rows = served candidates; labels = explicit `recall.action` events tied by
    `servedContextId`.
  - **Reconstruction path** (for historical feedback predating Phase 0): one
    explicit feedback event with no parent `servedContextId` → reconstruct
    candidate set by re-running /v2/recall against current index.
  - Unjudged retrieved candidates are **unlabeled**, not hard negatives.
- **LightGBM**: `lambdarank` objective; `group=` parameter set to
  per-impression row counts.
- **Splits**: train / validation / reserved-test by **impression**, not by row.
  Reserved-test used exactly once.
- **Cold start**: when `groupCount < 50` impressions with ≥1 positive,
  training skips; v5 model continues serving.

Training-time health: `rawPositiveCount`, `rawNegativeCount`, `groupCount`,
`avgCandidatesPerGroup`, `positivesPerGroup`, `explicitRejectsPerGroup`,
`unjudgedCandidatesPerGroup`, `candidateSourceDistribution`,
`expandedNegativeCount = 0`, `labelDriftWithoutFeedback = 0`.

`RANKER_MODEL_VERSION` → `lightgbm-lambdamart-v6`.

### Phase 4 — Single SQLite vector source of truth (Deliverable 9)

- `documents_vec` canonical for document vectors.
- `documents_chunks_vec` (new in Phase 2) canonical for chunk vectors.
- HNSW (`connections/visitSimilarityHnsw.ts`) becomes a **derived in-memory
  index** rebuilt from SQLite vectors on startup; no independent truth.
- Sidecar L2-normalized store in `recall/semanticRecallPool.ts` retires;
  replaced by direct sqlite-vec queries.
- Embedding cache stays (memoization layer, not truth).

**Consistency test**: cosine values match between ranker feature extraction
and /v2/recall's semantic-query lane for same pairs.

### Phase 5 — /v2/recall as the dogfood path (Deliverables 4, 5)

- `recall-v2/pipeline.ts`: default `strategy.rerankTopK = 20` (calibrate
  post-dogfood).
- `recall-v2/rerank.ts` reports `crossEncoderLatencyMs`, `rerankedCount`,
  `rankMovement` diagnostics on every response with rerank active.
- Extension routes exclusively through /v2/recall. Extension-side RRF +
  current-URL-drop + self-suppression deleted.
- `/v1/content/query` + `/v1/recall/query` retire from dogfood (deletion is
  post-stability follow-up).
- Health: `retrievalBackend = "v2"`, `vectorStore = "sqlite"`,
  `crossEncoder.enabled = true`, `crossEncoder.rerankTopK = N`,
  `fusionImplementation = "recall-v2"`.

### Phase 6 — Ship-gate vs production /v2 baseline (Deliverable 8)

- **Production baseline** = current /v2/recall stack WITHOUT learned LightGBM
  ranker: FTS5/BM25 + sqlite-vec + graph + RRF + dedupe + suppression +
  cross-encoder rerank + deterministic `graph_baseline`.
- **Active model** = trained v6 LightGBM applied on top of the same /v2
  candidate stream.
- **Metrics** (raw-event / served-context level): `nDCG@K` (K=5, 10), `MRR`,
  `Recall@K` for positives, `explicit_reject_precision`,
  `false_positive_rate_on_rejected_contexts`.
- **Gate logic**: PASS iff active model improves at least one primary metric
  (nDCG@10 or MRR) AND does not regress `explicit_reject_precision` AND
  meets `labelDriftWithoutFeedback = 0` AND `expandedNegativeCount = 0`.
  FAIL on any regression vs baseline.
- **Reserved test**: held-out impressions sealed at retrain time; used exactly
  once.

### Phase 7 — Immediate CFT + companion dogfood (Deliverable 10)

- Rebuild + restart the test companion.
- Reload extension in CFT.
- Smoke: déjà-vu popover + sidepanel + focus health + explicit feedback +
  force retrain.
- Dogfood report: before / after ranks on 11 eval fixtures, source lanes,
  cross-encoder rank movement, chunk-vector feature contribution,
  rejected-context precision.

## Critical files

**Companion — new**:
- `packages/sidetrack-companion/src/ranker/retrain-impressions.ts` (Phase 3)

**Companion — modified**:
- `packages/sidetrack-companion/src/ranker/retrain.ts` (Phase 1)
- `packages/sidetrack-companion/src/ranker/feature-schema.ts` (Phase 2)
- `packages/sidetrack-companion/src/ranker/features.ts` (Phase 2)
- `packages/sidetrack-companion/src/ranker/train.ts` (Phase 3)
- `packages/sidetrack-companion/src/ranker/select.ts` (Phase 6)
- `packages/sidetrack-companion/src/page-content/store.ts` +
  `page-evidence/embedding.ts` (Phase 2)
- `packages/sidetrack-companion/src/connections/visitSimilarity.ts` (Phase 2)
- `packages/sidetrack-companion/src/connections/visitSimilarityHnsw.ts`
  (Phase 4)
- `packages/sidetrack-companion/src/recall/semanticRecallPool.ts` (Phase 4)
- `packages/sidetrack-companion/src/recall-v2/pipeline.ts` (Phases 0, 5)
- `packages/sidetrack-companion/src/recall-v2/store/sqlite.ts` (Phases 2, 4)
- `packages/sidetrack-companion/src/http/server.ts` (Phases 0, 5)
- `packages/sidetrack-companion/src/system/workGraphHealth.ts` (all phases)

**Extension — modified**:
- `packages/sidetrack-extension/entrypoints/content.ts:fetchDejaVu`
  (Phases 0, 5)
- `packages/sidetrack-extension/src/contentOverlays/dejaVuModel.ts` (Phase 5)
- `packages/sidetrack-extension/entrypoints/sidepanel/useRecallSearch.ts`
  (Phase 5)
- `packages/sidetrack-extension/src/sidepanel/HealthPanel.tsx` (all phases)

## Verification

End-to-end gate (every item must pass for Definition Of Done):

1. **Cartesian removed**:
   `grep -r "deriveNegativeVisitPairLabelsFromSnapshot" src/` returns nothing.
   `expandedNegativeCount = 0` in dogfood health.
2. **Label stability**: replay event log against shifted snapshot → identical
   labels. `labelDriftWithoutFeedback = 0`.
3. **Event-sourced labels**: deterministic projection from raw events;
   replayable; deduped by event id.
4. **Group-level training**: LightGBM receives `group=` parameter; training
   reports group-level stats.
5. **/v2 in dogfood**: `retrievalBackend = "v2"`; no /v1 calls in CFT trace.
6. **Cross-encoder on by default**: `crossEncoder.enabled = true`;
   `rerankedCount > 0` per request.
7. **Chunk vectors persisted + used**: `indexedChunkVectorCount > 0`;
   chunk-vector features non-zero on multi-paragraph dogfood page.
8. **Retrieval features present**: `candidateSourceDistribution` populated;
   ablation report computable.
9. **Ship-gate vs production baseline**: gate compares against /v2 +
   `graph_baseline`; raw-event metrics; reserved test used once.
10. **Single vector source of truth**: HNSW + sidecar derived / retired;
    consistency test passes.
11. **CFT smoke**: dogfood report shows before / after ranks, cross-encoder
    rank movement, chunk-vector contribution, rejected-context precision.

11 recall-v2 eval fixtures stay green throughout (regression floor).

## Non-negotiable lines

- Cartesian negative expansion is not preserved as a training truth.
- Current snapshot membership does not rewrite historical labels.
- Model is not evaluated on expanded-row metrics.
- /v1 recall/content paths do not participate in dogfood production.
- Cross-encoder rerank is not opt-in only for dogfood (default ON).
- Chunk vectors are not pooled away without preserving chunk-level semantic
  features.
- Multiple vector stores do not act as independent sources of truth.
- Ship-gate does not pass unless model beats production /v2 baseline on
  raw-event / served-context metrics.

## Not in this scope (follow-up workstreams)

- **Online RankNet head fate**: Steps 5-6 from prior ultraplan landed an online
  pairwise SGD path. This plan focuses on batch LambdaMART; online-head
  decision deferred.
- **Bootstrap from old labels**: forbidden by alignment; sparse cold-start
  accepted instead.
- **Hard-negative mining for unjudged candidates**: keeping them as unlabeled.
  If model underperforms, similarity-based hard-negative sampling within group
  is the natural extension.
- **BERTopic-shaped topic producer**: orthogonal; topic-clustering choice
  (leiden-CPM stays served) is a separate workstream.
- **v1 retrieval endpoint deletion**: Phase 5 retires v1 from *dogfood*. Full
  deletion is post-stability follow-up.

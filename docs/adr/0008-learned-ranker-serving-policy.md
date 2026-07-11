# ADR-0008 — Learned-ranker serving policy and serve gates

- Status: Accepted (retroactive, 2026-07-11)
- Date: 2026-07-11
- Owner: User + Claude
- Components: API | Shared
- Related: ADR-0005, PRD §6.1.8, PRD §11 decision 9 (P1 freeze)

## Context

The `/v2` recall pipeline includes a learned reranker that can serve
one of several model artifacts: `lightgbm_lambdamart`,
`lightgbm_plus_online_lr`, `logistic_batch`, `logistic_online`,
`hierarchical_per_container_lr`, and a deterministic `graph_baseline`
fallback. ADR-0005 established that a learned model requires a
model-orthogonal evaluation spine before promotion. This ADR records
the serving-policy decision: how the companion selects which artifact
to serve at query time and what gates must pass.

The selector is implemented in
`packages/sidetrack-companion/src/ranker/select.ts`. The learned
reranker is applied in the `/v2` pipeline via
`packages/sidetrack-companion/src/recall-v2/learnedRerank.ts`.

## Decision

Adopt a **ship-gate-based artifact selector** with deterministic
fallback:

1. Among trained artifacts, filter to those that pass their own
   ship gate (`shipGate.status === 'pass'`) and have loadable model
   state (LightGBM bytes for LambdaMART variants, persisted LR weights
   for logistic variants, no state for graph baseline).
2. Among passing artifacts, pick the one with the highest
   `reservedTestMetric.value` (reserved-test NDCG@5). Tie-break by
   `RankerArtifactKind` declaration order (deterministic).
3. If no artifact passes (or the manifest is absent), fall back to
   `graph_baseline` — the deterministic feature scorer that requires no
   learned state.

**Ship gate conditions** (must all pass before a learned artifact is
served):
- Sufficient genuine supervision: at least one usable query group with
  both positive and negative labels in the per-user temporal split.
- Methodology spine passes: per-user forward-chaining time-split,
  reserved test slice, leakage probes (feature-ablation,
  label-permutation, novel-pair slice).
- Model beats `graph_baseline` on reserved-test NDCG@5.

**Rerank enable flag**: the `recallLearnedRerankEnabled` function in
`learnedRerank.ts` gates learned reranking behind a feature flag
(`SIDETRACK_RECALL_LEARNED_RERANK`). When absent, the pipeline serves
`graph_baseline` scores only. The flag allows safe rollout without
changing the selector logic.

**Maintenance-only during P1 freeze** (PRD §11 decision 9): the
retrain loop, impression emission, and online head update are permitted
to run as bug fixes and stability improvements; no new ranker scope
(new artifact kinds, new feature vectors, new training pipelines) ships
until the §13 acceptance scenario closes.

## Options considered

### Option A — Serve the best-metric artifact unconditionally

Pros:
- Simpler selector; always serves a learned model if one exists.

Cons:
- Fails when supervision is insufficient or the model passed only
  leaked labels (the exact failure mode from ADR-0005 §context).
- A model with zero usable query groups would score arbitrarily, not
  be silently gated.

### Option B — Ship-gate selector with graph_baseline fallback (chosen)

Pros:
- "Correctly silent" is an auditable state (selector emits reason
  `fallback_graph_baseline` with gate details).
- `graph_baseline` is always serveable; users never see a broken
  ranking even when the learned model cannot pass its gate.
- Satisfies ADR-0005: promotion requires the methodology spine, not
  just metric values.

Cons:
- Users with small event histories will see `graph_baseline` until
  they accumulate enough genuine supervision. This is correct
  behavior, not a bug.
- Gate status must be surfaced in health diagnostics so developers
  can distinguish a safe block from a broken pipeline.

## Consequences

Positive:
- No learned model can reach production without passing the methodology
  spine (ADR-0005 invariant enforced at serve time, not just eval time).
- Ranker health panel surfaces `selectedKind`, `reason`,
  `shipGateStatus`, and `shipGateReason` for every drain.
- Adding a new artifact kind (e.g. a neural reranker) requires only
  adding it to the `KIND_ORDER` list in `select.ts` and implementing
  the evaluation spine contract.

Negative:
- Fresh installs with few events will serve `graph_baseline`
  indefinitely until supervision accumulates.
- Retrain worker adds latency to drains; gate status changes are
  drain-time events, not real-time.

## Extension model

New learned artifact kinds follow the same gate contract. The selector
is order-first on `KIND_ORDER`; new kinds are inserted at the
appropriate priority position. The `graph_baseline` kind always remains
the last entry.

## Security and operations impact

No browser permissions or remote services are added. Model artifacts
are persisted in `<vault>/_BAC/ranker/` and are companion-owned. Raw
page bodies are never logged; only aggregate metrics, feature/probe
status, revision IDs, and label counts are persisted (per ADR-0005).

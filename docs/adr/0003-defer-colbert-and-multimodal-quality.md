# ADR-0003 — Defer ColBERT high-precision recall & WebQuality-style multimodal quality

**Status**: Accepted — deferred, evidence-gated (2026-05-15)
**Decider**: User + Claude
**Related**: Evolution plan rank 6 ("ColBERT / WebQuality-style advanced
models"), ADR-0002 (causal-first sync — the lightweight deterministic
spine this protects), PR #172 (idf-rkn-split active default), the
in-architecture work landing on `evolve/*` (R1 extraction ensemble,
R1b learned gray-zone quality, R2 quality-weighted hybrid, R3
drift/eval layer).

## Context

The evolution plan's rank 6 proposes two premium-precision upgrades:

1. **ColBERT** late-interaction reranking for expensive/high-value
   queries.
2. **WebQuality-style multimodal** page-quality scoring (vision +
   text/DOM) for visual/dynamic pages.

Both collide with load-bearing architecture invariants:

- **The query path is intentionally deterministic and lightweight.**
  Recall is already a dense+sparse hybrid (`usearch` HNSW +
  `minisearch`, Reciprocal Rank Fusion k=60, vector-only fallback) in
  `packages/sidetrack-companion/src/recall/ranker.ts`. No heavy ML
  runs at query time; results are reproducible. ColBERT requires a
  late-interaction transformer at query time plus a multi-vector
  index (per-token vectors) — materially larger index and
  non-deterministic latency on the hot path.
- **Local-first, ESM, no Python/Rust runtime.** WebQuality-style
  scoring needs a vision/multimodal model and renders; that is a new
  heavy runtime dependency in a process that deliberately ships only
  pure-JS/Node-addon components.
- **They are not the current bottleneck.** The dominant evidence
  problem is extraction quality (a hand-rolled extractor whose tier
  literally gates topics/search/ranker), addressed far more cheaply
  by R1 (Readability ensemble), R1b (learned gray-zone quality), R2
  (quality-weighted hybrid + explainability), and made *measurable*
  by R3 (drift/eval). Adopting ColBERT/WebQuality now would add the
  most cost where the leverage is lowest, and would replace — not
  harden — the spine, contradicting the plan's own principle.

## Decision

**Defer both. Do not put either on the hot path. Make the revisit
data-driven through the R3 drift/evaluation layer.** Pursue the
in-architecture alternatives first (R1/R1b/R2/R3). When (and only
when) those are in place and the drift layer shows a measured ceiling,
revisit — and even then, admit ColBERT/WebQuality only as an
*opt-in candidate revision* (mirroring the existing
`topicAlgorithmComparison` candidate-revision pattern), never as a
baseline replacement.

### Trigger conditions to revisit

**ColBERT (optional high-value-query reranker):**
- R1/R2 have shipped and the R3 drift/eval layer reports retrieval
  quality has *plateaued* (no improvement across N revisions) **and**
  a measured query-failure rate on the high-value-query set exceeds
  an agreed threshold; **and**
- it can be implemented strictly off the hot path (offline/opt-in,
  expensive queries only), preserving the deterministic default and
  vector-only fallback.

**WebQuality-style multimodal quality:**
- R1 (extraction ensemble) + R1b (learned gray-zone) have shipped and
  the R3 drift layer shows the rule+LightGBM quality gate's measured
  false-accept / false-reject on JS-heavy / visually-dynamic pages
  still exceeds an agreed threshold — i.e. the cheap path demonstrably
  did **not** close the gap.

## Consequences

- The deterministic, local-first, ESM query path and the rebuildable
  recall index are preserved.
- Premium precision is deferred, not foreclosed: the decision is
  reversible and gated on R3 evidence rather than intuition, matching
  the architecture principle *"drift/evaluation decides when opinions
  need replacement."*
- Both upgrades, if revisited, enter as measured opt-in revisions
  alongside the baseline — consistent with how `idf-rkn-split` itself
  was evaluated — so neither becomes a forced data migration or UX
  regression.

## Alternatives considered

- **Adopt now** — rejected: violates the lightweight/local-first
  invariants and spends effort where leverage is lowest while the
  extraction bottleneck is unaddressed.
- **Rule out permanently** — rejected: there is a real precision
  ceiling for hard semantic queries and visual/dynamic pages; keep
  the door open behind explicit, measurable triggers.

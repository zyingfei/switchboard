# Sidetrack — Evolution: evidence quality, hybrid retrieval, drift/eval, grouping & ranker

> **Status: implemented, draft PR #176 (`evolve/evidence-retrieval-drift`).**
> Six ranked upgrades, each implemented as the *in-architecture*
> equivalent, additive and independently verified. Companion 1177/1180
> (2 skipped, 1 pre-existing flake), extension green. Not merged;
> per-commit reviewable.
>
> **Prior:** builds on `main` after PR #172 (idf-rkn-split promoted to
> the served/active topic revision, default-on) and PR #174 (Focus UX
> follow-up). Decision record for the deferred rank: [ADR-0003](../adr/0003-defer-colbert-and-multimodal-quality.md).

## Northern star (carried forward)

> Facts are event-sourced. Interpretations are versioned. Suggestions
> are explainable. User organization is authoritative. No inference
> requires GPU / Apple-Silicon hardware.

This evolution does not touch the locks. It strengthens the weakest
links in the existing evidence chain without replacing the
event-sourced/local-first spine:

```
capture → vault/event-log → materializers → embedding → topics → ranker → sync
```

## Frame: harden, don't replace

A ground-truth audit of the current code corrected two assumptions in
the source plan, which reshaped priority:

- **Retrieval is already hybrid.** `recall/ranker.ts` already fuses
  `usearch` (HNSW dense) + `minisearch` (sparse lexical) via Reciprocal
  Rank Fusion (k=60) with a vector-only fallback. "Adopt a sparse+dense
  hybrid" is therefore *not* a capability gap — so R2 hardens the
  existing fusion rather than swapping in Tantivy/FAISS (Rust/native,
  off-architecture).
- **Ranking is already LambdaMART LTR.** `ranker/` is
  `lightgbm-lambdamart-v1` over ~18 features with feedback-labelled
  relevance. So R5 is a feature/version expansion of an existing model,
  not a greenfield LTR.

The genuinely highest-leverage untouched gaps were **evidence quality**
(extraction tier literally gates topics/search/ranker) and **drift
detection** (no statistical detector existed). Rank order: evidence →
retrieval hardening → drift → grouping alternatives → ranker → defer
premium models.

### Pipeline: before → after

```
before:  capture → vault → materializers → embedding/recall(RRF) → idf-rkn-split topics → LambdaMART(closest_visit) → sync
after:   capture → vault → [evidence layer: Readability ensemble + rule-floor & learned gray-zone quality]
                          → [hybrid recall: RRF + quality tiebreak + explainability]
                          → idf-rkn-split active  +  Louvain measured candidate
                          → [drift/eval: ADWIN + KSWIN + temporal silhouette, per drain]
                          → LambdaMART(+lineage,+page-quality features, version-safe)
                          → sync                          (premium models deferred — ADR-0003)
```

## Per-rank design

For each: **Intent · Decision (in-architecture) · Rejected · Loci ·
Verification · Deferred.**

### R1a — extraction ensemble  (`054cfb82`)
- **Intent:** raise page-body fidelity; the quality tier (which gates
  everything downstream) only reaches `high` for `reader-mode`/manual.
- **Decision:** add `@mozilla/readability` (pure-JS, runs on the
  extension's cloned DOM) as a strategy; ensemble selects the candidate
  maximizing the existing quality-tier predicate. Existing strategies
  and the empty-text/`selection` paths are byte-unchanged (zero
  regression when Readability declines).
- **Rejected:** Trafilatura (Python — violates local-first/ESM, needs a
  sidecar runtime).
- **Loci:** `sidetrack-extension/src/pageContent/extraction.ts`,
  `package.json` (readability, Apache-2.0, no transitive deps).
- **Verification:** extension typecheck/build clean; ensemble +
  fallback unit tests.
- **Deferred:** Readability denoises semantic markup, not bare
  non-semantic `<div>` soup (library limitation, documented).

### R1b — learned gray-zone quality scorer  (`be9a7d08`)
- **Intent:** keep deterministic must-reject/must-accept; improve only
  the ambiguous medium/low boundary.
- **Decision:** hard floor + `high` tier kept **byte-identical**; an
  injectable `GrayZoneScorer` handles medium-vs-low and **defaults to
  the existing rule when no model is present** → default behavior
  provably unchanged. Offline LightGBM training entry mirrors the
  ranker's pattern; corrupt/non-finite model → rule fallback.
- **Rejected:** replacing the rule gate wholesale (loses deterministic
  safety); a new ML dep (reused existing `@wlearn/lightgbm`).
- **Loci:** `sidetrack-companion/src/page-content/quality.ts`,
  `qualityScorer.ts`, `qualityScorerTrain.ts`.
- **Verification:** 100-case input-grid parity vs the prior classifier;
  model-gate + stub-booster + train→load→predict tests.
- **Deferred:** not yet wired into the page-content store (call site
  still uses the rule default — activation is a one-line follow-up).

### R2 — hybrid retrieval hardening  (`410c56d5`)
- **Intent:** better Search / Why-Related / Context-Pack ordering and
  explainability.
- **Decision:** add a **bounded** quality-tier tiebreak to RRF
  (centered on `medium` so equal/absent tiers contribute exactly 0 —
  RRF byte-identical; weight calibrated to overturn only a 1-rank
  insertion-order artifact, never a ≥2-rank relevance lead) + per-hit
  `explain` (vector/lexical rank, fusion, freshness, quality). Vector-
  only fallback preserved exactly. No index-format bump.
- **Rejected:** Tantivy/FAISS swap — the hybrid already exists; swapping
  engines is a native-dep migration with no capability gain.
- **Loci:** `sidetrack-companion/src/recall/ranker.ts` (+ chunk
  metadata passthrough).
- **Verification:** recall suite green; quality-tiebreak/explain/
  fallback tests.
- **Deferred:** no production writer yet *populates* chunk quality
  (type/plumbing wired; page-content lane can set it with zero ranker
  change).

### R3 — drift / evaluation layer  (`799a8c4d`)
- **Intent:** detect extraction/embedding/topic/ranker decay instead of
  guessing; turn the candidate-revision harness into a continuous loop.
- **Decision:** pure-TS **ADWIN** + **KSWIN** + **temporal silhouette**
  over the *existing* diagnostic series (similarity/topic/snapshot
  counts; shadow churn/noise/edge/size deltas), invoked per drain via
  `attachDriftReport`. All persistence is atomic + wrapped — the drift
  layer can **never fail the drain** (matches the diagnostics
  observability contract). KSWIN uses a deterministic reference
  subsample (drains must be reproducible); alpha tuned by probe to
  avoid stationary false positives.
- **Rejected:** a streaming-ML dependency (River, Python) — the
  detectors are ~200-line classic algorithms.
- **Loci:** `sidetrack-companion/src/connections/drift/*` + minimal
  wiring in `materializerDiagnostics.ts` and one call site in
  `connectionsMaterializer.ts`.
- **Verification:** 42 algorithm tests (stationary→no false positive,
  abrupt/gradual→detect); full wiring suite green; never throws.
- **Deferred:** alarm thresholds emit status only (no auto-action) —
  intentional; action is a policy decision.

### R4 — Louvain candidate topic revision  (`0c3d0617`)
- **Intent:** measure grouping alternatives against the active
  `idf-rkn-split` baseline — never replace it blindly.
- **Decision:** deterministic Louvain over the existing `graphology`
  similarity graph, registered as a **named measured candidate** via
  the existing `topicAlgorithmComparison` harness (same path
  HDBSCAN/idf-rkn-split use). Never on the active/served path;
  stable topic ids across runs.
- **Rejected:** River/CluStream/BERTopic (Python); adding
  `graphology-communities-louvain` (lockfile/network — implemented
  Louvain in-repo over the present `graphology`).
- **Loci:** `sidetrack-companion/src/connections/graphCommunityClusterer.ts`,
  `topicAlgorithmComparison.ts`.
- **Verification:** determinism + harness-integration tests; asserts
  `readActiveRevision()` stays untouched.
- **Deferred:** single-level Louvain (consistent with the existing
  single-level `leidenLikePartition`); multi-level aggregation later.

### R5 — LTR ranker expansion  (`9f09492f`, integ-fix `d0630a55`)
- **Intent:** richer relevance via lineage + quality signals.
- **Decision:** **append** (never reorder/remove) `same_active_topic`,
  `topic_lineage_merge_split_related`, `page_quality_tier_{from,to}`;
  bump `FEATURE_SCHEMA_VERSION`/`RANKER_MODEL_VERSION`; a stale
  (old-width) persisted model fails the manifest gate → callers retrain
  rather than feed a mismatched booster. Integration fix: imports must
  source `PAGE_CONTENT_EXTRACTED`/`PageContentQuality` from the
  canonical `page-content/types.ts`; `noUncheckedIndexedAccess` safe
  default.
- **Rejected:** broadening beyond `closest_visit` edges this pass
  (scope/regression risk — documented follow-up).
- **Loci:** `sidetrack-companion/src/ranker/{features,feature-schema,train,predict}.ts`,
  `producers/closest-visit-revision.ts`.
- **Verification:** ranker suite green; back-compat + train-smoke tests;
  integrated typecheck clean.
- **Deferred:** ranking topic/relatedness/context-pack orderings (only
  `closest_visit` today).

### R6 — defer ColBERT / WebQuality  ([ADR-0003](../adr/0003-defer-colbert-and-multimodal-quality.md), `4bfde7d5`)
- **Decision:** keep both off the deterministic, local-first hot path;
  revisit only via measured R3 triggers, as opt-in candidate revisions.
  Full rationale + trigger conditions in the ADR.

## Verification summary

| Surface | Result |
|---|---|
| Companion typecheck / build | clean |
| Companion suite | **1177 pass / 2 skip / 1 pre-existing flake** (163 files) |
| Extension typecheck / build | clean |
| Extension tests (R1a) | green |
| Drift module | 42 tests; full R3 wiring suite green |

## Known issues & follow-ups

- **Pre-existing flake (not a regression):** `tabsession/resolver.test.ts`
  "deterministic signed PPR" fails only when its 10-test file runs under
  load. `causalPpr.ts` is byte-identical to `main`; no commit here
  touches PPR source; the single test passes 2/2 in true isolation. It
  is an intra-file test-isolation weakness on `main` itself — fix
  separately as test hygiene.
- **Documented deferrals** (sensible, not gaps): R1b store wiring; R2
  quality producer; R5 beyond `closest_visit`; R4 multi-level Louvain.
- **Engineering note:** built across six isolated parallel subagents;
  one hit a worktree-isolation hiccup (Bash cwd resetting to the primary
  tree) that was detected and fully remediated — no contamination
  remains; the deliverable is solely on this branch.

## Decision records

- [ADR-0003](../adr/0003-defer-colbert-and-multimodal-quality.md) —
  defer ColBERT / WebQuality (rank 6).
- Candidates for follow-up ADRs (decisions of record embodied here, not
  yet formalized): "harden RRF, do not adopt Tantivy/FAISS" (R2);
  "topic alternatives are measured candidates, never blind active
  swaps" (R4); "deterministic rule gate + optional learned gray-zone,
  never a pure learned gate" (R1b).

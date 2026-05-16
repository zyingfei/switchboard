# `closest_visit` Ranker — Code-Grounded Leakage Diagnosis & Remediation Plan (2026-05-16)

> **Status:** Diagnosis + plan only. **No ranker fix is implemented in
> this PR.** The remediation steps below are deliberately left
> un-started pending review of this diagnosis.
>
> **Scope of this PR:**
> 1. This document — a source-verified diagnosis and an ordered
>    remediation plan.
> 2. The dogfood evidence it analyzes:
>    [`ranker-snapshot-diagnostics-2026-05-16.md`](./ranker-snapshot-diagnostics-2026-05-16.md).
> 3. Preserved diagnostics-visibility instrumentation that was stranded
>    as uncommitted WIP in the `codex/ranker-snapshot-diagnostics`
>    worktree (8 files: `materializerDiagnostics`, `workGraphHealth`,
>    `closest-visit-revision`, `connectionsMaterializer`, e2e helpers).
>    That instrumentation is observability, not the ranker fix.
>
> **Base:** branched from `origin/main` (`d13e9f25`), which is the
> post-PR-#176 **v2** tree (`lightgbm-lambdamart-v2`,
> `FEATURE_SCHEMA_VERSION = 2`) — i.e. the exact code that produced the
> audited snapshot. Anchors below are valid on this branch.

All file:line anchors are repo-relative and refer to the v2 tree on
this branch.

---

## 1. TL;DR verdict

An earlier analysis was done **without source access** and concluded
"label leakage, almost certainly derived from workstream membership."
Reading the source **confirms that diagnosis and makes it stronger**,
but also shows two of that analysis's prescriptions are wrong *because*
they were inferred from aggregates:

- **Root cause is one function.** `closest_visit` positive training
  labels are the **full ordered-pair closure of every user-organized
  workstream**, synthesized by `deriveVisitPairLabelsFromSnapshot`
  (`packages/sidetrack-companion/src/ranker/retrain.ts:68-107`) and
  merged into the feedback projection at `retrain.ts:825`. A feature
  in the vector (`user_asserted_in_workstream`) is **definitionally
  the same predicate** as that label rule. This is textbook target
  leakage, proven by reading both functions — not inferred.
- **It is worse than "leakage dilutes a good signal."** Every
  candidate that is *not* a workstream-closure positive and *not* a
  random/rejected negative is **silently discarded from training**
  (`relevanceForCandidate` returns `null`, `train.ts:202-203`; row
  dropped at `train.ts:215-216`). The model never sees embedding /
  search-query / snippet-lineage relatedness as a gradable example. It
  is structurally incapable of learning the very thing `closest_visit`
  exists for.
- **Serving is exonerated.** Pass 12 uses the full 12-source candidate
  generator at serve time
  (`packages/sidetrack-companion/src/connections/snapshot.ts:2812`).
  The 596/596 same-workstream / 0 net-new result is the *trained
  scorer* ranking workstream pairs to the top of a genuinely diverse
  pool and `topK = 5` truncating the rest — **not** serve-time
  candidate starvation.
- **Single highest-leverage fix:** stop minting positives from
  workstream closure. Everything else in the plan is downstream of
  that.

---

## 2. The mechanism, proven (the leakage chain)

The training set is **constructed**, not merely biased. The chain,
end to end:

### 2.1 Positives = pairwise closure of user-organized workstreams

`deriveVisitPairLabelsFromSnapshot`
(`ranker/retrain.ts:68-107`) walks `visit_instance_in_workstream`
edges whose `producedBy.eventType === USER_ORGANIZED_ITEM`, groups
canonical URLs by workstream, and emits **`a→b` and `b→a` for every
URL pair within each workstream**, `weight: 1`. It is merged into the
feedback projection by `augmentFeedbackWithVisitPairLabels` at
`maybeRetrainClosestVisitRanker` (`ranker/retrain.ts:824-825`):

```ts
const baseFeedback = projectFeedback(merged);
const feedback = augmentFeedbackWithVisitPairLabels(baseFeedback, snapshot);
```

The function's own header comment (`retrain.ts:54-67`) states *why*
it exists: the genuine feedback labels are shaped `(url →
workstreamId)` and fail `candidateResolvesToTimelineVisits` at train
time, so visit→visit positives were **manufactured from workstream
closure as a workaround**. The circular label is designed-in, not
accidental correlation.

This is O(n²) in workstream size: a 40-visit workstream contributes
~1,560 ordered positive pairs.

### 2.2 The feature is the label rule

`userAssertedInWorkstreamFeature`
(`ranker/features.ts:1099-1114`) returns 1 iff the from/to visits
share a user-asserted workstream, where the workstream map is built by
`buildUserAssertedMaps` (`ranker/features.ts:614-653`) from the **same
`USER_ORGANIZED_ITEM` workstream membership** used to mint the label.
`extractFeatures` emits it at `ranker/features.ts:1203`. Feature ≡
label-generating predicate ⇒ a single binary feature perfectly
predicts the label by construction.

### 2.3 Non-workstream candidates are dropped from training

`relevanceForCandidate` (`ranker/train.ts:193-204`):

```ts
if (positive > negative) return Math.min(4, Math.max(1, Math.round(positive)));
if (negative > 0 || candidateHasImplicitNegativeSource(candidate)) return 0;
return null;            // ← neither labelled positive nor an implicit negative
```

`buildRankerTrainingRows` discards `null` rows
(`ranker/train.ts:215-216`: `if (label === null) continue;`).
`candidateHasImplicitNegativeSource` is only `random_unrelated` /
`recently_skipped` (`ranker/train.ts:188-191`). Net effect: the
training set is exactly **{workstream-closure positives} ∪
{random/rejected negatives}**. Embedding-neighbor, shared-search,
copied-snippet, same-repo candidates with no explicit feedback get
`null` → excluded. The model cannot under-weight them; it never sees
them.

### 2.4 Negatives are the easiest possible, and imbalance is structural

`randomUnrelated` (`ranker/negatives.ts:171-197`) samples visits with
**no graph edge at all** to the source visit (it filters out
`connectedVisitIds`). `addRandomNegativeCandidates`
(`ranker/retrain.ts:698-728`) draws a constant
`DEFAULT_RANDOM_NEGATIVES_PER_POSITIVE_FROM = 5`
(`ranker/retrain.ts:30`) **per from-visit**.

So positives scale as Σ(workstream size²) while negatives scale
linearly in from-visits. The 2,698 : 497 imbalance in the audit is a
**scaling law, not a tunable** — and it gets *more* lopsided the more
the user organizes.

### 2.5 NDCG@5 = 1.0 is a tautology, not a quality signal

`groupUsableRows` (`ranker/train.ts:228-252`) keeps only query groups
with ≥2 rows **and ≥2 distinct labels** — i.e. groups containing both
a workstream positive and a random negative. That two-class set is
linearly separable by the one leaked binary feature, so in-sample
NDCG@5 = 1.0 for *any* model. The metric is explicitly documented as
**not held-out** (`ranker/train.ts:56-64`); there is no train/test
split anywhere in the pipeline.

### 2.6 Serving uses the full candidate pool (so this is a scorer defect)

Pass 12 (`connections/snapshot.ts:2784-2879`) calls
`generateCandidates(fromVisitKey, …)` — all 12 sources
(`snapshot.ts:2812`) — extracts features, calls `ranker.predict`,
filters by `threshold` (0.3), sorts by score, and `slice(0, topK)`
with `topK = 5` (`snapshot.ts:2792`, `2847-2853`). The diverse
candidates *are* in the pool; the trained scorer simply ranks the
leaked-feature pairs to the top and `topK` discards the rest. The
audit's "lowest emitted score ≈ 2.30 ≫ threshold 0.3" confirms the
threshold is irrelevant; the defect is ordering, caused entirely by
§2.1–§2.4.

---

## 3. Reconciliation with the no-source analysis

### Confirmed by source

| Claim (no-source) | Source verdict |
|---|---|
| Three-way leak: candidate + feature + label | **Confirmed.** `addFeedbackLabelCandidates(candidates, feedback.positiveLabels, 'same_workstream', …)` (`retrain.ts:753-759`) tags every positive pair with source `same_workstream`; feature §2.2; label §2.1. |
| Labels derived from workstream membership | **Confirmed and stronger** — full pairwise closure, deliberately added (§2.1). |
| PR #176 added features cannot help | **Confirmed mechanistically.** R5 features (`features.ts:1204-1207`) appear only as low-order tie-breakers (audit: `page_quality_tier_to` top-3 93.5%, dominant ~0%); boosting never needs to split on them because the leak feature already separates the degenerate set. |
| No held-out eval | **Confirmed** (§2.5). |
| `closest_visit` redundant with `visit_in_workstream`; double-counts in PPR/resolver | **Confirmed** — it carries the same predicate as the workstream membership edge. |
| Recorder artifacts pollute training (12.8%) | **Confirmed** — no artifact filter exists; only the structural `candidateResolvesToTimelineVisits` check. |

### Corrected by source (the value of having read it)

1. **"Drop to logistic regression first to see if there's signal"** —
   misleading on the current construction. LR on
   {workstream-positive vs disconnected-random-negative} also scores
   NDCG ≈ 1.0 with the same single dominant coefficient. LR is **not a
   diagnostic here** and would return a false green light. Fix the
   training-set construction first; *then* LR-with-ablation is a
   meaningful baseline.
2. **"Remove `same_workstream` from candidate sources"** — wrong at
   serving, and serving is where it would be applied. The serve-time
   pool is already diverse (§2.6); trimming sources starves a healthy
   pool. The change belongs in **training label/feature
   construction**, never in serving candidate generation.
3. **"Reframe as contrastive / metric learning"** — premature, not a
   separate lever. It needs the orthogonal labels that do not yet
   exist; same blocker as everything else.

### New finding the no-source pass could not reach

The genuine visit→visit supervision in the codebase is only
`USER_FLOW_CONFIRMED` (`feedback/projection.ts:295`) and
`USER_SNIPPET_PROMOTED` (`feedback/projection.ts:336`). The
`USER_ORGANIZED_ITEM` path produces `(url → container)` labels
(`projection.ts:177-205`) that cannot resolve to visit pairs — which
is precisely why §2.1 was bolted on. **There is no shortcut: the
honest options are real supervision or scope `closest_visit`
down/off.**

### The instrumentation already caught it

`RankerTrainQuality` (`ranker/train.ts:30-65`) was built to detect
"every score identical" degeneracy. The audited revision shows
`distinctRatio = 0.0271`, `p50 == p95` — the detector fired. The
failure was not lack of observability; it was reading the signal as
"useful but narrow" (evidence doc §6) instead of a leakage
stop-ship.

---

## 4. Remediation plan (ordered; NOT started in this PR)

Each step lists the anchor to change, the rationale, and how to
validate. Steps are dependency-ordered: 1 is the highest leverage and
unblocks the rest.

1. **Stop minting positives from workstream closure.**
   Neuter `deriveVisitPairLabelsFromSnapshot` /
   `augmentFeedbackWithVisitPairLabels` as a *positive-label* source
   (`ranker/retrain.ts:68-107`, `:824-825`). Optionally retain it as a
   *candidate* generator only — never as a label.
   *Validate:* retrained positive-label count drops from O(Σ size²) to
   the count of genuine `USER_FLOW_CONFIRMED` / snippet-promotion
   labels.

2. **Stop the silent null-drop of unlabeled candidates.**
   `relevanceForCandidate` / `buildRankerTrainingRows`
   (`ranker/train.ts:193-204`, `:215-216`). Decide explicitly per
   non-workstream candidate source: bring it in with a real label, or
   accept there is no supervision and do not ship a learned edge that
   claims there is.

3. **De-leak the feature vector for this scorer.**
   Remove `user_asserted_in_workstream` and `same_workstream` from
   `RANKER_FEATURE_KEYS` (`ranker/train.ts:100-125`) and
   `extractFeatures` (`ranker/features.ts:1186`, `:1203`). Downstream
   consumers that need workstream evidence already have the
   `visit_in_workstream` edge; `closest_visit` must be **independent**
   evidence or it double-counts in PPR / the resolver.

4. **Define the real label.** Seed from `USER_FLOW_CONFIRMED`
   (`feedback/projection.ts:295`) and `USER_SNIPPET_PROMOTED`
   (`:336`). If volume is too low to train, that is the true state of
   the world — **scope `closest_visit` down or off** until real
   supervision exists rather than synthesize it.

5. **Mine hard negatives.** Replace sole reliance on graph-disconnected
   `randomUnrelated` (`ranker/negatives.ts:171-197`) with
   same-workstream-but-user-split and high-similarity-but-rejected
   pairs, so the decision boundary is non-trivial.

6. **Add held-out evaluation.** Time-split (train ≤ T, evaluate > T).
   **Do not gate on NDCG of the current construction** — it is 1.0 by
   construction for any model, including LR.

7. **Filter recorder/test artifacts** before training (no filter
   exists today). Real but low-order next to steps 1–4; do it, but it
   is not the cause.

**Do not** merge anything expecting PR #176's R5 features to help
until steps 1–3 land — they have no gradient to flow through while the
leak feature perfectly separates the training set.

---

## 5. Acceptance criteria for the (future) fix PR

A subsequent implementation PR should demonstrate, on a fresh dogfood
retrain + snapshot audit:

- Positive labels no longer scale with workstream size² (step 1
  landed).
- `user_asserted_in_workstream` / `same_workstream` absent from the
  feature vector (step 3).
- Held-out (time-split) ranking metric reported; in-sample NDCG no
  longer used as the gate (step 6).
- Emitted `closest_visit` edges: a non-zero share of strictly net-new
  relations (not same-workstream / not already
  `visit_resembles_visit` / not same URL-domain-repo), measured by the
  same audit harness used for the evidence doc.
- Contribution distribution no longer dominated by a single
  workstream-identity feature.

---

## 6. Non-goals of this PR

- No change to ranker training, candidate generation, feature schema,
  or serving.
- No model retrain.
- The preserved instrumentation changes are observability only; they
  do not alter ranker scoring (feature schema version is unchanged).

---

## Appendix — anchor index (v2 tree, this branch)

| Concern | Anchor |
|---|---|
| Workstream-closure positive labels | `ranker/retrain.ts:68-107` |
| Closure merged into feedback | `ranker/retrain.ts:824-825` |
| Positive labels tagged `same_workstream` | `ranker/retrain.ts:753-759` |
| Random negatives, 5 per from-visit (const) | `ranker/retrain.ts:30`, `:698-728` |
| `relevanceForCandidate` null-drop | `ranker/train.ts:193-204`, `:215-216` |
| Usable-group filter (≥2 distinct labels) | `ranker/train.ts:228-252` |
| In-sample-only metric (documented) | `ranker/train.ts:56-64` |
| Feature key list incl. leak + R5 | `ranker/train.ts:100-125` |
| `user_asserted_in_workstream` feature | `ranker/features.ts:1099-1114` |
| User-asserted workstream map builder | `ranker/features.ts:614-653` |
| `extractFeatures` emission | `ranker/features.ts:1181-1208` |
| Disconnected random negatives | `ranker/negatives.ts:171-197` |
| Genuine visit→visit positives | `feedback/projection.ts:295`, `:336` |
| `(url → container)` labels (unusable as pairs) | `feedback/projection.ts:177-205` |
| Serving Pass 12 (full candidate pool) | `connections/snapshot.ts:2784-2879` |
| Degeneracy detector that fired | `ranker/train.ts:30-65` |

Paths are under `packages/sidetrack-companion/src/`.

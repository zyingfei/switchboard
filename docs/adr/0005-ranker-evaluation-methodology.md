# ADR-0005 - Ranker evaluation methodology is mandatory and model-orthogonal

- Status: Accepted
- Date: 2026-05-16
- Owner: User + Claude
- Components: Shared
- Related: PR #179, PR #181, PR #182, PR #183, ADR-0003, ADR-0004

## Context

The `closest_visit` ranker failed because its positive label
definition and one of its features encoded the same predicate:
user-organized workstream membership. A model trained on that
construction could score perfectly in-sample and could also pass a
vanilla train/test split, because the leak was in the label definition
rather than in the model fit.

PR #179 documented the leak and remediation plan. PR #181 removed the
direct workstream-closure label path and de-leaked the model feature
vector. PR #182 clarified the evaluation methodology, and PR #183
implements the methodology spine/probes. This ADR records the
architectural decision those PRs converge on: learned rankers cannot be
promoted by model metrics alone; the evaluation method is a separate
required primitive.

This is distinct from the R3 drift sidecar. R3 observes diagnostic
series and does not gate output. Ranker evaluation compares supervised
labels to predicted ordering under per-user temporal splits and can
gate whether a learned scorer is eligible to ship.

## Decision

All Sidetrack learned rankers must have a model-orthogonal evaluation
spine before they can become active.

For `closest_visit`, and for future learned ranking heads, the spine
must include:

- per-user forward-chaining time-split evaluation;
- a reserved test slice that is not used for model selection or tuning;
- explicit label-leakage probes, including feature-ablation,
  label-permutation, and a novel-pair slice;
- candidate-label accounting that makes unlabeled rows visible rather
  than silently dropping them;
- a deterministic or simpler-model baseline that a learned model must
  beat before graduation;
- persisted diagnostics sufficient to explain why a ranker is active,
  gated off, or correctly silent.

Vanilla held-out NDCG is not an acceptable ship gate when the failure
class is a label-definition tautology. A learned model graduates only
when the methodology spine shows that it beats the chosen baseline on
non-leaky supervision. The evaluation spine is independent of model
class: it applies to deterministic scorers, logistic models, tree
rankers, and future learned heads.

## Options considered

### Option A - Continue with model-level metrics only

Pros:

- Minimal implementation work.
- Preserves the existing training loop shape.

Cons:

- Cannot detect label-definition leakage.
- Allows a tautological model to pass with perfect train/test metrics.
- Repeats the #179 failure mode.

### Option B - Add only a vanilla held-out split

Pros:

- Better than in-sample-only metrics.
- Cheap to implement and explain.

Cons:

- Still cannot catch a stable feature/label tautology.
- Can falsely certify a leaked model when membership labels are stable
  across the time split.

### Option C - Require a methodology spine with leakage probes

Pros:

- Detects both model overfitting and label-definition contamination.
- Separates model choice from evaluation methodology.
- Creates a reusable promotion contract for future learned scorers.
- Keeps deterministic baselines viable until learned models earn their
  place.

Cons:

- Adds evaluation complexity and retrain cost.
- Requires enough genuine supervision to pass; otherwise the correct
  result may be a silent or gated-off learned ranker.

## Consequences

Positive:

- Learned rankers cannot ship merely because they fit leaked labels.
- "Correctly silent" becomes an auditable state rather than a guess.
- Future ranker work has a shared promotion contract instead of a new
  bespoke metric per model.

Negative:

- Some learned models will remain inactive until the user creates
  enough genuine positive and negative supervision.
- Training can take longer because the methodology spine may train
  baselines, controls, and tuning candidates.
- Health diagnostics must expose gate status and reasons, or operators
  cannot distinguish a safe block from a broken pipeline.

## Extension model

Future learned heads add their own candidate and feature construction,
but reuse the same evaluation contract: per-user temporal split,
reserved test, leakage probes, baseline comparison, and persisted gate
diagnostics. New probes can be added to the spine, but they do not
replace the required baseline set unless a later ADR supersedes this
decision.

## Security and operations impact

The decision does not add new browser permissions or remote services.
It affects local companion operations by making ranker diagnostics and
gate state part of the health surface. Implementations must avoid
logging raw page bodies; persist aggregate metrics, feature/probe
status, revision IDs, and label counts.

## Follow-ups

- [ ] Surface `methodologySpine.shipGate.status` and `.reason` in
      work-graph health diagnostics before enforcing a fail-closed
      load-time ship gate.
- [ ] Add a cheap preflight for "no usable query group with both
      positive and negative labels" before LightGBM/tuning work starts.
- [ ] Generalize the feature-provenance invariant into CI before
      future learned rankers are added.

# `closest_visit` Ranker — Next-Step Plan: the Methodology Spine (2026-05-16)

> **Status:** Plan only. No implementation, no model retrain. This
> doc *sequences* work; it does not start it.
>
> **Builds on:**
> [`ranker-closest-visit-leak-diagnosis-and-plan-2026-05-16.md`](./ranker-closest-visit-leak-diagnosis-and-plan-2026-05-16.md)
> (the leakage diagnosis; PR #179). Stacked on that branch so both
> docs are co-present.
>
> **Inputs reconciled here:** a Claude deep-research discussion on eval
> methodology vs. model choice, plus the repo's locked architecture
> ([ADR-0003](./adr/0003-defer-colbert-and-multimodal-quality.md), the
> evolution proposal's Northern Star, the R3 drift sidecar contract).

---

## 1. What the deep-research input got right (adopt it)

The diagnosis plan (PR #179) treated held-out evaluation as remediation
**step 6** — almost an afterthought behind the label fix. The
deep-research input correctly argues that is an ordering error of its
own: **eval methodology and model choice are orthogonal, and the
methodology has to exist from day one regardless of model.** Adopt
this in full:

- **Methodology is always on; you graduate the model when methodology
  says you can.** A deterministic or hand-set log-LR scorer still has
  held-out performance — you just don't tune it. The metrics decide
  *when* to move from deterministic → learned, not the other way
  round.
- **Time-split, not random K-fold.** Forward-chaining: train on visits
  ≤ T, evaluate on (T, T+Δ]. Random split leaks future into past on
  temporal data. (~20 lines; no library.)
- **A reserved test slice that no model selection ever touches.**
  Validation slice tunes hyperparameters; test slice is ship/no-ship
  only. Otherwise multi-round selection silently overfits the gauge.
- **Per-user evaluation, not cross-user.** Sidetrack is single-user
  (AGENTS.md / Northern Star: *user organization is authoritative*).
  The question is "does this user's week-N behavior predict their
  week-N+1 attribution decisions," not cross-user generalization.

This is the **methodology spine**. The diagnosis plan's model
guidance (deterministic + hand-set log-LR → regularized LR →
trees-only-if-earned) is the **model spine** and is unchanged. Both
must be present; PR #179 under-weighted the first.

## 2. The one thing to correct (a load-bearing tension)

The deep-research input contradicts itself on a point that, if shipped
naively, wastes the whole effort:

- It says: *"Even on the current broken construction, a held-out
  time-split will surface that held-out performance ≠ in-sample
  performance."*
- It also says: *"The Sidetrack ranker would happily pass any
  train/test split with NDCG=1.0 on both halves, because the leak is
  in the label definition, not in the model fit."*

**The second statement is correct; the first is false for this leak.**
This must be stated unambiguously in the plan, because an
implementer who builds the time-split harness, runs it on today's
construction, and sees the expected "held-out ≪ in-sample" gap will
instead see **NDCG ≈ 1.0 on both halves** and may wrongly conclude
"no overfitting → fine."

Why vanilla held-out cannot catch this leak:

> The leak is a label-*definition* tautology. The positive label is
> "the two visits share a user-asserted workstream"
> (`ranker/retrain.ts:68-107`) and the feature
> `user_asserted_in_workstream` (`ranker/features.ts:1099-1114`) is
> the *same predicate*. Workstream membership is temporally stable —
> a visit's workstream assignment does not change across the T split
> boundary. So on (T, T+Δ] the feature still equals the label.
> Held-out NDCG ≈ 1.0, not random.

Two distinct failure modes, only one of which vanilla held-out sees:

| Failure mode | Held-out signature | Caught by vanilla time-split? |
|---|---|---|
| Model overfitting (variance) | held-out ≪ in-sample | **Yes** |
| Label-definition contamination (tautology) | held-out ≈ in-sample ≈ perfect | **No** — needs leakage probes |

`RankerTrainQuality.inSampleMetric` is documented as *not* held-out
(`ranker/train.ts:56-64`); adding a held-out number is necessary but
**not sufficient**. The instrument has to include leakage probes, or
it will rubber-stamp the tautology.

## 3. The leakage probes (what makes the spine actually diagnostic)

These convert "held-out eval" into "eval that catches a
label-definition tautology." All four are part of the spine, not the
model:

1. **Feature-ablation control.** Retrain with
   `user_asserted_in_workstream` + `same_workstream` removed
   (`ranker/train.ts:100-125`). Today: held-out collapses toward
   random ⇒ the model had *only* the leak feature (leak signature).
   Post-relabel: held-out should *survive* ablation ⇒ other features
   carry real signal.
2. **Label-permutation test.** Retrain on permuted labels
   (Ojala–Garriga). If held-out stays high under permutation, the
   eval/feature wiring still leaks. A correct pipeline scores ≈ chance
   under permutation.
3. **Novel-pair held-out slice.** Evaluate only on pairs whose
   relatedness comes from a signal *independent of workstream
   closure* — `USER_FLOW_CONFIRMED` (`feedback/projection.ts:295`),
   snippet lineage (`:336`). On today's construction this slice is
   **≈ empty** — and that emptiness *is* the finding: there is no
   supervision that is not workstream closure. Post-relabel it becomes
   the real ship gate.
4. **Pinned negative control.** Keep one run of *today's* construction
   through the new harness as a fixed reference. Its 1.0/1.0 is the
   control reading. Relabeling is "doing real work" only when probe 3's
   slice becomes non-empty and beats a deterministic baseline on it —
   **not** when in-sample NDCG moves (it can't; it's already 1.0).

This resolves the tension: the spine *is* built first (the
deep-research input's valid point), but its output is interpreted as a
**known-degenerate control until labels are clean** — the gauge reads
"tautology," and that reading, expected and paired with probe 3, is
how you'll know relabeling worked.

## 4. This spine is NOT the R3 drift sidecar

Architectural clarification, to prevent a "we already have R3, we're
covered" error:

| | R3 drift/eval (PR #176, `connections/drift/*`) | Methodology spine (proposed) |
|---|---|---|
| Observes | existing diagnostic *series* (similarity/topic/snapshot counts, shadow churn/noise/edge/size deltas) | held-out ranker ranking quality on per-user time-split + leakage probes |
| Gates output? | **Never** — observe-only, *"never gates output, never fails/delays the drain"* | **Yes** — ship/no-ship for any future learned head |
| Sees ranker generalization? | **No** — it watches drain-level series, not label-vs-prediction | **Yes** — that is its entire job |

R3 is a drift *detector* over telemetry. The spine is a ranker
*evaluator*. ADR-0003's principle — *"drift/evaluation decides when
opinions need replacement"* — is satisfied for the ranker only once
this spine exists; R3 alone cannot satisfy it for `closest_visit`.

## 5. Repo-lock grounding (corrections the deep-research input could not make)

The deep-research input had no repo access. Two of its suggestions
need repo-aware constraints:

- **"Embeddings as fixed features (Sentence-BERT, run once per
  doc)."** Correct in shape, but the embedder must be the
  **embedding stage that already exists** in the pipeline
  (`capture → … → embedding → topics → ranker`); `cosine_similarity`
  is *already* a `closest_visit` feature
  (`ranker/features.ts:1196`). Reuse it. Introducing Sentence-BERT as
  a new runtime would violate ADR-0003 + the Northern Star
  (*no default-path inference requires GPU / Apple-Silicon; local-
  first, ESM, no Python/Rust*). "Embeddings-as-features" here means
  *richer use of the existing local vectors*, not a new model
  dependency.
- **Model graduation** (deterministic → regularized LR → trees) must
  enter via the repo's established **measured-candidate-revision**
  pattern (how `idf-rkn-split`, Louvain R4, the gray-zone scorer R1b
  all landed): never a blind active swap; promoted only by a
  separate evidence-backed decision. The spine is exactly the evidence
  that pattern requires.

## 6. Corrected sequence (supersedes PR #179 §4's flat 1–7 list)

PR #179's plan ordered the *label* fix correctly but listed eval as
step 6. Re-cast as phases; the spine is **Phase 0**, parallelizable
now, dependency-free:

- **Phase 0 — Build the methodology spine (no label dependency; start
  now).** Per-user forward-chaining time-split harness + reserved
  untouched test slice + the four §3 probes + pin today's construction
  as the negative control. Pure-TS, no new deps; mirrors R3's
  "never fails the drain" persistence contract but as an *evaluator*,
  not a sidecar.
- **Phase 1 — Clean labels** (PR #179 §4 steps 1–4: kill
  workstream-closure positives `retrain.ts:68-107,:824-825`; stop the
  null-drop `train.ts:193-204,:215-216`; de-leak features
  `train.ts:100-125`; define the real label from
  `USER_FLOW_CONFIRMED`/snippet `projection.ts:295,:336`). Each
  sub-step is *proven* by the Phase 0 probes (novel-pair slice goes
  empty→populated; ablation flips; permutation starts scoring
  ≈chance).
- **Phase 2 — Model choice.** Only now is held-out signal meaningful.
  Deterministic / hand-set log-LR baseline first; graduate to
  regularized LR over existing embedding + behavioral features, then
  trees, **only if** the now-trustworthy held-out eval says it earns
  its keep (ADR-0003 graduation principle).
- **Phase 3 — Tuning + ship gate.** CV hyperparameter search on the
  validation slice; the reserved test slice decides ship/no-ship,
  used exactly once per candidate.

Dependency order (deep-research input's chain, now precise):
**spine exists (Phase 0) → clean labels (Phase 1) → eval becomes
interpretable → model choice (Phase 2) → tuned ship gate (Phase 3).**
The spine is built before labels; its *reading* is load-bearing only
after them.

## 7. Recommended ADR-0004 (proposed text — decision of record)

Consistent with how this repo records decisions (ADR-0003; the
evolution proposal explicitly lists follow-up-ADR candidates), the
methodology/model orthogonality is a decision of record. Proposed,
**not** filed here (decider is User + Claude, per ADR convention):

> **ADR-0004 — Ranker evaluation methodology is mandatory, orthogonal
> to model choice, and built before the leak fix.**
> The `closest_visit` (and any future learned) ranker requires a
> per-user, forward-chaining time-split held-out evaluation with a
> reserved untouched test slice and label-leakage probes
> (feature-ablation, label-permutation, novel-pair slice). It is a
> distinct primitive from the R3 drift sidecar (which is observe-only
> and never gates). It is constructed independent of model choice and
> independent of the label fix, and its novel-pair slice is the
> graduation gate for moving deterministic → learned scoring. Vanilla
> held-out NDCG is explicitly **not** an acceptable gate on a
> label-definition tautology.

## 8. Non-goals (unchanged from PR #179)

- No change to training, candidates, feature schema, or serving.
- No model retrain.
- Phase 0 is evaluation infrastructure; it is not the leak fix and
  does not alter ranker scoring.
- ADR-0004 is *proposed* here, not filed — it needs the User+Claude
  decision step ADRs use.

## 9. Definition of done for Phase 0 (the only thing this plan unblocks)

A future Phase-0 PR is complete when, with **no change to the ranker
itself**:

- A per-user forward-chaining time-split + reserved test slice exists
  and is unit-tested (stationary → reproducible; the split never
  trains on the future).
- The four §3 probes run and are reported alongside in-sample metrics.
- Run against today's construction it reports the **expected control**:
  in-sample ≈ held-out ≈ NDCG 1.0, ablation→collapse,
  permutation→still-high (leak confirmed), novel-pair slice ≈ empty —
  and the harness *labels this as the degenerate control*, not a pass.
- The evaluator obeys the observability contract (atomic, wrapped,
  cannot fail/delay a drain), like R3.

That known-degenerate baseline is the instrument calibration. Phase 1
(label cleaning per PR #179) is what it then measures.

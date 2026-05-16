# `closest_visit` Ranker — Follow-ups / TODO Tracker (2026-05-16)

> **Purpose:** single accurate source of truth for what is **done** vs
> **outstanding** across the `closest_visit` leakage→methodology arc
> (#179 → #181 → #182 → #183). Status-tagged so the outstanding list
> is not polluted with completed work. Update this doc as items close;
> do not re-narrate the diagnosis (that is #179/#182).

## Status as of 2026-05-16 (verified against `origin/main` `c427fbd4`)

| PR | What | State |
|---|---|---|
| #179 | Diagnosis + remediation-plan doc | **MERGED → main** 07:10Z |
| #181 | Leak fix: closure→`[]`, positive tag `same_workstream→user_confirmed`, `RANKER_FEATURE_KEYS` de-leaked, model `v2→v3` / schema `2→3` manifest gate, `trainQuality.candidateLabeling`, held-out scaffold | **MERGED → main** 07:59Z |
| #182 | Methodology-spine plan doc (+ §0 reconciliation) | **OPEN** — base `ranker/closest-visit-leak-diagnosis` (merged via #179) |
| #183 | Methodology-spine impl: batch-stamp fix, 3-way forward-chaining split, deterministic baseline + L2 LR + label-permutation + num-round tuning, ship-gate diagnostics. **CV-4 resolved: load-time enforcement split out.** | **OPEN** — base `main` |
| #178 | Bun workspace adoption — **occupies ADR-0004** | MERGED → main (context) |

**Net:** the leak is gone on `main` (#181). The evaluator/ship-gate
diagnostics (#183) and the plan reconciliation (#182) are in review.
The CV-4 sequencing decision is made: merge #183 as diagnostics-only,
then land the fail-closed load-time gate as a tiny follow-up after
CV-1/CV-2 make gated-off state visible. Everything below is what
remains.

## Outstanding TODOs

| ID | Item | Type | Priority | Depends on | Owner |
|---|---|---|---|---|---|
| CV-1 | Surface `methodologySpine.shipGate.status`/`.reason` + split availability in #179 health/`workGraphHealth` diagnostics | code | **HIGH** | #183 | impl |
| CV-2 | Resolve retrain-state vs load-state mismatch before the split-out load-time gate lands (gate-blocked model reads as `null` while retrain-state says `trained` and `planRankerRetrain` skips `unchanged`) | behavior + observability | **HIGH** | #183 + CV-1 | impl + decision |
| CV-3 | Empirical dogfood validation: restamp makes the split fire; shipGate lands at expected status; `closest_visit` darkness is attributable via `shipGate.reason` | validation | **HIGH** | #183 + CV-1/CV-2 | User dogfood + verify |
| CV-5 | File the methodology/ship-gate ADR. **Not 0004** (Bun adoption owns 0004 via #178) — use next free index on `main`; supersedes #182's stale "ADR-0004" | decision / ADR | MED | CV-6 | User + Claude |
| CV-6 | Fix #182 doc: renumber proposed ADR off 0004; refresh §5 repo-lock grounding (predates Bun #178: "no Python/Rust, ESM-only" framing); update §0/§6 status now #181 merged | doc accuracy | MED | — | Claude (offered) |
| CV-7 | Re-point/rebase #182 onto `main` (its base `ranker/closest-visit-leak-diagnosis` merged via #179) so it can merge standalone | housekeeping | LOW | — | Claude |
| CV-8 | Hard negatives (#179 plan step 5, still open): negatives remain `random_unrelated`/`recently_skipped` only. More relevant now — the ship gate compares vs baseline/LR; trivially-easy negatives weaken the discriminative bar | code | MED | — | impl |
| CV-9 | #183 ablation is a **static attestation** (`status:'not-in-feature-vector'`), not the re-trained dynamic ablation #182 §3(1) envisioned — accept or upgrade | design | LOW | — | decision |
| CV-10 | #183 retrain is ~5–6× booster trainings (main + ≤3 tuning + permutation). Off warm path + fail-soft, acceptable; revisit gating the tuning grid behind a min-data threshold if retrain wall-time bites | perf | LOW–MED | #183 | impl / monitor |
| CV-11 | #183 novel-pair slice bundles `same_copied_snippet` (heuristic candidate) with `user_confirmed` (explicit feedback) as "independent supervision" — within the diagnosis spirit; revisit if it over-counts | design | LOW | — | decision |

## Closed / Decided

| ID | Resolution |
|---|---|
| CV-4 | **Decided: split.** PR #183 was amended to keep methodology-spine diagnostics, manifest normalization, model-choice probes, and dogfood notes, but remove non-pass ship-gate load-time enforcement from the serving path. Enforcement becomes a tiny follow-up after CV-1/CV-2 land. Evidence: PR #183 head `622c867d` and [`docs/ranker-v3-dogfood-verification-2026-05-16.md`](ranker-v3-dogfood-verification-2026-05-16.md). |

## Detail — the HIGH items

**CV-1 — make "dark by design" legible.** After #183 the ship gate
will be able to fail *closed* once the split-out load-time gate lands:
a non-`pass`/`unavailable` gate would make the model unloadable for
scoring (`readClosestVisitRankerRevision → null`). The reason currently
lives only inside `manifest.trainQuality.methodologySpine.shipGate`.
Without surfacing `shipGate.status`/`.reason` (and `split` status) in
the work-graph health / ranker-augmentation diagnostics preserved by
#179, an intentionally-gated-off ranker would be indistinguishable from
a silent regression. This is the operational safety net that must land
before the enforcement follow-up.

**CV-2 — close the state-machine loop before enforcement.** Once the
split-out gate is enforced at the *read* path,
`maybeRetrainClosestVisitRanker` may still have written retrain-state
and reported `trained`. With unchanged labels, `planRankerRetrain`
returns `unchanged` and never retrains, so a gate-blocked revision can
stay "active" in state but never load. Likely-correct *behavior*
(nothing to retrain until new supervision arrives), but the *state*
must be legible before enforcement lands: decide and implement how a
gate-blocked active revision is represented (distinct health state; no
retrain thrash; clear "needs more supervision, not broken").

**CV-3 — the empirical proof.** The whole arc's claim ("correctly
silent until a learned model earns its place") is unproven until a
real dogfood retrain on post-#183 code shows: candidate `generatedAt`
now varies (restamp works) → `timeSplitGroups` fires → `shipGate`
resolves to a concrete status → and if `closest_visit` emits nothing,
`shipGate.reason` explains exactly why. Until CV-3 passes, treat the
arc as implemented-but-unvalidated.

Dogfood note: one real-vault run was attempted on 2026-05-16 and is
recorded in #183. It confirmed the safe-block surface (`closest_visit`
stayed at `0`, stale v2/schema-2 model was rejected, forced retrain
found `62643` candidates), but it did **not** pass CV-3: the retrain
spent ~28m and failed with "ranker training requires at least one
query group with positive and negative labels." Keep CV-3 open until a
future run proves the split/gate path or makes the failure directly
attributable via CV-1 diagnostics.

## Closing rule

An item is removed from the table only when its change is **merged**
(code) or **filed/decided** (decision/ADR), with the closing PR/commit
noted inline. CV-3 is special: it is the gate that converts the whole
effort from "implemented" to "validated" — keep it open until a real
dogfood retrain confirms it.

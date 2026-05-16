# `closest_visit` Ranker — Follow-ups / TODO Tracker (2026-05-16)

> **Purpose:** single accurate source of truth for what is **done** vs
> **outstanding** across the `closest_visit` leakage→methodology arc
> (#179 → #181 → #182 → #183). Status-tagged so the outstanding list
> is not polluted with completed work. Update this doc as items close;
> do not re-narrate the diagnosis (that is #179/#182).

## Status as of 2026-05-16 (verified against `origin/main` `626de70a`)

| PR | What | State |
|---|---|---|
| #179 | Diagnosis + remediation-plan doc | **MERGED → main** 07:10Z |
| #181 | Leak fix: closure→`[]`, positive tag `same_workstream→user_confirmed`, `RANKER_FEATURE_KEYS` de-leaked, model `v2→v3` / schema `2→3` manifest gate, `trainQuality.candidateLabeling`, held-out scaffold | **MERGED → main** 07:59Z |
| #182 | Methodology-spine plan doc (+ §0 reconciliation) | **MERGED → main** 09:46Z |
| #183 | Methodology-spine impl: batch-stamp fix, 3-way forward-chaining split, deterministic baseline + L2 LR + label-permutation + num-round tuning, ship-gate diagnostics. **CV-4 resolved: load-time enforcement split out.** | **MERGED → main** 09:45Z |
| #184 | This follow-up tracker | **MERGED → main** 09:46Z |
| #185 | vNext implementation plan | **MERGED → main** 09:49Z |
| #186 | Ship-gate health diagnostics (`/v1/system/health` + work-graph health) | **MERGED → main** 10:01Z |
| #187 | Fast-fail `no-usable-query-groups` retrain preflight | **MERGED → main** 11:12Z |
| #178 | Bun workspace adoption — **occupies ADR-0004** | MERGED → main (context) |

**Net:** the leak is gone on `main` (#181), the methodology spine is
merged (#183), and CV-1/CV-2 health visibility is merged (#186). The
fail-closed load-time gate remains deferred. CV-3 has been attempted
on the real vault and has **not** passed: post-#186 retraining reached
`63864` candidates and `136` distinct labeled-row timestamps, but
produced `0` positive training rows and `0` usable query groups. #187
then made that failure shape fast and explicit:
`skipped:no-usable-query-groups` with `candidateCount: 0`.

## Outstanding TODOs

| ID | Item | Type | Priority | Depends on | Owner |
|---|---|---|---|---|---|
| CV-3 | Empirical dogfood validation: restamp makes the split fire; shipGate lands at expected status; `closest_visit` darkness is attributable via `shipGate.reason` | validation | **HIGH** | #183 + CV-1/CV-2 | User dogfood + verify |
| CV-13 | Decide legitimate positive-supervision shaping for `closest_visit` without restoring workstream all-pairs closure | product/modeling decision | **HIGH** | CV-12 diagnostics | User + impl |
| CV-14 | Add richer row-builder diagnostics for the case where structural preflight passes but built training rows still have no usable groups | code + diagnostics | MED | future failure evidence | impl |
| CV-8 | Hard negatives (#179 plan step 5, still open): negatives remain `random_unrelated`/`recently_skipped` only. More relevant now — the ship gate compares vs baseline/LR; trivially-easy negatives weaken the discriminative bar | code | MED | — | impl |
| CV-9 | #183 ablation is a **static attestation** (`status:'not-in-feature-vector'`), not the re-trained dynamic ablation #182 §3(1) envisioned — accept or upgrade | design | LOW | — | decision |
| CV-10 | #183 retrain is ~5–6× booster trainings (main + ≤3 tuning + permutation). Off warm path + fail-soft, acceptable; revisit gating the tuning grid behind a min-data threshold if retrain wall-time bites | perf | LOW–MED | #183 | impl / monitor |
| CV-11 | #183 novel-pair slice bundles `same_copied_snippet` (heuristic candidate) with `user_confirmed` (explicit feedback) as "independent supervision" — within the diagnosis spirit; revisit if it over-counts | design | LOW | — | decision |

## Closed / Decided

| ID | Resolution |
|---|---|
| CV-4 | **Decided: split.** PR #183 was amended to keep methodology-spine diagnostics, manifest normalization, model-choice probes, and dogfood notes, but remove non-pass ship-gate load-time enforcement from the serving path. Enforcement becomes a tiny follow-up after CV-1/CV-2 land. Evidence: PR #183 head `622c867d` and [`docs/ranker-v3-dogfood-verification-2026-05-16.md`](ranker-v3-dogfood-verification-2026-05-16.md). |
| CV-1 | **Closed by #186.** `methodologySpine` status/reason is now surfaced through work-graph health and `/v1/system/health`. |
| CV-2 | **Closed for observability by #186.** The stale-model / invalid-model state is now legible; the actual fail-closed load-time gate is still intentionally deferred. |
| CV-5 | **Closed by #182/#184.** ADR-0005 was filed as [`docs/adr/0005-ranker-evaluation-methodology.md`](adr/0005-ranker-evaluation-methodology.md). |
| CV-6 | **Closed by #182.** The doc was renumbered and Bun-era grounding was updated. |
| CV-7 | **Closed by #182.** The plan doc merged standalone to `main`. |
| CV-12 | **Closed by #187.** The real-vault failure now returns immediately as `skipped:no-usable-query-groups` with `candidateCount: 0`; it does not fabricate positives and does not restore workstream closure. |

## Detail — the HIGH items

**CV-3 — the empirical proof.** The whole arc's claim ("correctly
silent until a learned model earns its place") is unproven until a
real dogfood retrain on post-#183 code shows: candidate `generatedAt`
now varies (restamp works) → `timeSplitGroups` fires or the preflight
explains why it cannot → `shipGate` resolves to a concrete status →
and if `closest_visit` emits nothing, `shipGate.reason` explains
exactly why. Until CV-3 passes, treat the arc as
implemented-but-unvalidated.

Dogfood notes: three real-vault runs were attempted on 2026-05-16 and
are recorded in
[`ranker-v3-dogfood-verification-2026-05-16.md`](ranker-v3-dogfood-verification-2026-05-16.md).
The post-#186 run confirmed the safe-block surface
(`closest_visit` stayed at `0`, stale v2/schema-2 model was rejected,
health exposes methodology-spine state), but it did **not** pass CV-3:
the retrain reached `63864` candidates and `136` distinct labeled-row
timestamps, then failed because row-building produced `0` positive
rows and `0` usable query groups. The post-#187 run returned
immediately with `skipped:no-usable-query-groups`, `790` labels
(`218` positive / `572` negative), and `candidateCount: 0`. Keep CV-3
open until a future run trains a candidate model with legitimate
positive rows and produces methodology-spine/ship-gate output.

**CV-13 — decide legitimate positive supervision.** The real-vault
positive labels are mostly item/container-shaped
`user.organized.item` evidence. General workstream membership closure
is forbidden by #179/#181, so a replacement positive expansion must be
explicitly justified: for example, true `USER_FLOW_CONFIRMED`
visit-pair feedback, snippet lineage that resolves to visits, or a
separately accepted suggestion/member snapshot. This is a product and
modeling decision, not a row-builder hack.

## Closing rule

An item is removed from the table only when its change is **merged**
(code) or **filed/decided** (decision/ADR), with the closing PR/commit
noted inline. CV-3 is special: it is the gate that converts the whole
effort from "implemented" to "validated" — keep it open until a real
dogfood retrain confirms it.

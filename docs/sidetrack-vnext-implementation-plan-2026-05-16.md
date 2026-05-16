# Sidetrack v-Next — Implementation Plan (2026-05-16)

> **Status:** Plan only. No implementation, no model retrain. This doc
> *sequences and gates* the v-Next work; it does not start it.
>
> **Derived from:** the v-Next *Research Brief for Algorithmic Choices*
> (8 gaps) **and its amendment**. Where the amendment corrects the
> brief, **the amendment is authoritative** — this plan carries the
> corrected positions, not the brief's overstated ones.
>
> **Grounded in:** the live `closest_visit` arc — #179 (diagnosis,
> merged), #181 (de-leak, merged), #182 (methodology-spine plan +
> ADR-0005, merged), #183 (methodology-spine impl, merged
> diagnostics-only for ship-gate enforcement), #184 (follow-ups
> tracker, merged). This plan does **not** restate the brief; read the
> brief for the option survey and the per-gap references.

---

## 0. Where we actually are (the closest_visit arc *is* v-Next Phase 0)

This is not greenfield. The `closest_visit` work already built, on one
scorer, the foundation the brief's amendment says must come first:

| Brief concept | Already exists as |
|---|---|
| Disjoint-stream / no label-provenance leakage (Synthesis pt 6) | The #179 diagnosis root cause + #181 de-leak. This plan **generalizes that one fix into a platform invariant.** |
| Time-split eval + ship gate (amendment: "eval first") | #183 methodology spine: forward-chaining 3-way split, reserved-test ship gate, label-permutation/novel-pair probes. Load-time enforcement is split out until CV-1/CV-2 observability lands. |
| "Validate before trusting" | #184 **CV-3**: real dogfood validation of #183 — tracker merged, validation still open. One dogfood run produced a safe-block result, not a passing validation. |
| Gap 8 step 1 (deterministic transition) | The de-leaked ranker on `main` post-#181 |

**Reframe:** `closest_visit` is **Gap 8 step 1 + the Phase-F
foundation, proven on a single scorer.** v-Next is "generalize that
foundation to every scorer, then add algorithms over it." The gate
between *prototype* and *generalize* is **#184 CV-3** — the foundation
is not validated until a real dogfood retrain confirms #183 behaves as
designed. The 2026-05-16 run confirmed safe blocking (`closest_visit`
stayed dark and the stale v2 model was rejected) but failed retrain
because there was no usable query group with both positive and
negative labels. **v-Next Phase 1 does not start until CV-3 passes.**

---

## 1. Non-negotiable invariants (ship-blocking, CI-enforced)

Consolidated from the brief's Synthesis (pts 2, 4, 6), the amendment's
invariants discussion, and the empirically-paid-for #179 lesson. These
gate every algorithm below; no algorithm substitutes for them.

1. **Disjoint-stream / feature-provenance.** For every model, the
   event *types* used as features and as labels are disjoint, verified
   by a **CI feature-provenance audit** (lists each model's feature
   event-types and label event-types; fails the build on overlap).
   *This is the #179 failure generalized — the single most important
   non-algorithmic choice.* **Ship-blocking.**
2. **Three-stream separation.** `ObservedEvents` (per-replica,
   immutable, never synced) · `UserAssertions` (convergent, append-only
   with retraction-by-event-id) · `InferredOpinions` (per-replica,
   revision-tagged, GC'd by revision-retention). Event-source the
   semantic core only (Young, "parts not whole").
3. **Pure replayable projections.** Every model revision is a pure
   projection over `ObservedEvents ∪ UserAssertions → InferredOpinions`;
   replay determinism is unit-tested (same revision + inputs ⇒ same
   opinion).
4. **No rollback to a known-leaky model.** A rollback target is a
   *more conservative configuration of the current non-leaky ranker*
   (wider abstention, auto-apply off) — **never** the leaked
   predecessor. Shadow-for-diagnostics ≠ rollback target.
   **Ship-blocking.**
5. **Exposure logging precedes IPS.** Any inverse-propensity-corrected
   learning requires logged exposure (and, where claimed, randomized
   interventions) *recorded before* it ships. No IPS on unlogged
   history.
6. **Output tagging.** Every `InferredOpinion` carries
   `{model_revision_id, parent_event_ids, inputs_hash}`. Untagged
   output is unusable for training *and* serving. **Ship-blocking.**

Invariants 1, 4, 6 are the three that, if violated, recreate the
`closest_visit` class of bug. They get CI enforcement, not convention.

---

## 2. Corrected dependency order (the most consequential change)

The brief's amendment's headline correction: **foundation first, then
algorithms.** This plan adopts a phase order, not the brief's thematic
order. Each phase gates the next.

- **Phase F — Foundation (no algorithm ships before this).**
  Generalize #183's spine + Invariants 1–6 from one scorer to a
  reusable substrate: three-stream event store; CI feature-provenance
  audit; exposure logging; a shared time-split eval harness (the #183
  spine, extracted); the deterministic typed evidence graph (Gap 8A).
  **Gate to exit Phase F: #184 CV-3 passes** (the foundation is proven
  on `closest_visit` before being generalized).
- **Phase A — Deterministic spine.** Shared **PPR kernel** (Gaps 1/4/8)
  — *separate `positive_ppr` and `negative_ppr` channels, never a
  single signed scalar* (amendment); per-edge-type weights; traceable
  contributions. RRF gains PPR as a 3rd channel (k 60→~80–100 for the
  noisier graph channel); MMR (λ≈0.7) diversity pass. Deterministic-
  edge PPR **shadow-deployed vs. the de-leaked baseline on the
  time-split** (Gap 8 step 1).
- **Phase B — Calibration / abstention.** Per-source **Beta
  calibration** → conformal. *Corrected:* calibration before conformal
  is **preferred, not required** (split-conformal validity holds for
  any score under exchangeability — it improves set size and
  interpretability, not validity). **Mondrian conformal is the target
  architecture, gated on per-bucket sample size; Chow's rule is the
  warm-start until buckets fill — not a permanent "V1."** ACI
  (Gibbs–Candès) for drift. Fuse *before* calibrate; conformal and
  Bayesian posteriors do not compose.
- **Phase C — Self-supervised + active-learning co-design.** Task-burst
  co-engagement, **bursts defined from time/foreground only**, written
  to a **structurally distinct `SelfSupervisedPairs` stream**; crossing
  it into `UserAssertions` is a CI-blockable Invariant-1 violation.
  Active-learning **V1 acquisition = margin-on-conformal-set-size +
  cold-workstream bonus + domain diversity** (NOT BALD — there is no
  probabilistic model to disagree about at deterministic V1). BALD
  (bootstrap-ensemble) is V2, once learned weights exist; BADGE is V3.
- **Phase D — Learned graduation.** Only when self-supervised volume +
  the eval bar are met (the #183 ship-gate discipline, generalized):
  deterministic *structural* edges + learned weights for *similarity*
  edges (Gap 8D) + Beta-calibrated output. LR → trees only if it beats
  the deterministic/LR baseline on the reserved test.
- **Phase E — Clustering (independent track).** **Embedding-only
  HDBSCAN first** — never materialize a 10⁴×10⁴ dense distance matrix
  (~400 MB in the Node/Bun companion); use a kNN-graph / Boruvka-MST
  variant. GLOSH + soft membership + c-TF-IDF names. **Kept separate
  from attribution** (different product question, different signals,
  different abstention semantics — Synthesis pt 5). Graph/session
  evidence enters downstream scorers as *features*, not baked into the
  cluster metric.

---

## 3. Per-gap decision register (amendment-corrected)

| Gap | Decision (locked) | V1 vs deferred | Safety wrapping |
|---|---|---|---|
| 1 Attribution | Personalized PageRank, shared kernel | V1 (Phase A) | **Separate ±PPR channels**; seed half-life; per-edge-type degree caps |
| 2 Calibration/abstention | Beta (per source) → conformal; ACI for drift | V1 Chow warm-start → Mondrian when buckets ≥~20–30 | calibration ≠ prerequisite for conformal validity; fuse before calibrate |
| 3 Clustering | HDBSCAN + GLOSH + c-TF-IDF | Phase E (independent) | **Embedding-only first**; no dense matrix; separate from attribution |
| 4 Recall | RRF + PPR 3rd channel + MMR | V1 (Phase A) | raise k for noisy channel; learned fusion deferred |
| 5 Self-supervision | Task-burst co-engagement | Phase C | bursts from time/foreground only; distinct stream; IPS gated on exposure logging |
| 6 Active learning | margin+diversity → BALD → BADGE | V1 simple; BALD/BADGE deferred | binary asks, session cap, batch (Prodigy) |
| 7 Event sourcing | Three-stream + tagging | **Phase F (first)** | Invariants 2/3/6; Young "parts not whole" |
| 8 Transition | 8A deterministic-PPR → 8D hybrid | 8A V1 (gated by Phase F); 8D gated by eval bar | rollback → conservative v2 config, never v1 |

Algorithms are **unchanged** from the brief's recommendations
(amendment confirms them). What this plan changes vs. the raw brief:
the *order*, the *safety wrappings*, and the two factual fixes below.

---

## 4. Factual corrections carried forward (so they are not re-introduced)

- **Beta calibration is NOT in scikit-learn.** sklearn ships isotonic
  and Platt; Beta calibration is the separate `betacal` package. (~30
  LOC hand-roll either way; matters only for the "reference oracle".)
- **Split conformal does not require a calibrated score.** Finite-
  sample coverage holds for any nonconformity score under
  exchangeability. Calibration improves set *efficiency* and
  *interpretability*, not *validity*. Plan language must say
  "preferred", never "required".

---

## 5. Decisions & ADRs needed (User + Claude)

- **ADR-0005 is filed via #182** for the model-orthogonal ranker
  evaluation methodology. It resolves the stale #182 "ADR-0004"
  reference and makes the methodology spine a decision of record.
- **ADR-0006 — Disjoint-stream / feature-provenance / three-stream
  invariant as load-bearing architecture.** This is now the next
  proposed ADR number after `0005-ranker-evaluation-methodology`.
  It should encode the #179 bug class as a platform invariant.
- **ADR-0007 — PPR as the shared load-bearing primitive** across
  attribution (G1), recall (G4), and transition (G8): one kernel
  module, two query surfaces, separate ± channels.
- **ADR-0008 — Deterministic-first transition + no-rollback-to-leaky**
  (Invariant 4 formalized; extends the Gap-8 sequencing).
- **Scope decision (highest-leverage):** v1 ships **Phase F + Phase A
  deterministic only.** Every learned component (Gaps 3 learned-metric,
  5 IPS, 6 BALD/BADGE, 8D) is deferred and eval-gated. The brief is a
  multi-quarter decision reference, **not** a v1 build list; treating it
  as one is the primary planning risk.
- **Continuity:** ADR-0003 (defer ColBERT/WebQuality) stands. Note
  ADR-0003's "no Python/Rust, ESM-only" framing predates Bun adoption
  (ADR-0004); #182/#184 recorded the Bun-era grounding correction.
  That does **not** change this plan's recommendations.

---

## 6. Library-maturity reality

Node/Bun-only. ~**1500–2000 LOC** of carefully-tested numerical
TypeScript covers every algorithm in the brief. Python packages
(`hdbscan`, `scikit-learn`, `betacal`, `mapie`, `leidenalg`) are
**test oracles for the TS hand-rolls, not production dependencies**.
`hdbscan-ts` is usable for the hierarchy (supplement soft-membership +
GLOSH ~150 LOC). PPR/RRF/MMR/Beta/conformal are 10–200 LOC each.

---

## 7. Non-goals / explicitly deferred

Learned rerankers and learned fusion (label-starved until ~1k labels);
BALD/BADGE active learning (no probabilistic model at V1); UMAP
(no maintained Node port); full CRDT `UserAssertions` (LWW + logical
clocks suffices for few-device single-user); online streaming
clustering (re-run HDBSCAN on the small open-tab set); ColBERT /
WebQuality (ADR-0003, still gated).

---

## 8. Definition of done — Phase F (the only thing this plan unblocks now)

A future Phase-F effort is complete when, with **no new learned model
shipped**:

- The #183 methodology spine is **extracted into a reusable eval
  harness** callable by any scorer (not `closest_visit`-specific).
- The **CI feature-provenance audit** exists and fails the build on a
  feature/label event-type overlap (Invariant 1, mechanized).
- Three-stream event store + output tagging (Invariants 2, 6) are in
  place; projections are pure and replay-tested (Invariant 3).
- Exposure logging is recording (Invariant 5) — no IPS consumer yet.
- The deterministic typed evidence graph + a shared PPR-kernel
  scaffold exist (no learned weights) and can shadow-run.
- **Gate: #184 CV-3 passes** — a real dogfood retrain confirms the
  spine behaves as designed on `closest_visit` before the foundation
  is generalized. The first dogfood run was useful but did not pass:
  it safe-blocked and exposed missing usable positive/negative query
  groups. Until CV-3 passes, Phases A–E do not start.

Phase F is the foundation the amendment says must come first; CV-3 is
the proof it works on one scorer before it carries the platform.

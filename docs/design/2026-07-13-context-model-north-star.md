# Context-Model North Star (v3 — grounded in OUR pattern)

**Date:** 2026-07-14 (v3) · v2 2026-07-13 (pattern survey) · v1 same day (first-principles sketch)
**Status:** Accepted direction. v3 inverts the method: the core is derived from THIS vault's
measured behavior; literature patterns live in Appendix B behind observed adoption triggers.
**Owner directive that produced v3:** "I don't want to adopt so many patterns at the beginning…
try to understand OUR pattern; keep existing ones in an appendix."

---

## 1. Our pattern, measured (2026-07-14 vault study, read-only; 4 analysts)

Ground truth: 677 `user.organized.item` events over 9.1 weeks; 515 usable move/promote
labels; 5,046 web visit-instances in 2,995 tab sessions; event-store (not the truncated
JSONL dir) as source. Full numbers in the study record (`wf_78c16b20`).

**W — the taxonomy is fixed.** All 32 workstreams were created in one 15-day setup burst
(May 11–26); **zero created in the 49 days since**. Ongoing behavior is filing into a fixed
set. "ai" is a catch-all (28% of members, 59 domains); 20/33 containers dormant >30d.

**L — label economics.** Burst-then-tail: ~202/week during the setup push, **~12/week
steady-state**. Filing is bursty (48% of gaps <60s; top-10 cleanup sprees = 41% of all
labels). Median visit→file latency 4.2 min (53% ≤5 min) with a real days-later tail (~15%).
**80.3% of visited URLs are never organized** — abstention is the owner's revealed default.
Explicit negatives barely exist (101 group-dismissals; 2 lifetime rejects). Re-files are
5.6% and are genuine re-categorization, not noise.

**S — sessions are weak intent signals here.** 82.6% of sessions are singletons. On
user-asserted labels only: consecutive-visit same-workstream probability **0.538** (switch
rate 46.2% ≈ coin flip); only 26% of multi-visit labeled sessions are workstream-pure.
Opener/referrer capture covers only ~1/3–59% of visits. Domains are **venues, not topics**:
hubs (HN 44 topics, chatgpt 16 workstreams, github 14) carry 63% of labeled traffic.

**E — embedding reality.** The encoder space is anisotropic: random unrelated pages average
**0.825 ± 0.029 cosine** (p90 0.860) — absolute cosine thresholds near 0.85 skate on noise;
only lift above baseline is meaningful. Vector coverage is time-biased (96% on early labels,
39% on recent — backfill, not decision-time embedding), which makes today's embedding-NN
signal **anti-causal** as evidence.

**R — retrospective signal arbiter** (each simple signal alone vs the owner's 515 actual
filings; time-ordered, no peeking):

| Signal | fires | precision when fired | overall top-1 |
|---|---|---|---|
| Title term-overlap → nearest workstream | 84.7% | 47.2% | **40.0%** |
| Recency (last workstream filed into) | 99.8% | 38.3% | 38.3% |
| Embedding-NN *(anti-causal, inflated)* | 72.2% | 50.0% | 36.1% (12% on recent labels) |
| Domain-majority | 71.3% | 34.1% | 24.3% |
| Session-majority | 55.9% | 39.6% | 22.1% |
| Search-chain/opener | 48.3% | 39.8% | 19.2% |

Domain splits cleanly: **69% precise on single-workstream domains, 21% on hubs.**
Cascade order dominates: title→session→domain→recency = **45.2%**; 4-signal majority vote =
**46.2%**; the six-signal oracle union = **66–70%**; majority-class baseline = 28.9%.
Head/tail: ~53% on the 7 head workstreams, ~28% on the 22 tail ones. 30% of filings are
unexplained by ALL six simple signals — the honest ceiling for this signal family.

## 2. The v1 model our data justifies (and nothing more)

**A three-family scorer + abstention, arbitrated by the ranker we already have.**

1. **Content-lexical family (primary):** title/term overlap between the visit and each
   workstream's member titles (BM25-flavored, venue-term-suppressed). Best measured signal,
   fires cold, no new infra.
2. **Conditional domain prior:** domain→workstream only where the domain historically maps
   to ONE workstream (69% precision regime); suppressed on measured-ambiguous hubs — the
   per-domain dispersion table from the study is the initial coherence prior, *measured
   rather than hardcoded*.
3. **Recency prior:** the last-filed workstream as tie-breaker/fallback (38.3% floor,
   orthogonal, free; encodes real burst-filing behavior).

Session-majority may enter as a *weak fourth feature* where opener data exists — never as a
cascade leader and never as a modeling layer.

**Combiner:** the fixed vote/cascade ships first (46% for free, fully explainable); the
existing LightGBM then earns its keep arbitrating exactly the 46%→66% gap, trained on the
~12/week label stream with the existing count-gated retrain discipline. No generative model,
no prototype dictionaries, no session process in v1.

**Decisions:** abstention-first, matched to the 80% base-rate. Suggest only in the
measured-precision regime; **top-k (not top-1) for tail workstreams**; auto-apply effectively
never. Confidence gating via per-workstream empirical precision with shrinkage
(beta-binomial counts — data-native, honest at n=small; no calibration layer in v1).

**Surfaces matched to observed behavior:** (a) at-visit suggestion — 53% of filings happen
within 5 minutes of the visit; (b) a **batch cleanup queue** — the spree pattern (20–45
filings in a sitting) is how the backlog actually drains; pace asks by spree detection, not
per-ask throttles.

**Evaluation:** prequential replay **on the 915 user-asserted edges only** (system-inferred
edges are partly circular); the frozen baseline is the 46% heuristic vote; a challenger
ships only after beating it there, then wins an interleaving duel against the incumbent
resolver in shadow.

## 3. Adoption triggers (what would bring the deferred machinery in)

| Deferred mechanism (Appendix B ref) | Adopt when we OBSERVE |
|---|---|
| Embedding/content-similarity signal | decision-time vector coverage ≥70% on new visits (S0 lane) AND lift-corrected embedding beats title-lexical on asserted-edge replay |
| Session/intent process (Hawkes/HMM, P4) | opener capture ≥70% AND asserted-only session stickiness >65% |
| Novelty / new-workstream branch (P5) | owner creates ≥1 new workstream/month, two months running |
| Prototype dictionaries + sparse-coding (P3) | title-lexical plateaus AND head workstreams have ≥30 members with decision-time vectors |
| Label-noise modeling (P13) | re-file rate rises well above the observed 5.6% |
| Platt/temperature calibration heads (P9) | suggestion volume makes beta-binomial gating visibly miscalibrated on the reliability artifact |
| Active-ask policy (P14) | steady-state labels/week doubles or a second labeling surface ships |
| Teacher/distillation loop (P16) | any of the above stalls for lack of labels/aboutness — teacher fills that specific gap |

**Immediate side-findings for the CURRENT system** (independent of v1): the reborn
similarity lane's 0.85 cosine threshold sits at ~p90 of *random pairs* under this encoder —
served similarity edges must be re-scored as lift-over-baseline; and eval of any
embedding-flavored arm must exclude backfill-era vectors or it will flatter itself.

## 4. What stays from the S1 work in flight

Propensity logging: **keep** (data preservation; unrecoverable later). Interleaving
scaffold: **keep** (the v1-vs-incumbent duel is its first real use). Per-surface Platt
calibration head: **park behind its trigger** (beta-binomial gating suffices at v1 volume).

---

## Appendix A — v2 architecture sketch (deferred superstructure)

The time-modulated nonparametric context process (content likelihood × decayed activity
intensity + new-context branch, additive personal correction, sparse-coded exemplar
dictionaries, nightly re-cluster, multi-task calibrated heads, utility-tiered decisions,
teacher + active loops). Retained verbatim from v2 as the shape this system grows *toward*
if and only if the triggers in §3 fire. Nothing in it is licensed by current data except
what v1 already includes.

## Appendix B — pattern survey (18 load-bearing findings, 4 families)

P1 Gmail Priority Inbox — additive global+personal blend · P2 TaskPredictor2/TaskTracer —
abstention-first, correction noise, switch detection as the hard part · P3 Apple Photos
People — exemplar dictionaries, sparse-code assignment, nightly re-cluster, cluster-gating ·
P4 Dirichlet-Hawkes — stickiness/novelty/clustering as one coupled assignment · P5 TDT
first-story detection — entropy ≠ novelty · P6 CluStream/BIRCH — bounded sufficient
statistics · P7 SKNN-vs-GRU4Rec — nonparametric wins at small data · P8 two-stage funnels —
posterior never gates admission · P9 calibration practice — Platt at small N, per-surface ·
P10 off-policy limits — replay can't judge retrieval changes · P11 interleaving — the N=1
online arbiter · P12 propensity logging — stamp at serve or lose it · P13 Snorkel — learned
weak-label noise/correlations · P14 active learning under drift — mixed strategies, fatigue ·
P15 ADWIN/DDM — drift-triggered retraining · P16 on-device distillation — offline teacher,
version-stamped labels · P17 Focused Inbox — hard pins beside soft corrections · P18
frecency/site-engagement — decayed auditable priors. Full survey with provenance and
verdicts: workflow record `wf_76f85721` (2026-07-13).

# Context-Model North Star (v2, pattern-hardened)

**Date:** 2026-07-13
**Status:** Accepted direction (post-lift execution; propensity logging + calibration are immediate)
**Supersedes:** the channel-fusion attribution design (PPR/similarity/corroboration logit fusion in the tabsession resolver)
**Companion docs:** `docs/audits/2026-07-11-recsys-data-architecture-review.md` (the N=1 regime),
ADR-0011 + amendments (freeze scoping, eval-gated flips)

---

## 1. The problem, stated as the ML problem it is

Continual, few-label (tens/week) inference of a user's **latent work contexts**
("workstreams") over an on-device browsing event stream — serving three surfaces
from one substrate: **attribution** (file this page), **recall/search**, and
**related-page recommendation**. Contexts are born, drift, and die. Labels are
scarce, delayed, noisy, and presentation-biased. Compute is a laptop background
process with a documented CPU-runaway history. Nothing leaves the device.

Two evidence families exist and must be fused, not conflated:

- **Acquisition context** (intent): tab session, opener chain, search query,
  temporal rhythm — *why you're reading*.
- **Page content** (topic): what the page says — *what it is*.

Workstreams differ in *shape*: topic-shaped (`cloud`, `rust`) want content
evidence to dominate; project-shaped (`trading` = matching engines + AWS deploy
+ exchange code) want intent evidence. Shape is measurable (dispersion of a
workstream's member content) and must be learned per workstream, not assumed.

## 2. The design case study that seeded this (do not overfit to it)

EKS-kubeconfig page: resolver auto-applied `trading` at simTop 1.0 via a
two-hop term bridge ("kubeconfig aws" search → "How to Build an Exchange …
in AWS" article), while the user's ground truth was `cloud`. Lessons *as a
class*, not as a bug: (a) confidence was uncalibrated (1.0 from weak
evidence); (b) neighbor evidence was propagated without weighting by the
coherence of the linking context; (c) aboutness ("about AWS" vs "deployed on
AWS") is invisible to term overlap; (d) auto-apply fired where abstention was
correct. Every element below addresses the class.

## 3. Pattern evidence (what proven systems forced us to change)

Surveyed four families (2026-07-13, adversarial brief): personal/on-device
classifiers & task inference; industrial recsys/feed ranking; continual &
streaming learning; ML serving systems. Full survey in the workflow record
(`wf_76f85721`). The load-bearing findings:

| # | Pattern (provenance) | What it forced |
|---|---|---|
| P1 | **Gmail Priority Inbox** (Google, 2010) — global model log-odds + bounded per-user correction | The context model is an **additive blend**: frozen semantic/global prior + small personal correction. A unified personal generative model is unlearnable at tens of labels/week; cold-start is permanent. |
| P2 | **TaskPredictor2 / TaskTracer** (Oregon State, IUI'06/IJCAI'07) — the direct ancestor; ~80% precision at ~10% coverage, died anyway | **Abstention-first**: wrong auto-file priced near-catastrophic; coverage is a non-goal. Correction-loop labels are themselves noisy (their killer). Switch detection is the core problem, not a nice-to-have. |
| P3 | **Apple Photos People clustering** (Apple MLR, 2021) — exemplar dictionaries, sparse-coding assignment, nightly re-cluster | Prototype sets confirmed, mechanics corrected: **soft-vote/sparse-code over the dictionary, never nearest-argmax**; instant corrections **plus periodic batch re-cluster** (online edits can't fix merge/split); explicit "is this a real cluster" gating heuristics. |
| P4 | **Dirichlet-Hawkes processes** (KDD'15 lineage) — content likelihood × time-decaying intensity + DP new-cluster branch | Session stickiness, new-context discovery, and unknown-count clustering are **one coupled assignment**, not three modules (HMM + prototypes + lifecycle would disagree with no arbiter). |
| P5 | **TDT first-story detection** | **Posterior entropy does not detect novel contexts** — new projects get *confidently mis-filed* to the nearest prototype. An explicit novelty branch is structural, not optional. |
| P6 | **CluStream/BIRCH micro-clusters** | Bounded sufficient statistics per context (centroid, spread, count, last-active), not unbounded exemplar growth — the CPU/memory regime demands it. |
| P7 | **Session-based recsys reproducibility results** (SKNN vs GRU4Rec) | Nonparametric-at-small-data validated externally. Serve nonparametric; keep all training offline. Tune the simple baseline as hard as any fancy challenger. |
| P8 | **Two-stage retrieval→ranking discipline** (industry-wide) | The posterior must **never gate candidate admission**. Cheap recall shortlist (graph + prototype kNN) → calibrated precision on the shortlist only. |
| P9 | **Calibration practice** | Decisions require calibrated probabilities, **per surface**; at N=1 use Platt/temperature or Bayesian shrinkage — isotonic staircases flip decisions at tiny N. Reliability diagram = health artifact. |
| P10 | **Off-policy evaluation limits** (Airbnb KDD'25 lineage) | Replay over logged candidates **cannot** evaluate retrieval/candidate-set changes (unsupported mass) — exactly the changes this design ships. Replay gates re-ranking only. |
| P11 | **Interleaving** (~50× A/B sensitivity) | The N=1 online arbiter: blend incumbent + candidate producers into one served strip, attribute wins by producer. Sits between replay pre-filter and any flag flip. |
| P12 | **Propensity logging doctrine** | Served position + exploration randomness must be stamped into impressions **at serve time — unrecoverable later**. Without it, prequential eval re-learns the UI's position prior. |
| P13 | **Snorkel label modeling** (VLDB'18) | Behavioral weak labels get **learned accuracies and correlations** — dwell/scroll/open co-move (≈ one source, not three); dismiss is presentation-conditioned, not missing-at-random. |
| P14 | **Active learning under drift** | Pure info-gain querying starves quietly-shifted contexts (confidently-wrong regions are never queried). Mix info-gain + representativeness + a small random reservoir; space asks (fatigue), don't just cap them. |
| P15 | **ADWIN/DDM drift triggers** | Re-distillation / prototype re-seeding fire on statistical triggers, not fixed cadence (we have scar tissue from both over-rebuilding and a 31-day starvation). |
| P16 | **On-device distillation deployments** (Gboard, Apple adapters, Chrome Nano) | LLM-teacher offline-only is confirmed practice. **Teacher re-labeling = silent label drift**: version-stamp teacher outputs; freeze old labels on teacher swap or eval hallucinates wins. Nano's competence envelope: classify/tag/extract yes; long-doc reasoning no. |
| P17 | **Focused Inbox two-tier corrections** | Soft (noisy) exemplar nudges + **hard deterministic pins** ("always file X → W") that override the model. Hard predictable rules build the trust the ancestors never earned. |
| P18 | **Frecency/site-engagement priors** (Firefox/Chrome) | Behavioral intensity terms are cheap, decayed, bounded, *auditable* — and must not become "a dumping ground for signals." |

## 4. The architecture (v2)

**One substrate.** Encoder embeddings for pages/queries/sessions (pretrained,
never fine-tuned on-device) + the similarity graph + per-workstream **bounded
prototype dictionaries** (exemplars + sufficient statistics per P3/P6).

**One assignment mechanism** — the *time-modulated nonparametric context
process* (P4): for visit `v` in session `s`,

```
score(k) = log ContentLikelihood(v | prototypes_k)        // soft-vote/sparse-code (P3)
         + log ActivityIntensity_k(t)                     // decayed, Hawkes-flavored (P4, P18)
         + log CoherencePrior(link-context → k)           // context-entropy weighting (EKS lesson)
         + PersonalCorrection_k(v)                        // bounded, online, additive (P1)
score(new) = log α · NoveltyLikelihood(v)                 // first-story branch (P5)
```

Sticky sessions, new-project detection, and workstream lifecycle all live in
this one rule. Workstream shape emerges as the learned spread of each
prototype dictionary; the coherence prior is the measured dispersion of the
linking context (domain / path-prefix / tab-session / search-query), replacing
the hardcoded aggregator list.

**Two-stage funnel (P8).** Stage 1: cheap candidate shortlist (graph
neighbors + prototype kNN; high recall, hot-path-safe). Stage 2: the
assignment score above + GBDT residual, **calibrated per surface** (P9).
Stage 3: **abstention-first utility layer** (P2): auto-apply priced
near-catastrophic; tiers auto-apply / suggest / silent; quiet-state renders
calibrated uncertainty honestly. Hard pins (P17) bypass the model entirely.

**Multi-task heads, one substrate.** Attribution, recall, and related-pages
each get their own calibrated head and cost function; sparse attribution
borrows representation from label-rich recall.

**Learning loops.**
- *Weak labels* with learned noise/correlation structure (P13), folded as soft
  evidence — never counted as votes.
- *Corrections*: soft nudges update dictionaries instantly (noisy, P2);
  nightly bounded re-cluster repairs merge/split (P3); hard pins are
  deterministic (P17).
- *Teacher loop*: offline Nano-class LLM produces aboutness summaries, topic
  labels, and adjudications within its competence envelope; outputs
  version-stamped; student (prototypes + GBDT) serves (P16).
- *Asks*: mixed-strategy active learning under a spaced UX budget (P14);
  exploration via Thompson/VOI confined to the suggest tier.
- *Triggers*: ADWIN/DDM-style drift detectors gate re-distillation and
  re-seeding (P15).

**Evaluation stack (the honesty layer).**
1. **Propensity logging now** (P12): served position + exploration randomness
   stamped into every impression at serve time.
2. **Prequential replay** (test-then-train over the event-sourced log) with
   fading factors, delayed-label re-crediting, and refusal on derived-view
   hash mismatch — gates *re-ranking* changes only (P10).
3. **Single-user interleaving** (P11): incumbent vs candidate producers in one
   served strip — the arbiter for retrieval/candidate-set/attribution-model
   changes that replay structurally cannot judge.
4. Reliability diagrams per surface as standing health artifacts (P9).

## 5. Sequencing

| Stage | Work | Gate |
|---|---|---|
| S0 (running) | Content coverage: embedding worker lane, content-into-similarity, chunk serving | CPU soak + eval verdicts (existing flags) |
| S1 (immediate, small) | **Propensity logging** into impressions + per-surface Platt/temperature calibration head + reliability health artifact | unit + replay compatibility |
| S2 | Context process v1: prototype dictionaries (bounded), coherence prior, additive blend; served in **shadow** | interleaving vs incumbent resolver |
| S3 | Abstention-first utility layer + hard pins + honest quiet-state UX | prequential + trust metrics (§15 counters) |
| S4 | Novelty branch (new-workstream proposals), nightly re-cluster, drift triggers | interleaving + user acceptance of proposals |
| S5 | Teacher loop (Nano aboutness/labels, version-stamped) + active-ask policy | student-vs-teacher gap tracking |

**Not doing** (evidence-backed): on-device encoder fine-tuning; sequence
models trained from scratch; RL; isotonic calibration at N=1; unbounded
exemplar growth; info-gain-only querying; teacher calls on any hot path;
coverage-maximizing auto-apply.

## 6. Relationship to what exists

Nothing already built is discarded: embeddings, evidence tiers, the trainable
label channel, eval spine, and §15 counters are this design's substrate and
instrumentation. What gets **replaced** — only after losing an interleaving
duel — is the resolver's channel-fusion core. The freeze discipline holds:
every serving change ships flag-gated, shadowed, and promoted on evidence.

// Attribution v1 — the scorer (pure, unit-testable).
//
// A fixed, explainable three-family model over the derived state
// (state.ts), justified by the 2026-07-14 vault study (docs/design/
// 2026-07-13-context-model-north-star.md §2). SHADOW ONLY this wave — the
// incumbent resolver keeps serving; nothing here changes what serves.
//
// Families (contract §2, "the v1 model our data justifies and nothing
// more"):
//   1. TITLE-LEXICAL (primary): PLAIN term-overlap between the visit title
//      and each workstream's member titles (state.ts plainTitleOverlap) —
//      summed member document-frequency over the matched query terms, argmax
//      wins. The study's best cold signal (40.0% top-1 alone) and, per the
//      2026-07-16 prequential finding, STRONGER standalone than the BM25/IDF/
//      length-normalized family it replaces (39.6% vs 25.6% on this vault: the
//      IDF/normalization actively mis-ranked the correct workstream ~35% of the
//      time plain overlap would have won). No cross-workstream IDF, no BM25
//      length normalization. The eval's title-lexical arm scores this SAME
//      primitive, so the frozen-baseline comparison is honest.
//   2. CONDITIONAL DOMAIN: fires ONLY when the domain historically maps to
//      a single workstream (the 69%-precision regime); hard-suppressed on
//      measured-ambiguous hubs (21% precision). Domains are venues — this
//      ambiguity gate is where venue handling now lives (the title family
//      dropped its IDF venue-suppression per the finding).
//   3. RECENCY: the last-filed workstream as a small tie-break / fallback
//      (38.3% floor, orthogonal, free).
//
// COMBINER: two variants, both fixed and explainable (contract §2). The
// SHIPPING scoreVisit is the weighted sum with title-lexical dominant (the
// doc's "ordered-cascade-as-scores"). scoreVisitCascade is the study's ordered
// cascade (title fires → its answer; else domain-if-unambiguous; else recency),
// evaluated alongside the sum in the harness so we adopt whichever wins top-1
// at acceptable precision. No learned combiner in v1 (the LightGBM arbiter is a
// later trigger).
//
// DECISIONS (contract §2, "abstention-first, matched to the 80% base
// rate"): a per-visit EVIDENCE gate (MIN_SUGGEST_SCORE, calibrated to the
// study's 80.3% never-organized base rate) is the primary abstention control;
// the per-workstream beta-binomial shrunk precision is a secondary prior on
// label volume. Both must clear to suggest; TOP-K (not top-1) for tail
// workstreams; abstain otherwise. No auto-apply in v1.
//
// NO cosine anything (encoder anisotropy, contract §1 E / §2). No embedding
// signal. Pure functions over AttributionV1State + the visit triple.

import {
  type AttributionV1State,
  domainOfUrl,
  domainVerdict,
  plainTitleOverlap,
  workstreamLabelCount,
} from './state.js';

// ---- documented weights & thresholds ----------------------------------

// Family weights for the fixed weighted sum. Title-lexical dominant per the
// contract; conditional-domain is a meaningful but secondary corroborator
// (it only ever contributes in the single-workstream regime); recency is a
// small tie-break. These encode the study's signal ordering (title 40.0% >
// domain-precise 69%-when-fires-but-rare > recency 38.3% floor), NOT a tuned
// grid.
//
// SCALE NOTE: the title family is now a raw overlap COUNT (summed member
// document-frequency over matched terms — typically 1..O(tens), never < 1 when
// it fires), replacing the old BM25 score that lived near ~2.8. So the domain
// and recency weights are expressed in the same count units: a precise domain
// match is worth up to `conditionalDomain` overlap-terms of corroboration, and
// recency a fraction of one term. Both are applied so they can order candidates
// among near-equal title scores (or supply a fallback) but can never override a
// clearly-stronger title match. The domain weight multiplies a precision-scaled
// unit signal (≤0.69), so its effective contribution is ≤ conditionalDomain.
export const FAMILY_WEIGHTS = {
  titleLexical: 1.0,
  conditionalDomain: 2.0,
  recency: 0.5,
} as const;

// Beta-binomial precision prior. The study's head/tail precision anchors
// (~53% head, ~28% tail; majority-class 28.9%) seed a weak Beta prior so a
// workstream with few labels is shrunk toward the tail rate, and one with
// many labels trusts its own empirical precision. We do not have per-
// workstream realized precision in v1 (no served history yet), so the
// "successes" are approximated by the label count itself scaled by the
// regime rate — i.e. the gate expresses confidence as a function of
// evidence volume, honestly refusing when n is small. PRIOR_STRENGTH is the
// pseudo-count; TAIL_RATE / HEAD_RATE bracket the shrink target.
const PRIOR_STRENGTH = 8;
const TAIL_PRECISION = 0.28;
const HEAD_PRECISION = 0.53;

// Head/tail boundary (labels): the study's 7 head workstreams each have
// >=20 labels. At/above this we suggest top-1; below it we widen to top-k.
export const HEAD_LABEL_THRESHOLD = 20;

// top-k width for tail workstreams (contract: "top-k, not top-1, for tail").
export const TOPK_WIDTH = 3;

// Minimum shrunk precision to emit a suggestion at all. Set just above the
// majority-class floor (28.9%): a candidate must clear "no better than
// guessing the biggest bucket" to be worth surfacing. Below it ⇒ abstain.
// NOTE: shrunkPrecision is keyed on the workstream's LABEL COUNT, so this
// prior alone is a near-no-op gate — every workstream with >=1 label clears
// it (shrunkPrecision(1)=0.308 > 0.30). It is a per-workstream *prior*, not
// per-visit confidence; the per-visit evidence gate is MIN_SUGGEST_SCORE.
export const SUGGEST_PRECISION_FLOOR = 0.3;

// Minimum blended score for a candidate to be considered at all (drops the
// long tail of near-zero title matches; a candidate below this is not even
// ranked).
const MIN_CANDIDATE_SCORE = 1e-6;

// Per-visit EVIDENCE gate: the minimum top-candidate score to actually
// SUGGEST. Unlike SUGGEST_PRECISION_FLOOR (a per-workstream label-count
// prior), this keys on THIS visit's measured evidence, which is what makes
// abstention the default. Calibrated to the study's revealed base rate: the
// owner leaves 80.3% of visited URLs unfiled, so an abstention-first scorer
// declines on the weak matches and suggests only on the strong ones.
//
// The score scale changed with the plain-overlap title family (raw overlap
// COUNTS, not BM25), so this floor is expressed in overlap-count units. The
// 2026-07-16 tradeoff curve on the asserted-edge prequential replay of
// ~/.sidetrack-vault-test (runV1ThresholdCurve; full table in the commit
// message) measured the abstention/precision frontier:
//
//   thresh   top1    abstain   prec@sug
//        1   39.4%      7.7%     42.7%
//        3   33.5%     25.8%     45.2%
//        6   25.0%     42.3%     43.3%
//       11   15.9%     68.7%     50.6%
//   >> 14    11.6%     78.3%     53.3%  (base-rate-consistent, precision peak)
//       18    9.8%     81.3%     52.2%
//       30    2.8%     95.1%     58.3%
//
// The calibration TARGET is "precision-when-suggesting maximized subject to
// abstention consistent with the 80.3% base rate" (north-star §2). The
// precision peak inside the base-rate band (78–82% abstain) is at threshold
// 14–15 (53.3% prec@sug, 78.3% abstain), so MIN_SUGGEST_SCORE = 14. This is a
// deliberate abstention-first operating point, NOT a top-1 maximizer: v1's raw
// top-1 peaks near ~42% at threshold≈0 (see the eval finding), but that means
// ~0% abstention, which the north-star explicitly rejects for this vault. The
// gap between the abstention-first bar and the frozen-vote top-1 is the honest
// finding, not a number to chase. Fixed constant, not a per-run tuned value.
export const MIN_SUGGEST_SCORE = 14;

// ---- output shape -----------------------------------------------------

export type AttributionV1Family = 'title-lexical' | 'conditional-domain' | 'recency';

export interface AttributionV1Reason {
  readonly family: AttributionV1Family;
  // Weighted contribution this family added to the candidate's score.
  readonly contribution: number;
  // Human-auditable one-liner (matched terms, domain precision, etc.).
  readonly summary: string;
}

export interface AttributionV1Candidate {
  readonly workstreamId: string;
  readonly score: number;
  // Per-family weighted contributions (sum to `score`), for shadow audit.
  readonly contributions: {
    readonly titleLexical: number;
    readonly conditionalDomain: number;
    readonly recency: number;
  };
  readonly reasons: readonly AttributionV1Reason[];
  // Beta-binomial shrunk precision for this workstream (the gate input).
  readonly shrunkPrecision: number;
  readonly labelCount: number;
}

export type AttributionV1Action = 'suggest' | 'topk' | 'abstain';

export interface AttributionV1Result {
  readonly action: AttributionV1Action;
  // Ranked candidates. For 'suggest' the caller reads [0]; for 'topk' the
  // first TOPK_WIDTH; for 'abstain' this is [] (nothing cleared the gate).
  readonly candidates: readonly AttributionV1Candidate[];
}

// ---- beta-binomial gate -----------------------------------------------

// Shrunk precision for a workstream given its label count. With no realized
// served precision yet (S1 propensity logging just began), we express
// confidence as evidence volume: the posterior mean of a Beta prior seeded
// at the tail rate, "observing" the workstream's own labels as pseudo-
// successes at the head rate it is approaching. Concretely:
//   prior successes  a0 = PRIOR_STRENGTH * TAIL_PRECISION
//   prior trials     n0 = PRIOR_STRENGTH
//   observed         successes = labelCount * HEAD_PRECISION, trials = labelCount
//   shrunk = (a0 + successes) / (n0 + trials)
// A 0-label workstream sits at TAIL_PRECISION; a large-label workstream
// approaches HEAD_PRECISION. Monotone increasing in labelCount, bounded in
// [TAIL_PRECISION, HEAD_PRECISION]. Honest at n=small by construction.
export const shrunkPrecision = (labelCount: number): number => {
  const a0 = PRIOR_STRENGTH * TAIL_PRECISION;
  const n0 = PRIOR_STRENGTH;
  const successes = labelCount * HEAD_PRECISION;
  return (a0 + successes) / (n0 + labelCount);
};

// ---- scorer -----------------------------------------------------------
//
// The title-lexical family is the shared PLAIN term-overlap primitive
// (state.ts plainTitleOverlap) — no BM25, no cross-workstream IDF, no length
// normalization. It is computed once per visit for all workstreams below.

export interface ScoreVisitInput {
  readonly title: string;
  readonly url: string;
  // Optional explicit domain; derived from `url` when omitted.
  readonly domain?: string;
}

const compareCandidates = (a: AttributionV1Candidate, b: AttributionV1Candidate): number => {
  if (b.score !== a.score) return b.score - a.score;
  // Deterministic tie-break: higher label count first, then id order.
  if (b.labelCount !== a.labelCount) return b.labelCount - a.labelCount;
  return a.workstreamId < b.workstreamId ? -1 : a.workstreamId > b.workstreamId ? 1 : 0;
};

// The per-family unit signals for one visit, computed once and shared by both
// combiners (weighted-sum and cascade) so they read identical evidence.
interface VisitSignals {
  readonly domain: string | null;
  readonly verdict: ReturnType<typeof domainVerdict> | null;
  // The single workstream the domain corroborates (null on ambiguous hubs).
  readonly domainWorkstreamId: string | null;
  // Precision proxy for that domain match (0 when no unambiguous domain).
  readonly domainPrecision: number;
  // workstream -> raw plain title-overlap count (state.ts plainTitleOverlap).
  readonly titleScores: Map<string, number>;
  readonly titleMatchedTerms: Map<string, string[]>;
}

const computeVisitSignals = (input: ScoreVisitInput, state: AttributionV1State): VisitSignals => {
  const domain = input.domain ?? domainOfUrl(input.url);
  const verdict = domain === null ? null : domainVerdict(state, domain);
  const domainWorkstreamId =
    verdict !== null && !verdict.ambiguous ? verdict.workstreamId : null;
  const domainPrecision =
    verdict === null || domainWorkstreamId === null || verdict.assertedTotal === 0
      ? 0
      : Math.min(0.69, verdict.assertedForWinner / verdict.assertedTotal);
  const overlap = plainTitleOverlap(state, input.title.length === 0 ? null : input.title);
  return {
    domain,
    verdict,
    domainWorkstreamId,
    domainPrecision,
    titleScores: overlap.scores,
    titleMatchedTerms: overlap.matchedTerms,
  };
};

// Build the ranked candidate list under the WEIGHTED-SUM combiner: title
// (plain overlap) + conditional-domain (precision-scaled) + recency (flat
// tie-break, gated on another family firing). Shared by scoreVisit.
const buildWeightedCandidates = (
  state: AttributionV1State,
  signals: VisitSignals,
): AttributionV1Candidate[] => {
  const candidates: AttributionV1Candidate[] = [];
  // Union of workstreams that could score: every workstream with a title
  // overlap, plus the unambiguous domain workstream (domain can fire with no
  // title match). Recency alone never manufactures a candidate.
  const candidateIds = new Set<string>(signals.titleScores.keys());
  if (signals.domainWorkstreamId !== null) candidateIds.add(signals.domainWorkstreamId);

  for (const workstreamId of candidateIds) {
    const titleContribution = FAMILY_WEIGHTS.titleLexical * (signals.titleScores.get(workstreamId) ?? 0);

    const domainMatch = signals.domainWorkstreamId === workstreamId;
    const domainContribution = domainMatch
      ? FAMILY_WEIGHTS.conditionalDomain * signals.domainPrecision
      : 0;

    const isRecent = state.lastFiledWorkstreamId === workstreamId;
    // Recency contributes only as a tie-break: a small flat nudge to the
    // last-filed workstream. It must never manufacture a candidate on its
    // own, so it's gated on at least one other family already firing.
    const hasOtherSignal = titleContribution > 0 || domainContribution > 0;
    const recencyContribution = isRecent && hasOtherSignal ? FAMILY_WEIGHTS.recency : 0;

    const score = titleContribution + domainContribution + recencyContribution;
    if (score <= MIN_CANDIDATE_SCORE) continue;

    const labelCount = workstreamLabelCount(state, workstreamId);
    const reasons: AttributionV1Reason[] = [];
    if (titleContribution > 0) {
      const matched = signals.titleMatchedTerms.get(workstreamId) ?? [];
      reasons.push({
        family: 'title-lexical',
        contribution: titleContribution,
        summary: matched.length === 0 ? 'title overlap' : `title terms ${matched.slice(0, 5).join(', ')}`,
      });
    }
    if (domainContribution > 0 && signals.verdict !== null) {
      reasons.push({
        family: 'conditional-domain',
        contribution: domainContribution,
        summary: `domain ${signals.domain} → single workstream (${signals.verdict.assertedForWinner}/${signals.verdict.assertedTotal} asserted, precision ${signals.domainPrecision.toFixed(2)})`,
      });
    }
    if (recencyContribution > 0) {
      reasons.push({ family: 'recency', contribution: recencyContribution, summary: 'last-filed workstream' });
    }

    candidates.push({
      workstreamId,
      score,
      contributions: {
        titleLexical: titleContribution,
        conditionalDomain: domainContribution,
        recency: recencyContribution,
      },
      reasons,
      shrunkPrecision: shrunkPrecision(labelCount),
      labelCount,
    });
  }

  candidates.sort(compareCandidates);
  return candidates;
};

// Optional per-call overrides — the eval harness sweeps the evidence gate to
// report the abstention/precision tradeoff curve. Serving always uses the
// documented constants (no options passed).
export interface ScoreVisitOptions {
  // Override MIN_SUGGEST_SCORE for a threshold-curve measurement.
  readonly minSuggestScore?: number;
}

// The shared abstention + head/tail top-k gate (contract §2: abstention-first,
// matched to the 80.3% base rate). Applied to the top-ranked candidate of
// EITHER combiner so the decision policy is identical across variants.
const decide = (
  candidates: readonly AttributionV1Candidate[],
  options: ScoreVisitOptions = {},
): AttributionV1Result => {
  if (candidates.length === 0) return { action: 'abstain', candidates: [] };
  const minSuggestScore = options.minSuggestScore ?? MIN_SUGGEST_SCORE;
  // Abstention gate (two parts, both must pass):
  //   1. PER-VISIT EVIDENCE: the top candidate's score must clear
  //      MIN_SUGGEST_SCORE. Load-bearing — keys on THIS visit's measured
  //      evidence, so weak matches (the ~80% the owner never files) abstain.
  //   2. PER-WORKSTREAM PRIOR: the top workstream's beta-binomial shrunk
  //      precision must clear SUGGEST_PRECISION_FLOOR (a weak label-count
  //      prior, not per-visit confidence).
  const top = candidates[0]!;
  if (top.score < minSuggestScore || top.shrunkPrecision < SUGGEST_PRECISION_FLOOR) {
    return { action: 'abstain', candidates: [] };
  }
  // Head vs tail: a head workstream (>= HEAD_LABEL_THRESHOLD labels) earns a
  // single top-1 suggestion; a tail workstream widens to top-k so the true
  // target has room to appear (study: tail top-1 ~28%).
  const action: AttributionV1Action =
    top.labelCount >= HEAD_LABEL_THRESHOLD ? 'suggest' : 'topk';
  const width = action === 'suggest' ? 1 : TOPK_WIDTH;
  return { action, candidates: candidates.slice(0, width) };
};

// Score a visit against every workstream in the state and decide an action
// under the WEIGHTED-SUM combiner (the shipping v1 scorer). Pure: no I/O, no
// clock. `state` is the drain-time artifact snapshot.
export const scoreVisit = (
  input: ScoreVisitInput,
  state: AttributionV1State,
  options: ScoreVisitOptions = {},
): AttributionV1Result => {
  const signals = computeVisitSignals(input, state);
  return decide(buildWeightedCandidates(state, signals), options);
};

// The CASCADE combiner (the study's ordered cascade, contract §2 / north-star
// §1 "cascade order dominates: title→session→domain→recency = 45.2%"). Ordered
// semantics: title fires → its plain-overlap answer; else domain-if-unambiguous
// → its answer; else recency → its answer. Whichever tier fires first supplies
// the ranked list; lower tiers only fill the tail for top-k. The SAME
// abstention + head/tail gate then applies, so cascade and weighted-sum differ
// ONLY in how the ranking is formed — an apples-to-apples combiner comparison.
//
// Scored alongside the weighted sum in the harness (the `v1-cascade` arm); we
// adopt whichever wins top-1 at acceptable precision.
export const scoreVisitCascade = (
  input: ScoreVisitInput,
  state: AttributionV1State,
  options: ScoreVisitOptions = {},
): AttributionV1Result => {
  const signals = computeVisitSignals(input, state);

  // Rank the whole title-overlap list first (the dominant tier). Ties within a
  // tier break by label count then id, via compareCandidates on the built list.
  const titleCandidates = buildWeightedCandidates(state, signals).filter(
    (c) => c.contributions.titleLexical > 0,
  );

  // Determine the cascade WINNER (the tier that fires first), then order the
  // ranked list so that winner is at [0]; the remaining title candidates fill
  // the top-k tail (they are the only other real evidence). Domain/recency
  // winners with no title support become a single-candidate list.
  const makeSingle = (
    workstreamId: string,
    family: AttributionV1Family,
    contribution: number,
    summary: string,
  ): AttributionV1Candidate => {
    const labelCount = workstreamLabelCount(state, workstreamId);
    return {
      workstreamId,
      score: contribution,
      contributions: {
        titleLexical: family === 'title-lexical' ? contribution : 0,
        conditionalDomain: family === 'conditional-domain' ? contribution : 0,
        recency: family === 'recency' ? contribution : 0,
      },
      reasons: [{ family, contribution, summary }],
      shrunkPrecision: shrunkPrecision(labelCount),
      labelCount,
    };
  };

  let ranked: AttributionV1Candidate[];
  if (titleCandidates.length > 0) {
    // Title tier fires: its ranking is the cascade answer.
    ranked = titleCandidates;
  } else if (signals.domainWorkstreamId !== null && signals.domainPrecision > 0) {
    // Domain tier (unambiguous single-workstream domain).
    ranked = [
      makeSingle(
        signals.domainWorkstreamId,
        'conditional-domain',
        FAMILY_WEIGHTS.conditionalDomain * signals.domainPrecision,
        `domain ${signals.domain} → single workstream (precision ${signals.domainPrecision.toFixed(2)})`,
      ),
    ];
  } else if (state.lastFiledWorkstreamId !== null) {
    // Recency tier (fallback floor).
    ranked = [
      makeSingle(state.lastFiledWorkstreamId, 'recency', FAMILY_WEIGHTS.recency, 'last-filed workstream'),
    ];
  } else {
    ranked = [];
  }

  return decide(ranked, options);
};

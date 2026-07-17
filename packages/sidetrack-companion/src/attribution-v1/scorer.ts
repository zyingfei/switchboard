// Attribution v1 — the scorer (pure, unit-testable).
//
// A fixed, explainable three-family model over the derived state
// (state.ts), justified by the 2026-07-14 vault study (docs/design/
// 2026-07-13-context-model-north-star.md §2). SHADOW ONLY this wave — the
// incumbent resolver keeps serving; nothing here changes what serves.
//
// Families (contract §2, "the v1 model our data justifies and nothing
// more"):
//   1. TITLE-LEXICAL (primary): BM25-flavored overlap between the visit
//      title and each workstream's member titles, using cross-workstream
//      IDF so venue/hub terms self-suppress. The study's best cold signal
//      (40.0% top-1 alone).
//   2. CONDITIONAL DOMAIN: fires ONLY when the domain historically maps to
//      a single workstream (the 69%-precision regime); hard-suppressed on
//      measured-ambiguous hubs (21% precision). Domains are venues.
//   3. RECENCY: the last-filed workstream as a small tie-break / fallback
//      (38.3% floor, orthogonal, free).
//
// COMBINER: a fixed weighted sum with title-lexical dominant (the doc's
// "ordered-cascade-as-scores"). Weights are documented constants below; no
// learned combiner in v1 (the LightGBM arbiter is a later trigger).
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
  averageMemberTermCount,
  domainOfUrl,
  domainVerdict,
  termIdf,
  tokenizeTitle,
  workstreamLabelCount,
} from './state.js';

// ---- documented weights & thresholds ----------------------------------

// Family weights for the fixed weighted sum. Title-lexical dominant per the
// contract; conditional-domain is a meaningful but secondary corroborator
// (it only ever contributes in the single-workstream regime); recency is a
// small tie-break. These are NOT tuned — they encode the study's signal
// ordering (title 40.0% > domain-precise 69%-when-fires-but-rare > recency
// 38.3% floor). The domain weight is applied to a precision-scaled unit
// signal, so a precise domain match is a strong but bounded nudge, never a
// title-lexical override.
export const FAMILY_WEIGHTS = {
  titleLexical: 1.0,
  conditionalDomain: 0.6,
  recency: 0.15,
} as const;

// BM25 term-saturation (k1) and length-normalization (b). Standard BM25
// defaults; b is modest because member "documents" are short titles.
const BM25_K1 = 1.2;
const BM25_B = 0.6;

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
// abstention the default. It is calibrated to the study's revealed base rate:
// the owner leaves 80.3% of visited URLs unfiled, so an abstention-first
// scorer should decline on the weak ~80% of matches and suggest only on the
// strong ~20%. On the asserted-edge prequential replay this vault, a floor of
// 2.8 (the p80 of fired top-candidate scores) yields ~80% abstention,
// matching that base rate; below it ⇒ abstain. Without this gate the scorer
// suggested on ~92% of visits (7.7% abstain) — the finding's "near no-op".
// This is a fixed constant, not a per-run tuned value; it encodes the base
// rate the study measured, not this replay's optimum.
export const MIN_SUGGEST_SCORE = 2.8;

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

// ---- title-lexical family (BM25 over the term index) ------------------

interface LexicalScore {
  readonly score: number;
  readonly matchedTerms: readonly string[];
}

// BM25 of the visit title against one workstream's member-title term index.
// Term frequency is the workstream's document frequency for the term (how
// many member titles carry it) — a term shared by many members of a
// workstream is strong evidence for it. IDF is cross-workstream so venues
// self-suppress. Length-normalized by the workstream's member count vs the
// corpus average.
const lexicalScoreForWorkstream = (
  state: AttributionV1State,
  workstreamId: string,
  queryTerms: readonly string[],
  avgMemberTerms: number,
): LexicalScore => {
  const stats = state.workstreams.get(workstreamId);
  if (stats === undefined || stats.memberCount === 0) {
    return { score: 0, matchedTerms: [] };
  }
  // Length component: total distinct-term occurrences in this workstream's
  // members, relative to the corpus average per member. Longer member sets
  // are down-weighted so a catch-all workstream ("ai": 28% of members)
  // doesn't win purely on breadth.
  let workstreamTermMass = 0;
  for (const count of stats.termDocFreq.values()) workstreamTermMass += count;
  const docLen = workstreamTermMass;
  const avgDocLen = avgMemberTerms * Math.max(1, state.totalMemberCount / Math.max(1, state.workstreams.size));
  const norm = BM25_K1 * (1 - BM25_B + (BM25_B * docLen) / Math.max(1, avgDocLen));

  let score = 0;
  const matched: string[] = [];
  for (const term of queryTerms) {
    const tf = stats.termDocFreq.get(term) ?? 0;
    if (tf === 0) continue;
    const idf = termIdf(state, term);
    if (idf <= 0) continue;
    // Normalize tf by the workstream's member count so it reads as
    // "fraction of members carrying the term", saturating via BM25.
    const tfNorm = tf / stats.memberCount;
    const contribution = idf * ((tfNorm * (BM25_K1 + 1)) / (tfNorm + norm));
    if (contribution > 0) {
      score += contribution;
      matched.push(term);
    }
  }
  return { score, matchedTerms: matched };
};

// ---- scorer -----------------------------------------------------------

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

// Score a visit against every workstream in the state and decide an action.
// Pure: no I/O, no clock. `state` is the drain-time artifact snapshot.
export const scoreVisit = (
  input: ScoreVisitInput,
  state: AttributionV1State,
): AttributionV1Result => {
  const queryTerms = [...new Set(tokenizeTitle(input.title))];
  const domain = input.domain ?? domainOfUrl(input.url);
  const verdict = domain === null ? null : domainVerdict(state, domain);
  const avgMemberTerms = averageMemberTermCount(state);

  // Which workstream(s) the domain corroborates (only the single-workstream
  // regime; ambiguous hubs contribute nothing).
  const domainWorkstreamId =
    verdict !== null && !verdict.ambiguous ? verdict.workstreamId : null;
  // Domain precision proxy: winner's asserted share, floored so a
  // single-label domain still gives a modest nudge, capped at the study's
  // 0.69 single-domain precision.
  const domainPrecision =
    verdict === null || domainWorkstreamId === null || verdict.assertedTotal === 0
      ? 0
      : Math.min(0.69, verdict.assertedForWinner / verdict.assertedTotal);

  const candidates: AttributionV1Candidate[] = [];
  for (const workstreamId of state.workstreams.keys()) {
    const lexical = lexicalScoreForWorkstream(state, workstreamId, queryTerms, avgMemberTerms);
    const titleContribution = FAMILY_WEIGHTS.titleLexical * lexical.score;

    const domainMatch = domainWorkstreamId === workstreamId;
    const domainContribution = domainMatch
      ? FAMILY_WEIGHTS.conditionalDomain * domainPrecision
      : 0;

    const isRecent = state.lastFiledWorkstreamId === workstreamId;
    // Recency contributes only as a tie-break: a small flat nudge to the
    // last-filed workstream. It must never manufacture a candidate on its
    // own, so it's gated on at least one other family already firing.
    const hasOtherSignal = titleContribution > 0 || domainContribution > 0;
    const recencyContribution =
      isRecent && hasOtherSignal ? FAMILY_WEIGHTS.recency : 0;

    const score = titleContribution + domainContribution + recencyContribution;
    if (score <= MIN_CANDIDATE_SCORE) continue;

    const labelCount = workstreamLabelCount(state, workstreamId);
    const reasons: AttributionV1Reason[] = [];
    if (titleContribution > 0) {
      reasons.push({
        family: 'title-lexical',
        contribution: titleContribution,
        summary:
          lexical.matchedTerms.length === 0
            ? 'title overlap'
            : `title terms ${lexical.matchedTerms.slice(0, 5).join(', ')}`,
      });
    }
    if (domainContribution > 0 && verdict !== null) {
      reasons.push({
        family: 'conditional-domain',
        contribution: domainContribution,
        summary: `domain ${domain} → single workstream (${verdict.assertedForWinner}/${verdict.assertedTotal} asserted, precision ${domainPrecision.toFixed(2)})`,
      });
    }
    if (recencyContribution > 0) {
      reasons.push({
        family: 'recency',
        contribution: recencyContribution,
        summary: 'last-filed workstream',
      });
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

  if (candidates.length === 0) {
    return { action: 'abstain', candidates: [] };
  }

  // Abstention gate (two parts, both must pass — matches the 80.3%
  // never-organized base rate):
  //   1. PER-VISIT EVIDENCE: the top candidate's score must clear
  //      MIN_SUGGEST_SCORE. This is the load-bearing gate — it keys on THIS
  //      visit's measured evidence, so weak matches (the ~80% the owner never
  //      files) abstain. Checked first because it does the abstaining.
  //   2. PER-WORKSTREAM PRIOR: the top workstream's beta-binomial shrunk
  //      precision must clear SUGGEST_PRECISION_FLOOR. This filters out
  //      workstreams with too little history to trust; it is a weak prior on
  //      the label count, not per-visit confidence.
  const top = candidates[0]!;
  if (top.score < MIN_SUGGEST_SCORE || top.shrunkPrecision < SUGGEST_PRECISION_FLOOR) {
    return { action: 'abstain', candidates: [] };
  }

  // Head vs tail: a head workstream (>= HEAD_LABEL_THRESHOLD labels) is
  // trusted for a single top-1 suggestion; a tail workstream widens to
  // top-k so the true target has room to appear (study: tail top-1 ~28%).
  const action: AttributionV1Action =
    top.labelCount >= HEAD_LABEL_THRESHOLD ? 'suggest' : 'topk';
  const width = action === 'suggest' ? 1 : TOPK_WIDTH;
  return { action, candidates: candidates.slice(0, width) };
};

// Keyword-profile signal — prototype lane v2
// (docs/plans/2026-08-16-category-flexibility-hyde.md §11).
//
// WHAT THIS ADDS. Vector similarity alone renders three unrelated
// workstreams as three confident ~0.82s when their prototype text happens to
// share register (day-one evidence: meta-register generation angles like
// "theme-description" produce generic prose near every tech page). A
// discrete, self-explaining signal — which CONCEPTS a page's own keywords
// share with a workstream's own keyword vocabulary — is a second, mostly
// independent axis: two pages can score similarly on cosine while sharing
// zero concrete terminology, or vice versa.
//
// TF-IDF OVER THE WORKSTREAM CORPUS, NOT THE PAGE CORPUS. "Document
// frequency" here means: how many WORKSTREAMS contain this concept at all
// (not how many pages). A concept present in every workstream ("guide",
// "tutorial", "overview" style terms an LLM keyword-extractor tends to emit
// everywhere) is exactly the meta-register-prose failure mode restated in
// keyword form — idf smoothing is chosen so such a concept contributes
// (near-)ZERO weight, same standing as the vector lane's own generic-prose
// problem, fixed the same way: down-weight what is not distinctive.
//
// BLEND, SAME ENV-KNOB IDIOM AS SIDETRACK_KEYWORD_CLUSTER_WEIGHT
// (splitSuggestionEngine.ts): named `..._ENV` constant, `DEFAULT_*`
// fallback, 0..1 range-validated, garbage/absent falls back silently. The
// two knobs are DELIBERATELY separate — splitSuggestionEngine.ts's blends
// PAIRWISE page-to-page distance for clustering; this blends ONE page's
// concepts against an aggregated WORKSTREAM profile for lane scoring. Same
// shape, different denominator, so they must be independently tunable.

// NOTE: deliberately does NOT import keywordConcepts.ts's conceptJaccard —
// that primitive is pairwise (two evidence items) and is the right shape for
// splitSuggestionEngine.ts's clustering distance, not for scoring one page
// against a many-member AGGREGATED profile, which is what this module does
// instead (see scorePageAgainstProfile).

export const PROTOTYPE_KEYWORD_WEIGHT_ENV = 'SIDETRACK_PROTOTYPE_KEYWORD_WEIGHT';
export const DEFAULT_PROTOTYPE_KEYWORD_WEIGHT = 0.3;

/** Parse SIDETRACK_PROTOTYPE_KEYWORD_WEIGHT — a 0..1 blend weight, same
 *  env-knob shape as splitSuggestionEngine.ts's resolveKeywordClusterWeight. */
export const resolvePrototypeKeywordWeight = (): number => {
  const raw = process.env[PROTOTYPE_KEYWORD_WEIGHT_ENV];
  if (raw === undefined || raw === '') return DEFAULT_PROTOTYPE_KEYWORD_WEIGHT;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return DEFAULT_PROTOTYPE_KEYWORD_WEIGHT;
  return parsed;
};

/** One (raw keyword, its resolved concept id) pair for a single member —
 *  the exact join a caller gets by pairing keywordIndexStore's per-page
 *  raw keyword list with keywordConceptStore.conceptForKeyword for each
 *  one. Kept as a PAIR (not two parallel arrays) so a keyword can never be
 *  mis-attributed to a concept it does not actually belong to when a member
 *  carries several keywords mapping to several different concepts. */
export interface WorkstreamKeywordPair {
  readonly keyword: string;
  readonly conceptId: string;
}

/** One workstream member, reduced to its keyword/concept pairs. A keyword
 *  the concept store has not assigned yet (conceptForKeyword returned
 *  undefined) is simply omitted by the caller before this point — scoring
 *  reads conceptIds exclusively, matching keywordConcepts.ts's documented
 *  "concept ids for scoring, raw keywords for naming" rule. */
export interface WorkstreamKeywordMember {
  readonly pairs: readonly WorkstreamKeywordPair[];
}

export interface PrototypeKeywordProfile {
  /** conceptId -> tf(concept in this workstream) * idf(concept). */
  readonly weights: ReadonlyMap<string, number>;
  /** conceptId -> a representative raw keyword for why-string display,
   *  chosen as this workstream's OWN most frequent raw keyword mapping to
   *  that concept (ties broken lexicographically for determinism). */
  readonly displayKeyword: ReadonlyMap<string, string>;
}

export interface PrototypeKeywordProfileSet {
  readonly profiles: ReadonlyMap<string, PrototypeKeywordProfile>;
  /** conceptId -> idf, shared across every workstream's profile — exposed
   *  so a page's OWN concept weights (scorePageAgainstProfile's first arg)
   *  can be built with the identical idf table the profiles were. */
  readonly idf: ReadonlyMap<string, number>;
}

/**
 * Build one keyword-concept profile per workstream, plus the shared idf
 * table concepts are weighted against. Pure — no I/O, no embedder, no
 * store handle; callers join `keywordIndexStore`/`keywordConceptStore`
 * results into `WorkstreamKeywordMember` shape before calling this.
 *
 * IDF, PRECISELY: df(concept) = number of DISTINCT workstreams that contain
 * it at least once (not member/page count). Smoothed
 * `idf = ln((N + 1) / (df + 1))` — a concept present in EVERY workstream has
 * df === N, giving `ln((N+1)/(N+1)) = ln(1) = 0` EXACTLY, not merely small:
 * such a concept contributes precisely zero to every profile weight and
 * every page score, regardless of how often it recurs.
 */
export const buildWorkstreamConceptProfiles = (
  byWorkstream: ReadonlyMap<string, readonly WorkstreamKeywordMember[]>,
): PrototypeKeywordProfileSet => {
  const workstreamCount = byWorkstream.size;
  const workstreamsContainingConcept = new Map<string, number>();
  for (const members of byWorkstream.values()) {
    const seenInThisWorkstream = new Set<string>();
    for (const member of members) {
      for (const pair of member.pairs) seenInThisWorkstream.add(pair.conceptId);
    }
    for (const conceptId of seenInThisWorkstream) {
      workstreamsContainingConcept.set(conceptId, (workstreamsContainingConcept.get(conceptId) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  for (const [conceptId, df] of workstreamsContainingConcept) {
    idf.set(conceptId, Math.log((workstreamCount + 1) / (df + 1)));
  }

  const profiles = new Map<string, PrototypeKeywordProfile>();
  for (const [workstreamId, members] of byWorkstream) {
    const tf = new Map<string, number>();
    const keywordCountsByConceptId = new Map<string, Map<string, number>>();
    for (const member of members) {
      // Each member contributes each of ITS OWN concept ids once (a member
      // repeating the same concept via two synonymous keywords still counts
      // as one occurrence of that concept for THIS member) — dedupe within
      // the member before folding into tf.
      const memberConceptIds = new Set(member.pairs.map((pair) => pair.conceptId));
      for (const conceptId of memberConceptIds) {
        tf.set(conceptId, (tf.get(conceptId) ?? 0) + 1);
      }
      for (const { keyword, conceptId } of member.pairs) {
        let perConcept = keywordCountsByConceptId.get(conceptId);
        if (perConcept === undefined) {
          perConcept = new Map();
          keywordCountsByConceptId.set(conceptId, perConcept);
        }
        perConcept.set(keyword, (perConcept.get(keyword) ?? 0) + 1);
      }
    }

    const weights = new Map<string, number>();
    for (const [conceptId, count] of tf) {
      weights.set(conceptId, count * (idf.get(conceptId) ?? 0));
    }

    const displayKeyword = new Map<string, string>();
    for (const [conceptId, counts] of keywordCountsByConceptId) {
      let bestKeyword: string | null = null;
      let bestCount = -1;
      for (const [keyword, count] of [...counts.entries()].sort((left, right) =>
        left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
      )) {
        if (count > bestCount) {
          bestCount = count;
          bestKeyword = keyword;
        }
      }
      if (bestKeyword !== null) displayKeyword.set(conceptId, bestKeyword);
    }

    profiles.set(workstreamId, { weights, displayKeyword });
  }

  return { profiles, idf };
};

export interface PrototypeKeywordScore {
  /** Weighted-overlap fraction, bounded [0,1] — see scorePageAgainstProfile. */
  readonly score: number;
  /** Concept ids that matched, ordered by their contribution to the score
   *  (idf-weighted), descending — the ordering a why-string picks its top-N
   *  from. */
  readonly matchedConceptIds: readonly string[];
}

const ZERO_SCORE: PrototypeKeywordScore = { score: 0, matchedConceptIds: [] };

/**
 * Score one page's own concept ids against a workstream's profile.
 *
 * `score = sum(idf(c) for c in intersection) / sum(idf(c) for c in page)` —
 * the fraction of the PAGE's own idf-weighted concept mass that the
 * workstream's profile also carries. Bounded [0,1] by construction (the
 * numerator is a subset sum of the denominator). A concept with idf===0
 * (present in every workstream) contributes zero to BOTH sums, so it can
 * neither inflate nor deflate the ratio — "contributes ~0" precisely, not
 * merely approximately.
 */
export const scorePageAgainstProfile = (
  pageConceptIds: readonly string[],
  idf: ReadonlyMap<string, number>,
  profile: PrototypeKeywordProfile,
): PrototypeKeywordScore => {
  if (pageConceptIds.length === 0) return ZERO_SCORE;
  const distinctPageConcepts = [...new Set(pageConceptIds)];
  let denominator = 0;
  for (const conceptId of distinctPageConcepts) denominator += idf.get(conceptId) ?? 0;
  if (denominator <= 0) return ZERO_SCORE;

  const matched: { readonly conceptId: string; readonly weight: number }[] = [];
  let numerator = 0;
  for (const conceptId of distinctPageConcepts) {
    if (!profile.weights.has(conceptId)) continue;
    const weight = idf.get(conceptId) ?? 0;
    if (weight <= 0) continue;
    numerator += weight;
    matched.push({ conceptId, weight });
  }
  if (matched.length === 0) return ZERO_SCORE;
  matched.sort((left, right) =>
    right.weight !== left.weight ? right.weight - left.weight : left.conceptId < right.conceptId ? -1 : 1,
  );
  const score = numerator / denominator;
  return {
    score: score < 0 ? 0 : score > 1 ? 1 : score,
    matchedConceptIds: matched.map((m) => m.conceptId),
  };
};

/** "matches duckdb, olap from this workstream's pages" — the top-N matched
 *  concepts' display keywords, self-explaining rather than a bare number. */
export const keywordMatchWhy = (
  matchedConceptIds: readonly string[],
  displayKeyword: ReadonlyMap<string, string>,
  maxTerms: number = 3,
): string | null => {
  const terms = matchedConceptIds
    .map((conceptId) => displayKeyword.get(conceptId))
    .filter((term): term is string => term !== undefined)
    .slice(0, maxTerms);
  if (terms.length === 0) return null;
  return `matches ${terms.join(', ')} from this workstream's pages`;
};

/**
 * Blend a vector-lane score with a keyword-profile score using the
 * standard env-weighted idiom. When `keywordScore` is 0 (no page concepts,
 * no workstream profile overlap, or the feature has no data yet) the blend
 * degrades to the vector score UNCHANGED — identical to pre-keyword-layer
 * behavior, same "vectors only" fallback contract
 * splitSuggestionEngine.ts's hybridSimilarity documents.
 */
export const blendVectorAndKeywordScore = (
  vectorScore: number,
  keywordScore: number,
  weight: number = resolvePrototypeKeywordWeight(),
): number => {
  if (keywordScore <= 0) return vectorScore;
  const blended = (1 - weight) * vectorScore + weight * keywordScore;
  return blended < 0 ? 0 : blended > 1 ? 1 : blended;
};

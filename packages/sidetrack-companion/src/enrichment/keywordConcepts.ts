// Concept normalization — pure assignment math for the keyword layer
// (docs/plans/2026-08-16-category-flexibility-hyde.md, keyword section).
//
// WHY CONCEPTS AT ALL. Two pages using "k8s" and "kubernetes" are about the
// same thing, but a raw-keyword posting-list join treats them as unrelated —
// the exact sparsity problem this whole feature exists to fix. The fix is
// NOT a synonym dictionary (unmaintainable, English-only, silently wrong for
// zh) — it is embedding EACH DISTINCT KEYWORD once (the vocabulary is small
// relative to the page corpus: dozens to low thousands of distinct terms,
// not hundreds of thousands of pages) and assigning it to a concept id via
// cosine-threshold against INCREMENTAL centroids, the same "small model,
// simple stats" doctrine this repo applies everywhere else (see
// suggestions/centroid.ts's meanNormalized, already used for split-
// suggestion naming/scoring). Downstream consumption (the hybrid distance in
// splitSuggestionEngine.ts, the aggregator entropy shadow signal) uses
// CONCEPT ids; the raw keyword strings are kept only for display/naming —
// binding doctrine: the LLM (gist keywords) is the offline feature
// extractor, everything downstream is deterministic stats.
//
// INCREMENTAL, ONE KEYWORD AT A TIME. A new distinct keyword is compared
// against every EXISTING concept centroid (cheap — the whole point of a
// small vocabulary) and joins the best match above `threshold`, or seeds a
// brand-new concept when nothing matches closely enough. This is a classic
// leader/online-clustering assignment (the same family as this repo's
// `SECONDARY_AFFILIATION_MIN_COSINE`/leiden-cpm cosine-threshold gates,
// applied here to a keyword vocabulary instead of a document/topic graph) —
// NOT k-means (no fixed k, no reassignment pass, no full-corpus recompute).
// A keyword's concept assignment, once made, is STABLE unless the keyword
// itself is re-embedded (it never is — embeddings are deterministic given a
// fixed model revision) — this is what "concept stability" means for this
// feature: the SAME keyword always resolves to the SAME concept id across
// repeated calls with an unchanged centroid set, and centroid drift from
// new members never re-litigates an already-assigned keyword's membership.
//
// THRESHOLD. 0.82 is a judgment call (unspecified numerically by the
// directive), chosen conservative-but-not-paralyzing between this repo's
// two nearest precedents — `SECONDARY_AFFILIATION_MIN_COSINE=0.85` (topic
// secondary-affiliation, a stricter "is this basically a duplicate" gate)
// and `DEFAULT_SPLIT_COSINE_THRESHOLD=0.85` inherited from
// `DEFAULT_TOPIC_COSINE_THRESHOLD` (document-level clustering, where
// vectors carry a whole page's semantics and legitimately vary more within
// one topic than two short keyword phrases about the same concept do) —
// flagged here, same as `splitSuggestionEngine.ts`'s own thresholds, for
// golden-set tuning before this signal is promoted past shadow status.

import { cosine, normalize } from '../suggestions/centroid.js';

export const DEFAULT_CONCEPT_COSINE_THRESHOLD = 0.82;

export interface ConceptCentroid {
  readonly conceptId: string;
  readonly centroid: Float32Array;
  readonly memberCount: number;
}

export interface ConceptAssignment {
  /** The concept this keyword joined — an EXISTING concept id, or null when
   *  nothing matched closely enough (the caller must mint a new concept id). */
  readonly matchedConceptId: string | null;
  /** Cosine similarity to the best-matching existing centroid, 0 when there
   *  were no existing centroids to compare against. Reported (not hidden)
   *  so a caller can log "joined at 0.91" vs "no match, best was 0.61". */
  readonly bestSimilarity: number;
}

/**
 * Decide which existing concept (if any) a new keyword's embedding belongs
 * to. Pure — no I/O, no mutation of `existingCentroids`. Ties (equal
 * similarity) break toward the FIRST centroid in iteration order, which
 * callers should supply in a stable order (e.g. by conceptId) so repeated
 * calls over an unchanged centroid set are themselves deterministic.
 */
export const assignConceptForKeyword = (
  embedding: Float32Array,
  existingCentroids: readonly ConceptCentroid[],
  threshold: number = DEFAULT_CONCEPT_COSINE_THRESHOLD,
): ConceptAssignment => {
  let best: ConceptCentroid | null = null;
  let bestSimilarity = 0;
  for (const candidate of existingCentroids) {
    const similarity = cosine(embedding, candidate.centroid);
    if (best === null || similarity > bestSimilarity) {
      best = candidate;
      bestSimilarity = similarity;
    }
  }
  if (best !== null && bestSimilarity >= threshold) {
    return { matchedConceptId: best.conceptId, bestSimilarity };
  }
  return { matchedConceptId: null, bestSimilarity: best === null ? 0 : bestSimilarity };
};

/**
 * Fold one new member into a concept's centroid — a weighted running mean,
 * re-normalized to unit length (the SAME "mean then normalize" shape
 * `suggestions/centroid.ts`'s `meanNormalized` uses for a batch; this is its
 * incremental equivalent, so a concept's centroid never needs every member
 * embedding retained, only the running centroid + a count). Pass
 * `existing: null` to seed a brand-new concept from its first member.
 */
export const foldConceptMember = (
  conceptId: string,
  existing: ConceptCentroid | null,
  newEmbedding: Float32Array,
): ConceptCentroid => {
  if (existing === null) {
    return { conceptId, centroid: normalize(newEmbedding), memberCount: 1 };
  }
  const n = existing.memberCount;
  const dim = Math.max(existing.centroid.length, newEmbedding.length);
  const merged = new Float32Array(dim);
  for (let i = 0; i < dim; i += 1) {
    merged[i] = ((existing.centroid[i] ?? 0) * n + (newEmbedding[i] ?? 0)) / (n + 1);
  }
  return { conceptId, centroid: normalize(merged), memberCount: n + 1 };
};

/** Concept-id sets for two evidence items — the raw ingredient of concept-
 *  Jaccard (splitSuggestionEngine.ts's hybrid distance, item 4). Kept here
 *  (not duplicated) since it is purely a function of two concept-id lists. */
export const conceptJaccard = (
  left: readonly string[],
  right: readonly string[],
): number => {
  if (left.length === 0 && right.length === 0) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const id of leftSet) {
    if (rightSet.has(id)) intersection += 1;
  }
  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : intersection / union;
};

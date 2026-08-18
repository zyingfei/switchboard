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
// THRESHOLD — 0.92, EMPIRICALLY CALIBRATED (2026-08-17 incident; see
// docs/plans/2026-08-16-category-flexibility-hyde.md §12 addendum for the
// full writeup). The original 0.82 was a judgment call carried over from
// two document/topic-level precedents (`SECONDARY_AFFILIATION_MIN_COSINE`,
// `DEFAULT_SPLIT_COSINE_THRESHOLD`, both 0.85) and turned out to be
// CATASTROPHICALLY wrong for this input class: a live vault collapsed 360
// distinct keywords into ONE concept. Root cause, confirmed by embedding
// real keywords through the actual production embedder
// (multilingual-e5-small) and printing pairwise cosines: BARE, isolated
// single-word inputs (no sentence context) wrapped in the E5 "query: "
// prefix have a baseline noise floor of ~0.78-0.87 cosine EVEN BETWEEN
// TOTALLY UNRELATED WORDS (e.g. cos("kubernetes","visa")=0.811,
// cos("security","travel")=0.874) — a range that fully overlaps, and
// sometimes exceeds, genuinely related pairs (cos("kubernetes","docker")
// =0.839, cos("kubernetes","k8s")=0.864). Because concept assignment is
// GREEDY ONLINE-LEADER CLUSTERING (join the first centroid scoring above
// threshold, then fold into its running-mean centroid), any threshold at
// or below that noise floor creates a SELF-REINFORCING RUNAWAY: the first
// concept's centroid drifts toward the model's shared "generic word"
// direction with every fold, which makes the NEXT arbitrary keyword's
// cosine to it climb even higher (measured 0.83 -> 0.93 over 20 sequential
// folds), so it never stops absorbing new members. Sweeping the real
// 360-keyword vocabulary through this exact algorithm at several
// thresholds: 0.82/0.86/0.88/0.90 all still produced one dominant "hub"
// concept holding 59-100% of the vocabulary; 0.92 is the first value where
// that hub effect breaks (298 concepts, largest holds 5.0% of the
// vocabulary) and groupings start looking semantically sane (e.g.
// "code"/"coding", "outperform"/"outperforms"). This is a real, measured
// trade-off, not a guess: 0.92 will legitimately MISS some synonym pairs a
// human would merge (e.g. "kubernetes"/"k8s" at 0.864 now falls short) —
// accepted deliberately, because under-merging (a missed synonym pair) is
// a bounded, low-cost failure, while over-merging at the old threshold was
// unbounded and destroyed every downstream discrimination signal that
// consumes concept ids. Re-flagged here for golden-set tuning, same as
// before, but now anchored to measured evidence instead of a guess.

import { cosine, normalize } from '../suggestions/centroid.js';

export const DEFAULT_CONCEPT_COSINE_THRESHOLD = 0.92;

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

// ---------------------------------------------------------------------------
// DEGENERATE-INPUT GUARDS (2026-08-17 incident addendum). A cosine-threshold
// assignment scheme has no way to tell "these embeddings are genuinely
// near-duplicate" apart from "these embeddings are garbage that happens to
// collide" — the live collapse above was of the SECOND kind (functionally,
// not literally: real, finite, non-zero vectors whose baseline similarity
// distribution simply overlapped the merge threshold). These guards catch
// the FAILURE SHAPES that must never be allowed to fold into a centroid
// silently: a literally unusable embedding (all-zero/non-finite), and an
// embedder that returns the SAME vector for multiple genuinely different
// keywords (the literal version of hypothesis (a) this incident's directive
// named — a fallback/degraded embedder path). Callers (keywordIngest.ts's
// live-ingest hook, keywordConceptStore.ts's self-heal repair) check these
// BEFORE folding anything into a centroid, and log audibly instead of
// merging quietly.
// ---------------------------------------------------------------------------

const magnitude = (vector: Float32Array): number => {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
};

/**
 * True when an embedding is unusable for concept assignment: empty,
 * all-zero (within floating-point noise), or contains a non-finite value.
 * Folding a degenerate embedding into a centroid corrupts that concept for
 * every future comparison — normalize() would divide by ~0 or propagate
 * NaN, and every subsequent cosine against that centroid becomes
 * meaningless. Callers must skip (never invent) rather than assign.
 */
export const isDegenerateEmbedding = (vector: Float32Array): boolean => {
  if (vector.length === 0) return true;
  let sawNonZero = false;
  for (const value of vector) {
    if (!Number.isFinite(value)) return true;
    if (value !== 0) sawNonZero = true;
  }
  return !sawNonZero || magnitude(vector) < 1e-6;
};

/**
 * True when a batch of 2+ embeddings are all (near-)identical to the
 * first — the signature of an embedder that returns a CONSTANT output
 * regardless of input text (e.g. a silently-degraded fallback vector),
 * which cosine-threshold assignment cannot distinguish from "these
 * keywords are genuinely the same concept" without an explicit check. A
 * single-vector batch is never flagged here (nothing to compare against —
 * see isDegenerateEmbedding for the single-vector unusable case).
 */
export const isIdenticalVectorBatch = (vectors: readonly Float32Array[]): boolean => {
  const usable = vectors.filter((vector) => !isDegenerateEmbedding(vector));
  if (usable.length < 2) return false;
  const first = normalize(usable[0]!);
  return usable.every((vector) => cosine(normalize(vector), first) >= 0.999999);
};

/** Below this distinct-keyword count, resolving to a single concept is
 *  plausible on its own merits (a small vocabulary CAN genuinely be one
 *  topic) — the degenerate-distribution check only fires past this floor,
 *  same shape as the directive's own repair-trigger example. */
export const CONCEPT_DISTRIBUTION_MIN_DISTINCT_KEYWORDS = 20;

/**
 * True when a keyword-concept store's aggregate shape indicates the
 * online-clustering assignment has collapsed — nearly every distinct
 * keyword landing in a single concept. This is the exact aggregate
 * signature the live 2026-08-17 incident showed (360 keywords / 1
 * concept) and is checked BOTH as an ongoing audible guard during live
 * ingest (keywordIngest.ts) and as the one-time self-heal trigger at
 * keyword-backfill scheduler startup (keywordBackfillLane.ts) — the SAME
 * predicate drives both so the "warn" and "repair" decisions never drift
 * apart.
 */
export const isConceptDistributionDegenerate = (
  distinctKeywords: number,
  distinctConcepts: number,
  minDistinctKeywords: number = CONCEPT_DISTRIBUTION_MIN_DISTINCT_KEYWORDS,
): boolean => distinctKeywords > minDistinctKeywords && distinctConcepts <= 1;

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

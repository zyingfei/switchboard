// Split / new-category suggestion engine — docs/plans/2026-08-16-category-
// flexibility-hyde.md §4. Stats only, no LLM (naming is a structural
// fallback here; LLM naming is explicitly deferred, offline+optional, per
// the design).
//
// STRUCTURAL SIGNAL FIRST. Reuses the density-connected-components
// primitive extracted from `connections/hdbscanClusterer.ts`
// (`densityConnectedComponents` — mutual-reachability MST, cosine-threshold
// cut, HDBSCAN's own density definition, no new metric) re-scoped to a
// single caller-supplied evidence pool instead of the whole vault.
//
//   - SPLIT: pool = one workstream's own evidence embeddings. Fires only
//     when clustering finds >= 2 qualifying sub-clusters — a single blob is
//     a legitimately cohesive workstream (the design's negative control),
//     not a split candidate.
//   - NEW-CATEGORY: same machinery, pool = evidence with NO existing
//     membership anywhere (the resolver's unaffiliated/abstained set).
//     Fires on a single qualifying cluster — there is no "existing whole"
//     to compare it against.
//
// STABILITY GATING. A candidate must be seen across >=
// `stabilityMinConsecutive` CONSECUTIVE recomputations (matched across
// rounds by member-set Jaccard overlap, not exact-fingerprint equality —
// membership drifts a little as new evidence arrives) before it is allowed
// to emit. Once emitted, it never re-emits ("stable ones emit once, not
// repeatedly") — `SuggestionCandidateRecord.emitted` is sticky.
//
// DIRTY-MARKING. `revisionId` is the caller's hash of the scope's evidence
// (e.g. a fold of the workstream's membership revision + evidence
// embedding revision). When it matches the persisted
// `lastComputedRevision`, this function returns immediately without
// touching the clusterer or the store — "incremental recompute only when
// the workstream's evidence changed ... no sweeps".
//
// OUT OF SCOPE HERE (deliberately): pulling live evidence embeddings for a
// workstream from recall-v2 / page-evidence, and gathering the vault-wide
// "unaffiliated" pool for new-category from the resolver's abstain set.
// Both are real-data wiring concerns that touch files outside this PR's
// scope (recall-v2 store is a concurrently-developed sibling area); this
// engine takes `evidence` as a plain input so that wiring can be added
// later without changing the stats/stability core.

import {
  densityConnectedComponents,
  HDBSCAN_TOPIC_MIN_SAMPLES,
  type DensitySimilarityEdge,
} from '../connections/hdbscanClusterer.js';
import { conceptJaccard } from '../enrichment/keywordConcepts.js';
import { DEFAULT_TOPIC_COSINE_THRESHOLD } from '../producers/topic-revision.js';
import { jaccard, normalizeTokens } from '../suggestions/tokens.js';
import { pageWorkstreamScore, resolveLateInteractionTopK, symmetricSentenceScore } from './sentenceInteraction.js';
import type {
  SuggestionCandidateKind,
  SuggestionCandidateRecord,
  SuggestionCandidateStore,
} from './suggestionCandidateStore.js';

// ---------------------------------------------------------------------------
// Hybrid distance (2026-08-16, "gist keywords as sparse-data clustering
// features"). ADDITIVE to the scoring internals below — see hybridSimilarity
// for the exact formula. This is the fix for the doc-vector coverage gap
// named in the feature review (~16% of pages have an embedding at all):
// concept-Jaccard over gist keywords is meaningful at 3-5 samples where
// cosine similarity has nothing to compare, because keyword extraction runs
// for every page with a gist while embeddings only exist where recall-v2 has
// indexed one.
// ---------------------------------------------------------------------------

export const KEYWORD_CLUSTER_WEIGHT_ENV = 'SIDETRACK_KEYWORD_CLUSTER_WEIGHT';
export const DEFAULT_KEYWORD_CLUSTER_WEIGHT = 0.35;

/** Parse SIDETRACK_KEYWORD_CLUSTER_WEIGHT — a 0..1 blend weight, same
 *  env-knob shape as topic-revision.ts's resolveTopicCosineThreshold
 *  (named `..._ENV` constant, `DEFAULT_*` fallback, range-validated,
 *  garbage/absent both fall back silently rather than throwing). */
export const resolveKeywordClusterWeight = (): number => {
  const raw = process.env[KEYWORD_CLUSTER_WEIGHT_ENV];
  if (raw === undefined || raw === '') return DEFAULT_KEYWORD_CLUSTER_WEIGHT;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return DEFAULT_KEYWORD_CLUSTER_WEIGHT;
  return parsed;
};

const hasNonZeroVector = (vector: Float32Array): boolean => {
  if (vector.length === 0) return false;
  for (const value of vector) {
    if (value !== 0) return true;
  }
  return false;
};

export const DEFAULT_SPLIT_COSINE_THRESHOLD = DEFAULT_TOPIC_COSINE_THRESHOLD;
export const DEFAULT_SPLIT_MIN_SAMPLES = HDBSCAN_TOPIC_MIN_SAMPLES;
// "each above a minimum member count (tune against the golden set, starting
// above HDBSCAN_TOPIC_MIN_SAMPLES=3 since 'worth splitting' is a higher bar
// than 'is a cluster')" — design §4. ENV-TUNABLE (2026-08-17,
// SIDETRACK_SUGGESTION_MIN_MEMBERS — see resolveSuggestionMinClusterMembers
// below) but the DEFAULT is unchanged: unlike the stability gate below, a
// structurally-too-small cluster is still noise no matter how cheap
// dismissal is, so only "how many times has this looked the same" loosens
// by default, not "how big must it be."
export const DEFAULT_MIN_CLUSTER_MEMBERS = HDBSCAN_TOPIC_MIN_SAMPLES + 1;

// ---- stability gate — LIBERAL BY DEFAULT (2026-08-17 scope decision) -----
//
// WAS a conservative judgment call: three consecutive stable computations
// before a suggestion is allowed to surface at all — "conservative defaults
// (no suggestion fires below stability threshold)" (original §4 design).
//
// NOW default 1 (surfaces on a candidate's FIRST qualifying computation).
// Rationale: per-workstream/population decline memory (isSuppressedByDecline
// below, backed by suggestionCandidateStore.ts's declineCandidate +
// declinedConceptSets) makes a WRONG suggestion nearly free to dismiss — one
// click, and that concept-set never resurfaces for this scope+kind again.
// Heavy stability gating was withholding value (every genuinely-good split/
// new-category candidate waited N-1 extra recompute cycles — at this
// engine's suggestionRecomputeLane.ts cadence, minutes) to guard against a
// cost — an unwanted suggestion visible for one cycle — that the decline UI
// already makes cheaper than the gate itself. Declined signatures stay
// suppressed exactly as before; only the FIRST-time-surfacing bar moved.
// Tunable back up via SIDETRACK_SUGGESTION_STABILITY for anyone who wants
// the old conservative cadence (or a stricter one).
export const SUGGESTION_STABILITY_ENV = 'SIDETRACK_SUGGESTION_STABILITY';
export const DEFAULT_STABILITY_MIN_CONSECUTIVE = 1;

/** Parse SIDETRACK_SUGGESTION_STABILITY — a >=1 integer count of consecutive
 *  stable computations required before a candidate is allowed to emit.
 *  Absent/garbage/<1 all fall back to the liberal default (1), same
 *  silent-fallback idiom as resolveKeywordClusterWeight. */
export const resolveSuggestionStabilityMinConsecutive = (): number => {
  const raw = process.env[SUGGESTION_STABILITY_ENV];
  if (raw === undefined || raw === '') return DEFAULT_STABILITY_MIN_CONSECUTIVE;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_STABILITY_MIN_CONSECUTIVE;
  return parsed;
};

// Floor for SIDETRACK_SUGGESTION_MIN_MEMBERS below — never below the density
// primitive's own min-samples (HDBSCAN_TOPIC_MIN_SAMPLES): a cluster smaller
// than that isn't a cluster by the clustering primitive's own definition,
// regardless of operator intent.
export const SUGGESTION_MIN_MEMBERS_ENV = 'SIDETRACK_SUGGESTION_MIN_MEMBERS';
export const SUGGESTION_MIN_MEMBERS_FLOOR = HDBSCAN_TOPIC_MIN_SAMPLES;

/** Parse SIDETRACK_SUGGESTION_MIN_MEMBERS. Absent/garbage/below-floor all
 *  fall back to DEFAULT_MIN_CLUSTER_MEMBERS (unchanged from the original
 *  design) — this knob only ever WIDENS the floor above the default's own
 *  conservative value, it does not narrow it below SUGGESTION_MIN_MEMBERS_FLOOR. */
export const resolveSuggestionMinClusterMembers = (): number => {
  const raw = process.env[SUGGESTION_MIN_MEMBERS_ENV];
  if (raw === undefined || raw === '') return DEFAULT_MIN_CLUSTER_MEMBERS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < SUGGESTION_MIN_MEMBERS_FLOOR) {
    return DEFAULT_MIN_CLUSTER_MEMBERS;
  }
  return parsed;
};
// How much member-set overlap counts as "the same emerging cluster" across
// rounds despite a little membership drift.
export const DEFAULT_MATCH_OVERLAP_MIN_JACCARD = 0.75;
// Same numeric judgment call as DEFAULT_MATCH_OVERLAP_MIN_JACCARD, kept as
// its own named constant (not a re-export) so the two can diverge under
// golden-set tuning without one silently dragging the other. Concept-
// Jaccard, not member-id Jaccard: "substantially the same" is about WHAT the
// cluster is about, not literally the same page ids (new pages can join a
// declined topic and it is still the same declined topic).
export const DEFAULT_DECLINE_CONCEPT_OVERLAP_THRESHOLD = 0.75;
// Below this many evidence items in the scope, never even attempt
// clustering — cold-start = no suggestions. Just above
// HDBSCAN_TOPIC_MIN_SAMPLES, matching the design §6 risk-2 floor.
export const DEFAULT_MIN_EVIDENCE_TO_ATTEMPT = 5;

export interface SuggestionEvidenceItem {
  readonly id: string;
  readonly embedding: Float32Array;
  readonly title?: string;
  /** Concept ids (keywordConcepts.ts) for this item's gist keywords, when
   *  the keyword layer has processed it. Additive: absent on every item ⇒
   *  hybridSimilarity behaves EXACTLY like the pre-existing pure-cosine
   *  scoring, unchanged. */
  readonly conceptIds?: readonly string[];
  /** Raw (display) keywords for this item, when the keyword layer has
   *  processed it. Used ONLY for cluster naming (keywordNameFor) — never for
   *  scoring, which reads conceptIds instead. */
  readonly keywords?: readonly string[];
  /** Sentence vectors (§12, "the attention of sentence matters") for this
   *  item's title+gist, when the sentence-vector backfill lane
   *  (enrichment/sentenceVectorBackfillLane.ts) has processed it. Additive:
   *  absent (or empty) on either side of a pair ⇒ hybridSimilarity's vector
   *  term falls back to the pre-existing pooled cosine, byte-identical to
   *  before this phase — see vectorSimilarityFor below. NOT the same signal
   *  as `embedding` being present: a page can have sentence vectors (from
   *  its gist) with NO doc-level `embedding` at all (recall-v2 body-vector
   *  coverage is only ~16% of pages per the keyword-clustering PR's own
   *  measurement; the sentence-vector backfill lane is decoupled from that
   *  coverage gap entirely, since it works off gists, not extracted body
   *  content) — see hasVectorSignal below. */
  readonly sentenceEmbeddings?: readonly Float32Array[];
}

export interface RecomputeSuggestionCandidatesOptions {
  readonly cosineThreshold?: number;
  readonly minSamples?: number;
  readonly minClusterMembers?: number;
  readonly stabilityMinConsecutive?: number;
  readonly matchOverlapMinJaccard?: number;
  readonly minEvidenceToAttempt?: number;
  /** 0..1 blend weight for hybridSimilarity — defaults to
   *  resolveKeywordClusterWeight() (the env knob) when omitted. */
  readonly keywordClusterWeight?: number;
  /** Concept-Jaccard overlap at/above which a fresh candidate is treated as
   *  "the same cluster" as a previously-declined one for THIS scope+kind,
   *  and therefore withheld from newlyEmitted (population-scoped decline
   *  memory — see suggestionCandidateStore.ts's declineCandidate). */
  readonly declineConceptOverlapThreshold?: number;
  /** §12 calibrated new-category score — the top-k for BOTH cohesion and
   *  external-best (defaults to resolveLateInteractionTopK() — the SAME env
   *  knob every other late-interaction call site in this feature area
   *  shares). */
  readonly lateInteractionTopK?: number;
  /** §12 — margin cohesion must clear over externalBest before a candidate
   *  is allowed to emit (defaults to resolveSuggestionMargin()). Only
   *  applied when externalBest is non-null for a given candidate — see
   *  RecomputeSuggestionCandidatesInput.existingWorkstreamSentenceVectors's
   *  doc comment for why a null externalBest never blocks emission. */
  readonly suggestionMargin?: number;
}

export interface RecomputeSuggestionCandidatesInput {
  readonly scopeId: string;
  readonly kind: SuggestionCandidateKind;
  readonly evidence: readonly SuggestionEvidenceItem[];
  /** Caller's content hash of the scope's evidence — dirty-marking key. */
  readonly revisionId: string;
  readonly now?: () => number;
  readonly options?: RecomputeSuggestionCandidatesOptions;
  /** §12 — every EXISTING workstream's prototype sentence vectors, keyed by
   *  workstreamId (recall-v2/store/sqlite.ts's sentenceVectorsByWorkstream,
   *  gathered ONCE per (slow, idle-cadence) recompute cycle by the caller —
   *  see suggestionRecomputeLane.ts). Used for computeExternalBest ONLY;
   *  clustering itself (hybridSimilarity/densityConnectedComponents) is
   *  unaffected. OPTIONAL AND LIBERAL BY DEFAULT: omitted, or a scope+kind
   *  where no cluster member has its own sentence vectors yet, means
   *  externalBest is null for every candidate this round and the §12
   *  margin gate never blocks emission — a vault mid-backfill (see
   *  enrichment/sentenceVectorBackfillLane.ts) behaves exactly like a
   *  pre-§12 vault, not a vault that suddenly stops emitting suggestions. */
  readonly existingWorkstreamSentenceVectors?: ReadonlyMap<string, readonly Float32Array[]>;
}

export interface RecomputeSuggestionCandidatesResult {
  /** False when the dirty-marking check short-circuited — nothing was
   * clustered and the store was not touched. */
  readonly recomputed: boolean;
  /** Candidates that FIRST crossed the stability threshold this round —
   * the actual "surface a suggestion now" output. */
  readonly newlyEmitted: readonly SuggestionCandidateRecord[];
  /** Every candidate tracked for this scope after this computation. */
  readonly allCandidates: readonly SuggestionCandidateRecord[];
}

const cosineSimilarity = (left: Float32Array, right: Float32Array): number => {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < length; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
};

const hasSentenceVectors = (item: SuggestionEvidenceItem): boolean =>
  item.sentenceEmbeddings !== undefined && item.sentenceEmbeddings.length > 0;

/** True when a pair has SOME comparable vector signal — either a usable
 *  pooled embedding on BOTH sides, or usable sentence vectors on BOTH
 *  sides (§12). The two signals are independent: a page can carry sentence
 *  vectors from its gist with no pooled doc-level embedding at all (see
 *  SuggestionEvidenceItem.sentenceEmbeddings's doc comment). */
const vectorSignalUsable = (left: SuggestionEvidenceItem, right: SuggestionEvidenceItem): boolean =>
  (hasNonZeroVector(left.embedding) && hasNonZeroVector(right.embedding)) ||
  (hasSentenceVectors(left) && hasSentenceVectors(right));

/**
 * The vector-term score for one pair (§12) — sentence-level late
 * interaction (symmetricSentenceScore) when BOTH sides carry sentence
 * vectors, else the pre-existing pooled cosine (cosineSimilarity,
 * UNCHANGED — same self-normalizing function, not sentenceInteraction.ts's
 * pre-normalized-input assumption, so this is byte-identical to the
 * pre-§12 pooled path for every caller that never populates
 * sentenceEmbeddings), else 0. This is the ONE place hybridSimilarity's
 * vector term is computed — both call sites below (the two-vector-usable
 * branch and the vector-only branch) go through it, so a pair's sentence-
 * vs-pooled choice can never drift between them.
 */
const vectorSimilarityFor = (
  left: SuggestionEvidenceItem,
  right: SuggestionEvidenceItem,
  k: number = resolveLateInteractionTopK(),
): number => {
  if (hasSentenceVectors(left) && hasSentenceVectors(right)) {
    return symmetricSentenceScore(left.sentenceEmbeddings!, right.sentenceEmbeddings!, k);
  }
  if (hasNonZeroVector(left.embedding) && hasNonZeroVector(right.embedding)) {
    return cosineSimilarity(left.embedding, right.embedding);
  }
  return 0;
};

/**
 * Hybrid similarity for one evidence pair — blends the vector term (§12:
 * sentence-level late interaction where available, else pooled cosine —
 * see vectorSimilarityFor) with concept-Jaccard over gist keywords.
 * FORMULA, in priority order:
 *
 *   1. BOTH items carry usable vector signal (per vectorSignalUsable) AND
 *      both carry a `conceptIds` field:
 *        similarity = (1 - weight) * vectorSimilarityFor + weight * conceptJaccard
 *   2. Only concept-ids are usable (no usable vector signal on one or both
 *      sides — the "zero vector coverage" case, e.g. recall-v2 has not
 *      embedded this page yet AND no sentence vectors exist yet):
 *        similarity = conceptJaccard
 *      The vector term is DROPPED here, not zero-weighted — a missing
 *      signal must not silently dilute the one signal that IS available
 *      (folding in an implicit score=0 would understate every pair's
 *      similarity by a `weight`-sized fraction for no evidential reason).
 *   3. Only the vector term is usable (neither item carries `conceptIds` —
 *      the keyword layer has not processed either page):
 *        similarity = vectorSimilarityFor
 *      Identical to the module's pre-keyword-layer behavior when neither
 *      side has sentence vectors — this is what makes both the keyword
 *      layer AND the §12 sentence layer additive rather than a rescoring
 *      of every existing caller.
 *   4. Neither is usable: similarity = 0 (same as the original
 *      cosineSimilarity's zero-vector floor).
 *
 * `weight` is SIDETRACK_KEYWORD_CLUSTER_WEIGHT (resolveKeywordClusterWeight),
 * resolved ONCE per recompute call by the caller, not per pair.
 */
export const hybridSimilarity = (
  left: SuggestionEvidenceItem,
  right: SuggestionEvidenceItem,
  weight: number = DEFAULT_KEYWORD_CLUSTER_WEIGHT,
): number => {
  const vectorsUsable = vectorSignalUsable(left, right);
  const conceptsUsable = left.conceptIds !== undefined && right.conceptIds !== undefined;
  if (conceptsUsable) {
    const jac = conceptJaccard(left.conceptIds ?? [], right.conceptIds ?? []);
    if (!vectorsUsable) return jac;
    const cos = vectorSimilarityFor(left, right);
    return (1 - weight) * cos + weight * jac;
  }
  if (vectorsUsable) return vectorSimilarityFor(left, right);
  return 0;
};

const findBestOverlapMatch = (
  previous: readonly SuggestionCandidateRecord[],
  memberIds: Set<string>,
  minJaccard: number,
): SuggestionCandidateRecord | undefined => {
  let best: SuggestionCandidateRecord | undefined;
  let bestScore = 0;
  for (const candidate of previous) {
    const score = jaccard(memberIds, new Set(candidate.memberIds));
    if (score >= minJaccard && score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
};

// Structural fallback name — top discriminative terms from the cluster's
// member titles. LLM naming (offline, optional) is out of scope here;
// naming never gates visibility, so an empty/unhelpful title set just
// yields `null` (caller renders a generic "N related pages" fallback).
const TOP_TERM_COUNT = 3;
const structuralNameFor = (
  memberIds: readonly string[],
  titleById: ReadonlyMap<string, string>,
): string | null => {
  const counts = new Map<string, number>();
  for (const memberId of memberIds) {
    const title = titleById.get(memberId);
    if (title === undefined || title.length === 0) continue;
    for (const token of normalizeTokens(title)) {
      if (token.startsWith('#')) continue; // drop character-trigram tags
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = ranked.slice(0, TOP_TERM_COUNT).map(([token]) => token);
  return top.length === 0 ? null : top.join(' ');
};

// Preferred naming source (2026-08-16): top shared RAW keywords across a
// cluster's members, when the keyword layer has processed them — still no
// LLM (directive: "no LLM naming"), just a more DIRECT signal than title
// tokens, since a gist's keywords are already the terms someone would search
// for, whereas a title's tokens are whatever words happened to be in the
// (often junk/URL-shaped) title string. Falls back to structuralNameFor when
// no member carries keywords — additive, not a replacement.
const keywordNameFor = (
  memberIds: readonly string[],
  keywordsById: ReadonlyMap<string, readonly string[]>,
): string | null => {
  const counts = new Map<string, number>();
  for (const memberId of memberIds) {
    const keywords = keywordsById.get(memberId);
    if (keywords === undefined) continue;
    for (const keyword of keywords) {
      counts.set(keyword, (counts.get(keyword) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = ranked.slice(0, TOP_TERM_COUNT).map(([keyword]) => keyword);
  return top.length === 0 ? null : top.join(' ');
};

/**
 * Population-scoped decline check — true when `candidateConceptIds`
 * overlaps (by Jaccard) any previously-declined concept set at or above
 * `threshold`. An EMPTY candidate concept set never matches anything (no
 * concept signal means no basis for comparison, and the safe default is to
 * surface, not suppress, on ambiguity).
 */
const isSuppressedByDecline = (
  candidateConceptIds: readonly string[],
  declinedSets: readonly (readonly string[])[],
  threshold: number,
): boolean => {
  if (candidateConceptIds.length === 0) return false;
  for (const declined of declinedSets) {
    if (conceptJaccard(candidateConceptIds, declined) >= threshold) return true;
  }
  return false;
};

// ---------------------------------------------------------------------------
// §12 calibrated new-category score (docs/plans/2026-08-16-category-
// flexibility-hyde.md §12, USER DESIGN DIRECTIVE 2026-08-17 items (a)+(3)).
// ---------------------------------------------------------------------------

export const SUGGESTION_MARGIN_ENV = 'SIDETRACK_SUGGESTION_MARGIN';
// "default small, e.g. 0.05" — the SAME numeric value as
// prototypeContrastMargin.ts's CONTRAST_MARGIN_MIN, a deliberate echo (not
// a re-export — the two margins protect different decisions, prototype-lane
// disclosure vs. suggestion-candidate emission, and must stay
// independently tunable) of the "small enough that a genuinely distinctive
// case clears it, large enough to catch a genuine near-tie" judgment call.
export const DEFAULT_SUGGESTION_MARGIN = 0.05;

/** Parse SIDETRACK_SUGGESTION_MARGIN — a >=0 float. "0 = emit on any
 *  positive margin — keep liberal" per the directive: 0 is a VALID,
 *  meaningful value here (not treated as "unset"), unlike this module's
 *  other env resolvers where 0 sometimes means "disabled" — so the
 *  fallback-to-default check is `raw === undefined || raw === ''` only,
 *  never `!parsed`. Negative/garbage falls back to the default. */
export const resolveSuggestionMargin = (): number => {
  const raw = process.env[SUGGESTION_MARGIN_ENV];
  if (raw === undefined || raw === '') return DEFAULT_SUGGESTION_MARGIN;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SUGGESTION_MARGIN;
  return parsed;
};

/**
 * Cohesion — mean pairwise late-interaction score among a candidate
 * cluster's OWN members, using vectorSimilarityFor (sentence-level where
 * available, else pooled cosine, else 0 — the SAME primitive
 * hybridSimilarity's vector term uses, deliberately NOT the concept-Jaccard
 * blend: the directive asks for "the SAME late-interaction metric" for both
 * cohesion and external-best, and late interaction is fundamentally a
 * vector-space notion). A single-member "cluster" (never actually reached
 * by recomputeSuggestionCandidates's own minClusterMembers floor, but
 * defensive) has no pair to average and returns 0.
 */
export const computeClusterCohesion = (
  members: readonly SuggestionEvidenceItem[],
  k: number = resolveLateInteractionTopK(),
): number => {
  if (members.length < 2) return 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      sum += vectorSimilarityFor(members[i]!, members[j]!, k);
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
};

/**
 * External-best — the single largest late-interaction score any cluster
 * member gets against any OTHER existing workstream's prototype sentence
 * vectors (pageWorkstreamScore, top-k mean of max-per-member-sentence — the
 * SAME primitive tabsession/prototypeLane.ts's own sentence-level scoring
 * uses). `excludeWorkstreamId` is the scope's OWN workstreamId for a
 * 'split' candidate (comparing a sub-cluster against the workstream it is
 * being split FROM would be circular — the question is "does this look more
 * like some OTHER list", not "does it still resemble its parent");
 * undefined for 'new-category' (unfiled evidence has no own workstream to
 * exclude).
 *
 * Returns null — NOT 0 — when no comparison was possible (no
 * `existingWorkstreamSentenceVectors` supplied, or no cluster member
 * carries sentence vectors yet): null is the caller's signal to skip the
 * margin gate entirely, distinct from a genuine "compared, and scored
 * (near-)zero against everything" 0.
 */
export const computeExternalBest = (
  members: readonly SuggestionEvidenceItem[],
  existingWorkstreamSentenceVectors: ReadonlyMap<string, readonly Float32Array[]> | undefined,
  excludeWorkstreamId: string | undefined,
  k: number = resolveLateInteractionTopK(),
): number | null => {
  if (existingWorkstreamSentenceVectors === undefined || existingWorkstreamSentenceVectors.size === 0) {
    return null;
  }
  let best: number | null = null;
  for (const member of members) {
    const sentences = member.sentenceEmbeddings;
    if (sentences === undefined || sentences.length === 0) continue;
    for (const [workstreamId, targetVectors] of existingWorkstreamSentenceVectors) {
      if (workstreamId === excludeWorkstreamId) continue;
      if (targetVectors.length === 0) continue;
      const score = pageWorkstreamScore(sentences, targetVectors, k);
      if (best === null || score > best) best = score;
    }
  }
  return best;
};

/**
 * Recompute (or skip, if untouched) the split/new-category candidates for
 * one scope. Pure with respect to `evidence`/`revisionId`; all persistence
 * goes through `store`.
 */
export const recomputeSuggestionCandidates = (
  store: SuggestionCandidateStore,
  input: RecomputeSuggestionCandidatesInput,
): RecomputeSuggestionCandidatesResult => {
  const previousRevision = store.lastComputedRevision(input.scopeId, input.kind);
  if (previousRevision === input.revisionId) {
    return {
      recomputed: false,
      newlyEmitted: [],
      allCandidates: store.candidatesFor(input.scopeId, input.kind),
    };
  }

  const cosineThreshold = input.options?.cosineThreshold ?? DEFAULT_SPLIT_COSINE_THRESHOLD;
  const minSamples = input.options?.minSamples ?? DEFAULT_SPLIT_MIN_SAMPLES;
  const minClusterMembers =
    input.options?.minClusterMembers ?? resolveSuggestionMinClusterMembers();
  const stabilityMinConsecutive =
    input.options?.stabilityMinConsecutive ?? resolveSuggestionStabilityMinConsecutive();
  const matchOverlapMinJaccard =
    input.options?.matchOverlapMinJaccard ?? DEFAULT_MATCH_OVERLAP_MIN_JACCARD;
  const minEvidenceToAttempt = input.options?.minEvidenceToAttempt ?? DEFAULT_MIN_EVIDENCE_TO_ATTEMPT;
  const keywordClusterWeight = input.options?.keywordClusterWeight ?? resolveKeywordClusterWeight();
  const declineConceptOverlapThreshold =
    input.options?.declineConceptOverlapThreshold ?? DEFAULT_DECLINE_CONCEPT_OVERLAP_THRESHOLD;
  const lateInteractionTopK = input.options?.lateInteractionTopK ?? resolveLateInteractionTopK();
  const suggestionMargin = input.options?.suggestionMargin ?? resolveSuggestionMargin();
  // §12 — excludes a 'split' candidate's OWN scope (its parent workstream)
  // from external-best comparison (see computeExternalBest's doc comment);
  // 'new-category' evidence has no own workstream to exclude.
  const externalMatchExcludeWorkstreamId = input.kind === 'split' ? input.scopeId : undefined;
  const now = (input.now ?? Date.now)();
  const previous = store.candidatesFor(input.scopeId, input.kind);
  const evidenceById = new Map(input.evidence.map((item) => [item.id, item] as const));

  // Cold-start floor: below this, don't even attempt clustering. Still
  // persist the (empty) computation so dirty-marking short-circuits next
  // time nothing changed.
  if (input.evidence.length < minEvidenceToAttempt) {
    store.replaceScope(input.scopeId, input.kind, input.revisionId, []);
    return { recomputed: true, newlyEmitted: [], allCandidates: [] };
  }

  const memberIds = new Set(input.evidence.map((e) => e.id));
  const edges: DensitySimilarityEdge[] = [];
  for (let i = 0; i < input.evidence.length; i += 1) {
    for (let j = i + 1; j < input.evidence.length; j += 1) {
      const left = input.evidence[i];
      const right = input.evidence[j];
      if (left === undefined || right === undefined) continue;
      const similarity = hybridSimilarity(left, right, keywordClusterWeight);
      if (similarity >= cosineThreshold) {
        edges.push({ fromId: left.id, toId: right.id, cosine: similarity });
      }
    }
  }
  const components = densityConnectedComponents(memberIds, edges, cosineThreshold, minSamples);
  const qualifying = components.filter((component) => component.members.length >= minClusterMembers);

  // Split needs a genuine split — at least two coherent sub-groups, or the
  // workstream is legitimately cohesive (negative control). New-category
  // has no "whole" to split from, so one qualifying cluster is enough.
  const minQualifyingClusters = input.kind === 'split' ? 2 : 1;

  const titleById = new Map<string, string>();
  const keywordsById = new Map<string, readonly string[]>();
  const conceptIdsById = new Map<string, readonly string[]>();
  for (const item of input.evidence) {
    if (item.title !== undefined) titleById.set(item.id, item.title);
    if (item.keywords !== undefined) keywordsById.set(item.id, item.keywords);
    if (item.conceptIds !== undefined) conceptIdsById.set(item.id, item.conceptIds);
  }
  const declinedConceptSets = store.declinedConceptSets(input.scopeId, input.kind);

  const freshCandidates: SuggestionCandidateRecord[] = [];
  const newlyEmitted: SuggestionCandidateRecord[] = [];
  if (qualifying.length >= minQualifyingClusters) {
    for (const component of qualifying) {
      const sortedMembers = [...component.members].sort();
      const memberSet = new Set(sortedMembers);
      const fingerprint = sortedMembers.join(' ');
      const matched = findBestOverlapMatch(previous, memberSet, matchOverlapMinJaccard);
      // wasEmitted is read from the PERSISTED flag, which (below) is itself
      // already decline-suppressed — so a candidate held back by a decline
      // never looks "already emitted" and correctly re-attempts the
      // transition once its concept makeup drifts enough to clear the
      // decline (see isSuppressedByDecline's doc comment).
      const wasEmitted = matched?.emitted ?? false;
      const consecutiveStableCount = (matched?.consecutiveStableCount ?? 0) + 1;
      const stable = wasEmitted || consecutiveStableCount >= stabilityMinConsecutive;
      const candidateConceptIds = [
        ...new Set(sortedMembers.flatMap((memberId) => conceptIdsById.get(memberId) ?? [])),
      ];
      const suppressed = isSuppressedByDecline(
        candidateConceptIds,
        declinedConceptSets,
        declineConceptOverlapThreshold,
      );
      // §12 calibrated new-category score — computed for EVERY candidate
      // (not only ones that pass the other gates) so the persisted
      // record/GET route can always disclose both numbers, even for a
      // candidate withheld by stability/decline.
      const clusterMembers = sortedMembers.flatMap((memberId) => {
        const item = evidenceById.get(memberId);
        return item === undefined ? [] : [item];
      });
      const cohesion = computeClusterCohesion(clusterMembers, lateInteractionTopK);
      const externalBest = computeExternalBest(
        clusterMembers,
        input.existingWorkstreamSentenceVectors,
        externalMatchExcludeWorkstreamId,
        lateInteractionTopK,
      );
      // Sticky, same rule `stable` already applies via `wasEmitted`: an
      // ALREADY-emitted candidate is never retroactively un-emitted by a
      // later recompute finding a worse margin (a later recompute could
      // easily see a stronger external match simply because MORE
      // workstreams now have prototypes — that is not evidence the
      // original suggestion was wrong). The margin gate only applies to a
      // candidate's FIRST transition into `emitted`.
      const marginOk = wasEmitted || externalBest === null || cohesion > externalBest + suggestionMargin;
      const emitted = stable && !suppressed && marginOk;
      const record: SuggestionCandidateRecord = {
        scopeId: input.scopeId,
        kind: input.kind,
        fingerprint,
        memberIds: sortedMembers,
        consecutiveStableCount,
        emitted,
        cohesion,
        externalBest,
        structuralName:
          keywordNameFor(sortedMembers, keywordsById) ?? structuralNameFor(sortedMembers, titleById),
        createdAtMs: matched?.createdAtMs ?? now,
        updatedAtMs: now,
        // Decline memory is sticky across recomputes, matched the same
        // Jaccard-overlap way `consecutiveStableCount`/`createdAtMs` carry
        // forward — a user who declined this cluster must not see it
        // resurface just because the next recompute re-fingerprints it.
        dismissed: matched?.dismissed ?? false,
        dismissedAtMs: matched?.dismissedAtMs ?? null,
      };
      freshCandidates.push(record);
      if (emitted && !wasEmitted) newlyEmitted.push(record);
    }
  }

  store.replaceScope(input.scopeId, input.kind, input.revisionId, freshCandidates);

  return { recomputed: true, newlyEmitted, allCandidates: freshCandidates };
};

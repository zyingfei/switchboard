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
// than 'is a cluster')" — design §4.
export const DEFAULT_MIN_CLUSTER_MEMBERS = HDBSCAN_TOPIC_MIN_SAMPLES + 1;
// Conservative judgment call (not specified numerically by the design):
// three consecutive stable computations before a suggestion is allowed to
// surface at all — "conservative defaults (no suggestion fires below
// stability threshold)".
export const DEFAULT_STABILITY_MIN_CONSECUTIVE = 3;
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
}

export interface RecomputeSuggestionCandidatesInput {
  readonly scopeId: string;
  readonly kind: SuggestionCandidateKind;
  readonly evidence: readonly SuggestionEvidenceItem[];
  /** Caller's content hash of the scope's evidence — dirty-marking key. */
  readonly revisionId: string;
  readonly now?: () => number;
  readonly options?: RecomputeSuggestionCandidatesOptions;
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

/**
 * Hybrid similarity for one evidence pair — blends embedding cosine with
 * concept-Jaccard over gist keywords. FORMULA, in priority order:
 *
 *   1. BOTH items carry a usable (non-zero-length, non-all-zero) embedding
 *      AND both carry a `conceptIds` field:
 *        similarity = (1 - weight) * cosine + weight * conceptJaccard
 *   2. Only concept-ids are usable (either embedding missing/zero — the
 *      "zero vector coverage" case, e.g. recall-v2 has not embedded this
 *      page yet):
 *        similarity = conceptJaccard
 *      The embedding term is DROPPED here, not zero-weighted — a missing
 *      signal must not silently dilute the one signal that IS available
 *      (folding in an implicit cosine=0 would understate every pair's
 *      similarity by a `weight`-sized fraction for no evidential reason).
 *   3. Only embeddings are usable (neither item carries `conceptIds` —
 *      the keyword layer has not processed either page):
 *        similarity = cosine
 *      Identical to the module's pre-keyword-layer behavior — this is what
 *      makes the change additive rather than a rescoring of every existing
 *      caller.
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
  const vectorsUsable = hasNonZeroVector(left.embedding) && hasNonZeroVector(right.embedding);
  const conceptsUsable = left.conceptIds !== undefined && right.conceptIds !== undefined;
  if (conceptsUsable) {
    const jac = conceptJaccard(left.conceptIds ?? [], right.conceptIds ?? []);
    if (!vectorsUsable) return jac;
    const cos = cosineSimilarity(left.embedding, right.embedding);
    return (1 - weight) * cos + weight * jac;
  }
  if (vectorsUsable) return cosineSimilarity(left.embedding, right.embedding);
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
  const minClusterMembers = input.options?.minClusterMembers ?? DEFAULT_MIN_CLUSTER_MEMBERS;
  const stabilityMinConsecutive =
    input.options?.stabilityMinConsecutive ?? DEFAULT_STABILITY_MIN_CONSECUTIVE;
  const matchOverlapMinJaccard =
    input.options?.matchOverlapMinJaccard ?? DEFAULT_MATCH_OVERLAP_MIN_JACCARD;
  const minEvidenceToAttempt = input.options?.minEvidenceToAttempt ?? DEFAULT_MIN_EVIDENCE_TO_ATTEMPT;
  const keywordClusterWeight = input.options?.keywordClusterWeight ?? resolveKeywordClusterWeight();
  const declineConceptOverlapThreshold =
    input.options?.declineConceptOverlapThreshold ?? DEFAULT_DECLINE_CONCEPT_OVERLAP_THRESHOLD;
  const now = (input.now ?? Date.now)();
  const previous = store.candidatesFor(input.scopeId, input.kind);

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
      const emitted = stable && !suppressed;
      const record: SuggestionCandidateRecord = {
        scopeId: input.scopeId,
        kind: input.kind,
        fingerprint,
        memberIds: sortedMembers,
        consecutiveStableCount,
        emitted,
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

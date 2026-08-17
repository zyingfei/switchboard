// Split evidence adapter — turns prototypeEvidence.ts's
// gatherWorkstreamEvidence output into SuggestionEvidenceItem[] for
// recomputeSuggestionCandidates's 'split' mode. Sibling of
// unfiledEvidence.ts's suggestionEvidenceFromUnfiled (same join shape, same
// "embeddings optional, deferred" contract) — together the two adapters are
// what let suggestionRecomputeLane.ts drive BOTH suggestion kinds off real
// vault data.
//
// EMBEDDINGS OPTIONAL, SAME DEFERRAL AS unfiledEvidence.ts. Live recall-v2
// vector retrieval per filed page is not wired here either; when the
// `embeddingForUrl` join is omitted, hybridSimilarity (splitSuggestionEngine
// .ts) runs on pure concept-Jaccard, which is exactly the point of this
// whole feature (structural signal where dense data is sparse).

import type { WorkstreamEvidenceItem } from './prototypeEvidence.js';
import type { SuggestionEvidenceItem } from './splitSuggestionEngine.js';

export interface SplitEvidenceJoin {
  readonly conceptIdsForUrl?: (canonicalUrl: string) => readonly string[] | undefined;
  readonly keywordsForUrl?: (canonicalUrl: string) => readonly string[] | undefined;
  readonly embeddingForUrl?: (canonicalUrl: string) => Float32Array | undefined;
  /** §12 sentence vectors (recall-v2's sentence_vectors table, owner_kind
   *  'page') — same optional-join shape as the others; omitted or absent
   *  for a given URL means hybridSimilarity's vector term falls back to
   *  pooled cosine for that item, per sentenceInteraction.ts's documented
   *  fallback contract. */
  readonly sentenceEmbeddingsForUrl?: (canonicalUrl: string) => readonly Float32Array[] | undefined;
}

/** Bounds one workstream's evidence pool before it reaches the engine's O(n²)
 *  pairwise similarity pass — a workstream with a huge filed population must
 *  not turn one production recompute cycle into an unbounded scan. Most-
 *  recent-first, same idiom as unfiledEvidence.ts's population cap. */
export const SPLIT_EVIDENCE_PER_WORKSTREAM_CAP = 500;

export const suggestionEvidenceFromWorkstreamItems = (
  items: readonly WorkstreamEvidenceItem[],
  join: SplitEvidenceJoin = {},
  limit: number = SPLIT_EVIDENCE_PER_WORKSTREAM_CAP,
): readonly SuggestionEvidenceItem[] => {
  const sorted = [...items].sort((left, right) => right.firstSeenAtMs - left.firstSeenAtMs);
  const bounded = sorted.slice(0, Math.max(0, limit));
  return bounded.map((item) => {
    const conceptIds = join.conceptIdsForUrl?.(item.canonicalUrl);
    const keywords = join.keywordsForUrl?.(item.canonicalUrl);
    const embedding = join.embeddingForUrl?.(item.canonicalUrl) ?? new Float32Array(0);
    const sentenceEmbeddings = join.sentenceEmbeddingsForUrl?.(item.canonicalUrl);
    const evidenceItem: SuggestionEvidenceItem = {
      id: item.canonicalUrl,
      embedding,
      ...(item.title === null ? {} : { title: item.title }),
      ...(conceptIds === undefined ? {} : { conceptIds }),
      ...(keywords === undefined ? {} : { keywords }),
      ...(sentenceEmbeddings === undefined ? {} : { sentenceEmbeddings }),
    };
    return evidenceItem;
  });
};

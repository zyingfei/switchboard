import type { ConnectionEdge } from '../connections/types.js';
import type { PageEvidenceRecord } from '../page-evidence/types.js';
import type { AcceptedEvent } from '../sync/causal.js';

export type CandidateSource =
  | 'user_confirmed'
  | 'same_workstream'
  | 'opener_chain'
  | 'navigation_chain'
  | 'same_canonical_url'
  | 'same_repo_or_domain'
  | 'same_search_query'
  | 'same_copied_snippet'
  | 'same_title_path_tokens'
  | 'embedding_neighborhood'
  | 'content_term_overlap'
  | 'content_embedding_neighborhood'
  | 'cross_replica_continuation'
  | 'random_unrelated'
  | 'recently_skipped';

export interface Candidate {
  readonly fromVisitId: string;
  readonly toVisitId: string;
  readonly sources: readonly CandidateSource[];
  readonly generatedAt: number;
}

export type GenerateCandidates = (
  fromVisitId: string,
  context: {
    merged: AcceptedEvent[];
    existingEdges: ConnectionEdge[];
    pageEvidenceByCanonicalUrl?: ReadonlyMap<string, PageEvidenceRecord>;
    evidenceVectorsByVectorId?: ReadonlyMap<string, Float32Array>;
  },
) => readonly Candidate[];

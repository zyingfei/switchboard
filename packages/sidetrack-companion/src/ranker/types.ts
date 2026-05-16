import type { ConnectionEdge } from '../connections/types.js';
import type { AcceptedEvent } from '../sync/causal.js';

export type CandidateSource =
  | 'same_workstream'
  | 'opener_chain'
  | 'navigation_chain'
  | 'same_canonical_url'
  | 'same_repo_or_domain'
  | 'same_search_query'
  | 'same_copied_snippet'
  | 'same_title_path_tokens'
  | 'embedding_neighborhood'
  | 'cross_replica_continuation'
  | 'random_unrelated'
  | 'recently_skipped';

export interface Candidate {
  fromVisitId: string;
  toVisitId: string;
  sources: readonly CandidateSource[];
  generatedAt: number;
}

export type GenerateCandidates = (
  fromVisitId: string,
  context: { merged: AcceptedEvent[]; existingEdges: ConnectionEdge[] },
) => readonly Candidate[];

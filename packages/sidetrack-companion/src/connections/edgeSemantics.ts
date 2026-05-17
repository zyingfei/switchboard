import type { ConnectionEdgeKind } from './types.js';

export type EdgeSemanticRole =
  | 'membership'
  | 'assignment'
  | 'cluster_membership'
  | 'pair_evidence'
  | 'pair_recommendation'
  | 'sequence'
  | 'other';

export const EDGE_SEMANTIC_ROLE: Readonly<Partial<Record<ConnectionEdgeKind, EdgeSemanticRole>>> = {
  visit_in_workstream: 'membership',
  visit_instance_in_workstream: 'membership',
  tab_session_in_workstream: 'membership',
  thread_in_workstream: 'membership',
  dispatch_in_workstream: 'membership',
  coding_session_in_workstream: 'membership',
  topic_in_workstream: 'assignment',
  visit_in_topic: 'cluster_membership',
  visit_resembles_visit: 'pair_evidence',
  closest_visit: 'pair_recommendation',
  visit_continues_visit: 'sequence',
};

export const edgeSemanticRoleFor = (kind: ConnectionEdgeKind): EdgeSemanticRole =>
  EDGE_SEMANTIC_ROLE[kind] ?? 'other';

export const edgeKindIsPairwiseRelatedness = (kind: ConnectionEdgeKind): boolean => {
  const role = edgeSemanticRoleFor(kind);
  return role === 'pair_evidence' || role === 'pair_recommendation' || role === 'sequence';
};

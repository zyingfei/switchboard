import type { ConnectionEdgeKind } from '../connections/types.js';

export const EDGE_PRIOR_WEIGHTS: Partial<Record<ConnectionEdgeKind, number>> = {
  tab_session_in_workstream: 4.0,
  visit_in_workstream: 3.5,
  visit_in_tab_session: 3.0,
  previous_visit_in_tab_session: 2.5,
  opener_visit: 2.0,
  tab_session_opener_chain: 1.75,
  visit_continues_visit: 2.25,
  closest_visit: 1.75,
  visit_resembles_visit: 1.25,
  thread_references_url: 1.5,
  dispatch_references_url: 1.25,
  annotation_references_url: 1.0,
  thread_text_mentions_search_query: 1.0,
  snippet_copied_from_visit: 1.25,
  snippet_pasted_into_thread: 1.25,
  snippet_pasted_into_dispatch: 1.0,
  visit_in_topic: 0.75,
  topic_in_workstream: 1.25,
};

export const weightForEdgeKind = (kind: ConnectionEdgeKind): number =>
  EDGE_PRIOR_WEIGHTS[kind] ?? 0.5;

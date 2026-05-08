import type { ConnectionNodeKind } from './types';

// Edge kind / family / type metadata, ported from
// switchboard/project/connections-shared.jsx and extended with the
// 4 new content-derived edges (`*_references_url`,
// `thread_quotes_thread`) which fold into the `urlmatch` family.
// Confidence comes from the edge payload itself, so inferred links
// can render with a weaker dashed treatment independent of family.

export type EdgeFamily = 'contain' | 'flow' | 'defer' | 'urlmatch';

export interface EdgeKindMetadata {
  readonly family: EdgeFamily;
  readonly label: string;
  readonly description: string;
}

export const EDGE_KINDS: Record<string, EdgeKindMetadata> = {
  // contain — hierarchy / membership
  thread_in_workstream: {
    family: 'contain',
    label: 'in workstream',
    description: 'Thread.primaryWorkstreamId equals workstream.bac_id.',
  },
  workstream_parent_of: {
    family: 'contain',
    label: 'parent of',
    description: 'Workstream.children[] contains the target workstream.',
  },
  dispatch_in_workstream: {
    family: 'contain',
    label: 'in workstream',
    description: 'Dispatch.workstreamId equals workstream.bac_id.',
  },
  coding_session_in_workstream: {
    family: 'contain',
    label: 'in workstream',
    description: 'Coding session.workstreamId equals workstream.bac_id.',
  },
  // flow — causal action
  dispatch_from_thread: {
    family: 'flow',
    label: 'from thread',
    description: 'Dispatch.sourceThreadId equals thread.bac_id.',
  },
  dispatch_reply_landed_in_thread: {
    family: 'flow',
    label: 'reply landed in',
    description: 'A dispatch.linked event resolves the dispatch to a captured thread.',
  },
  dispatch_requested_coding_session: {
    family: 'flow',
    label: 'requested',
    description: 'Dispatch.mcpRequest references this coding session id.',
  },
  // defer — queued / future-targeted
  queue_targets_thread: {
    family: 'defer',
    label: 'queued for',
    description: 'Queue event target is this thread.',
  },
  queue_targets_workstream: {
    family: 'defer',
    label: 'queued for',
    description: 'Queue event target is this workstream.',
  },
  reminder_for_thread: {
    family: 'defer',
    label: 'reminder for',
    description: 'Reminder vault record threadId equals thread.bac_id.',
  },
  // urlmatch — canonical-URL or content-derived references
  timeline_same_url_as_thread: {
    family: 'urlmatch',
    label: 'same canonical URL',
    description: 'Normalized canonical URL of visit equals thread.url.',
  },
  annotation_targets_thread: {
    family: 'urlmatch',
    label: 'targets',
    description: 'Annotation URL matches thread URL after canonical normalization.',
  },
  thread_references_url: {
    family: 'urlmatch',
    label: 'references URL',
    description: 'A captured turn in this thread cites a tracked timeline visit URL.',
  },
  dispatch_references_url: {
    family: 'urlmatch',
    label: 'references URL',
    description: 'The dispatch body cites a tracked timeline visit URL.',
  },
  annotation_references_url: {
    family: 'urlmatch',
    label: 'references URL',
    description: 'The annotation note cites a tracked timeline visit URL.',
  },
  thread_quotes_thread: {
    family: 'urlmatch',
    label: 'quotes',
    description:
      'A captured turn in this thread contains a contiguous ≥40-char substring of a captured turn in the other thread.',
  },
  thread_text_mentions_search_query: {
    family: 'urlmatch',
    label: 'mentions search query',
    description:
      'Captured turn / dispatch body / annotation note contains the search query embedded in a tracked search-URL visit (whole-word, case-insensitive).',
  },
  visit_in_workstream: {
    family: 'contain',
    label: 'in workstream',
    description:
      "Timeline observer stamped the user's currently-focused workstream id onto this visit at observation time (active-workstream attribution).",
  },
};

export const FAMILIES: Record<EdgeFamily, { readonly label: string; readonly description: string }> = {
  contain: { label: 'Containment', description: 'Hierarchy / membership' },
  flow: { label: 'Dispatch flow', description: 'Causal action' },
  defer: { label: 'Queue · Reminder', description: 'Deferred targeting' },
  urlmatch: { label: 'URL match', description: 'Canonical URL or content reference' },
};

// Display metadata per node kind. Maps the companion's
// ConnectionNodeKind union to a paper-warm tint class + a singular
// label used in section headers.
export const NODE_KIND_DISPLAY: Record<
  ConnectionNodeKind,
  { readonly label: string; readonly tintClass: string }
> = {
  thread: { label: 'Thread', tintClass: 'cx-type-thread' },
  workstream: { label: 'Workstream', tintClass: 'cx-type-workstream' },
  dispatch: { label: 'Dispatch', tintClass: 'cx-type-dispatch' },
  'queue-item': { label: 'Queue item', tintClass: 'cx-type-queue' },
  'inbound-reminder': { label: 'Reminder', tintClass: 'cx-type-reminder' },
  'coding-session': { label: 'Coding session', tintClass: 'cx-type-coding' },
  'timeline-visit': { label: 'Browser visit', tintClass: 'cx-type-visit' },
  annotation: { label: 'Annotation', tintClass: 'cx-type-annotation' },
};

// Display order for kind groups in the linked-panels center column.
// Workstream first (most "containing"), thread second (most common),
// then evidence kinds (visit / annotation / queue / reminder).
export const NODE_KIND_GROUP_ORDER: readonly ConnectionNodeKind[] = [
  'workstream',
  'thread',
  'dispatch',
  'coding-session',
  'timeline-visit',
  'annotation',
  'queue-item',
  'inbound-reminder',
];

// Tiny inline hint for content-derived edges; preserved from the
// minimal scaffold so users can spot URL-ref / quote edges at a
// glance even when the family-line styling is the same as canonical
// URL matches.
export const contentDerivedHint = (kind: string): string | null => {
  if (kind.endsWith('_references_url')) return 'via captured text';
  if (kind === 'thread_quotes_thread') return 'quoted in turn';
  if (kind === 'thread_text_mentions_search_query') return 'via search query match';
  if (kind === 'visit_in_workstream') return 'via active workstream';
  return null;
};

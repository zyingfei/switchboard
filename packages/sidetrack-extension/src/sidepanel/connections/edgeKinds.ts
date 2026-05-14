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
  visit_resembles_visit: {
    family: 'urlmatch',
    label: 'resembles',
    description:
      'Visit-similarity revision linked these browser visits by title, host, and path corpus embedding.',
  },
  closest_visit: {
    family: 'urlmatch',
    label: 'closest visit',
    description:
      'Learned ranker linked these visits and attached score plus top feature contributions.',
  },
  visit_observed_on_replica: {
    family: 'urlmatch',
    label: 'observed on',
    description: 'The same canonical visit was observed on more than one replica.',
  },
  visit_in_workstream: {
    family: 'contain',
    label: 'in workstream',
    description:
      "Timeline observer stamped the user's currently-focused workstream id onto this visit at observation time (active-workstream attribution).",
  },
  previous_visit_in_tab_session: {
    family: 'flow',
    label: 'previous visit',
    description:
      'Chrome navigation evidence connected consecutive top-level visits in the same tab session.',
  },
  opener_visit: {
    family: 'flow',
    label: 'opened from',
    description: 'Chrome navigation evidence connected a new tab visit to the opener tab visit.',
  },
  visit_in_topic: {
    family: 'contain',
    label: 'in topic',
    description: 'Topic clusterer assigned this visit to a deterministic topic component.',
  },
  topic_in_workstream: {
    family: 'contain',
    label: 'in workstream',
    description: 'At least 75% of topic members share this workstream attribution.',
  },
  'topic.lineage': {
    family: 'flow',
    label: 'succeeded by',
    description:
      'Topic clusterer observed a deterministic topic id split or merge between revisions.',
  },
  snippet_copied_from_visit: {
    family: 'flow',
    label: 'copied from',
    description: 'Hash-only snippet lineage connected a copied selection to its source visit.',
  },
  snippet_pasted_into_thread: {
    family: 'flow',
    label: 'pasted into',
    description: 'Hash-only snippet lineage observed this snippet pasted into a thread.',
  },
  snippet_pasted_into_dispatch: {
    family: 'flow',
    label: 'pasted into',
    description: 'Hash-only snippet lineage observed this snippet pasted into a dispatch.',
  },
  snippet_pasted_into_search: {
    family: 'flow',
    label: 'pasted into',
    description: 'Hash-only snippet lineage observed this snippet pasted into a search visit.',
  },
  snippet_pasted_into_note: {
    family: 'flow',
    label: 'pasted into',
    description: 'Hash-only snippet lineage observed this snippet pasted into a note.',
  },
  snippet_pasted_into_capture: {
    family: 'flow',
    label: 'pasted into',
    description: 'Hash-only snippet lineage observed this snippet pasted into a capture.',
  },
  snippet_reused_across_threads: {
    family: 'flow',
    label: 'reused in',
    description: 'The same hash-only snippet was pasted into two or more threads.',
  },
  // Phase 1 / Phase 7 — tab-session + visit-instance edges. The side-panel
  // mirror needs an entry per kind or `EDGE_KINDS[kind].label` lookups
  // crash with `Cannot read properties of undefined (reading 'label')`.
  visit_in_tab_session: {
    family: 'contain',
    label: 'in tab session',
    description: 'Timeline visit was observed within this tab session lifecycle.',
  },
  tab_session_in_workstream: {
    family: 'contain',
    label: 'in workstream',
    description: 'Tab session attributed to this workstream via Class A user assertion.',
  },
  tab_session_opener_chain: {
    family: 'flow',
    label: 'opened by tab',
    description: 'This tab session was opened from another tab session (chrome.tabs.openerTabId).',
  },
  visit_instance_in_tab_session: {
    family: 'contain',
    label: 'in tab session',
    description: 'Per-visit-instance variant of visit_in_tab_session (Phase 7 visit-instance identity).',
  },
  visit_instance_in_workstream: {
    family: 'contain',
    label: 'in workstream',
    description: 'Per-visit-instance attribution edge (Phase 7) — replaces URL-aggregate visit_in_workstream so same-URL sessions stay isolated.',
  },
  visit_instance_same_url_as_timeline_visit: {
    family: 'urlmatch',
    label: 'same canonical URL',
    description: 'Visit instance and the URL-aggregate timeline-visit share a canonical URL.',
  },
};

export const FAMILIES: Record<
  EdgeFamily,
  { readonly label: string; readonly description: string }
> = {
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
  // Stage 5 polish — the three visit-shaped kinds confused the
  // user (Orbital graph showed "Browser visit" + "Visit instance" +
  // "Tab session" for the SAME URL with identical titles). New
  // labels emphasize *what each one is uniquely capturing*:
  //   timeline-visit  — Page (canonical aggregate across all tabs)
  //   visit-instance  — Tab visit (one specific tab × one trip)
  //   tab-session     — Browser tab (a tab's lifetime)
  'timeline-visit': { label: 'Page', tintClass: 'cx-type-visit' },
  'visit-instance': { label: 'Tab visit', tintClass: 'cx-type-visit' },
  'tab-session': { label: 'Browser tab', tintClass: 'cx-type-tab-session' },
  annotation: { label: 'Annotation', tintClass: 'cx-type-annotation' },
  snippet: { label: 'Snippet', tintClass: 'cx-type-snippet' },
  topic: { label: 'Topic', tintClass: 'cx-type-topic' },
  replica: { label: 'Replica', tintClass: 'cx-type-replica' },
  template: { label: 'Template', tintClass: 'cx-type-template' },
};

// `types.ts` keeps `ConnectionNodeKind` loose intentionally ("the
// companion is the source of truth; the side panel reads what's on
// the wire and renders it"). That means a new companion kind can
// reach the panel before this map is updated, and a direct lookup
// `NODE_KIND_DISPLAY[kind]` would crash with `undefined`. Use this
// helper everywhere so the panel degrades to "Unknown" + a neutral
// tint instead of breaking the whole view.
const UNKNOWN_NODE_KIND_DISPLAY = {
  label: 'Unknown',
  tintClass: 'cx-type-unknown',
} as const;

export const nodeKindDisplayFor = (
  kind: string,
): { readonly label: string; readonly tintClass: string } => {
  const direct = (NODE_KIND_DISPLAY as Record<string, { label: string; tintClass: string }>)[kind];
  if (direct !== undefined) return direct;
  return UNKNOWN_NODE_KIND_DISPLAY;
};

// Display order for kind groups in the linked-panels center column.
// Workstream first (most "containing"), thread second (most common),
// then evidence kinds (visit / annotation / queue / reminder).
export const NODE_KIND_GROUP_ORDER: readonly ConnectionNodeKind[] = [
  'workstream',
  'thread',
  'dispatch',
  'coding-session',
  'tab-session',
  'visit-instance',
  'timeline-visit',
  'topic',
  'snippet',
  'replica',
  'annotation',
  'queue-item',
  'inbound-reminder',
  'template',
];

// Tiny inline hint for content-derived edges; preserved from the
// minimal scaffold so users can spot URL-ref / quote edges at a
// glance even when the family-line styling is the same as canonical
// URL matches.
export const contentDerivedHint = (kind: string): string | null => {
  if (kind.endsWith('_references_url')) return 'via captured text';
  if (kind === 'thread_quotes_thread') return 'quoted in turn';
  if (kind === 'thread_text_mentions_search_query') return 'via search query match';
  if (kind === 'visit_resembles_visit') return 'via similarity';
  if (kind === 'visit_observed_on_replica') return 'via replica evidence';
  if (kind === 'visit_in_workstream') return 'via active workstream';
  if (kind === 'previous_visit_in_tab_session' || kind === 'opener_visit') {
    return 'via navigation';
  }
  if (kind.startsWith('snippet_')) return 'via copy/paste';
  return null;
};

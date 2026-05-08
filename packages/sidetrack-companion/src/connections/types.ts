// Sync Contract v1 / Class B — Connections graph types.
//
// Connections is an evidence-first visualization layer over the
// joins already present in the merged event log + companion vault
// projections. The plan (kind-prancing-river.md) is the load-
// bearing reference.
//
// MVP discipline:
//   - Only deterministic edges with provenance.
//   - No inference, no recommendations, no time-proximity edges.
//   - Same input durable state → byte-equal snapshot bytes
//     (reducer is order-independent; updatedAt = max observedAt).
//
// Capture-notes and reminder-for-thread/_workstream from the
// original 15-edge list are plugin-only state today; the MVP
// covers the 13 deterministic edges that the companion vault
// observes directly.

export type ConnectionNodeKind =
  | 'thread'
  | 'workstream'
  | 'dispatch'
  | 'queue-item'
  | 'inbound-reminder'
  | 'coding-session'
  | 'timeline-visit'
  | 'annotation';

export interface ConnectionNode {
  // Namespaced ids: `kind:bac_id` (or `timeline-visit:<canonicalUrl>`).
  // Stable across replicas — the canonical aggregate id is used so
  // a thread observed on multiple devices is one node.
  readonly id: string;
  readonly kind: ConnectionNodeKind;
  readonly label: string;
  readonly firstSeenAt?: string;
  readonly lastSeenAt?: string;
  // Replica ids that contributed at least one observation of this
  // node. Empty when the node was inferred from a store record
  // without a replica attribution (e.g. coding sessions, which are
  // HTTP-managed and don't carry an event-log dot).
  readonly originReplicaIds: readonly string[];
  readonly metadata: ConnectionNodeMetadata;
}

export interface ConnectionNodeMetadata {
  readonly provider?: string;
  readonly url?: string;
  readonly canonicalUrl?: string;
  readonly title?: string;
  readonly status?: string;
  readonly workstreamId?: string;
  readonly threadId?: string;
  readonly dispatchId?: string;
  readonly codingSessionId?: string;
  readonly visitCount?: number;
  readonly sourcePath?: string;
  // True when the node was redacted (e.g. private workstream during
  // a screen-share session). MVP doesn't set this; reserved for P2.
  readonly redacted?: boolean;
  // Kind-specific extension fields. Avoid putting anything here
  // that would change the snapshot bytes — keep the snapshot
  // deterministic.
  readonly [key: string]: unknown;
}

export type ConnectionEdgeKind =
  // Aggregate-projection backbone
  | 'thread_in_workstream'
  | 'workstream_parent_of'
  // Dispatch graph (from the merged log + dispatch.linked events)
  | 'dispatch_from_thread'
  | 'dispatch_in_workstream'
  | 'dispatch_reply_landed_in_thread'
  | 'dispatch_requested_coding_session'
  // Queue + reminders (queue events; reminders read from vault)
  | 'queue_targets_thread'
  | 'queue_targets_workstream'
  | 'reminder_for_thread'
  // Coding sessions (HTTP-managed; no replica attribution)
  | 'coding_session_in_workstream'
  // Cross-cutting joins
  | 'timeline_same_url_as_thread'
  | 'annotation_targets_thread'
  | 'annotation_targets_workstream'
  // Content-derived references (URLs found in captured turn text /
  // dispatch body / annotation note that match a timeline visit).
  | 'thread_references_url'
  | 'dispatch_references_url'
  | 'annotation_references_url'
  // Cross-thread substring quote (one captured turn contains a
  // ≥40-char substring of another captured turn's text).
  | 'thread_quotes_thread'
  // Search-query content match: a thread / dispatch / annotation
  // text contains the search query embedded in a tracked search-URL
  // visit (whole-word, case-insensitive). Closes the "I searched X
  // and asked the AI about X without pasting the URL" gap.
  | 'thread_text_mentions_search_query'
  // Active-workstream attribution: the timeline observer stamped the
  // user's currently-focused workstream id onto the visit. Closes
  // the "ambient browsing" gap — pages the user looked at while
  // working in a workstream attach to that workstream even when no
  // chat / dispatch / annotation references them.
  | 'visit_in_workstream';

export type ConnectionEdgeSource =
  | 'event-log'
  | 'workboard-state'
  | 'timeline-projection'
  | 'coding-session-store'
  | 'dispatch-link-store'
  | 'annotation-store'
  | 'reminder-store';

type ConnectionEdgeDot = { readonly replicaId: string; readonly seq: number };

type RevisionProducedBySource =
  | 'visit-similarity'
  | 'topic-clusterer'
  | 'engagement-classifier'
  | 'snippet-lineage';

export type ConnectionEdgeProducedBy =
  | {
      readonly source: ConnectionEdgeSource;
      readonly eventType?: string;
      readonly dot?: ConnectionEdgeDot;
      readonly recordId?: string;
      readonly revisionId?: never;
    }
  | {
      readonly source: RevisionProducedBySource;
      readonly revisionId: string;
      readonly eventType?: never;
      readonly dot?: never;
      readonly recordId?: never;
    }
  | {
      readonly source: 'cross-replica';
      readonly eventType?: never;
      readonly dot?: never;
      readonly recordId?: never;
      readonly revisionId?: never;
    };

export interface ConnectionEdge {
  // Deterministic id: `edge:<kind>:<from>:<to>`. Same edge across
  // re-runs gets the same id, so dedup is trivial and the snapshot
  // is byte-stable when sorted.
  readonly id: string;
  readonly kind: ConnectionEdgeKind;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly observedAt: string;
  readonly producedBy: ConnectionEdgeProducedBy;
  // 'asserted' = user-entered or user-authored state surfaced directly.
  // 'observed' = event/telemetry-derived fact observed by the system.
  // 'inferred' = deterministic algorithmic joins / similarity-style links.
  readonly confidence: 'asserted' | 'observed' | 'inferred';
}

export interface ConnectionsSnapshotScope {
  readonly since?: string;
  readonly until?: string;
  readonly workstreamId?: string;
  readonly nodeId?: string;
  readonly hops?: number;
}

export interface ConnectionsSnapshot {
  readonly scope: ConnectionsSnapshotScope;
  readonly nodes: readonly ConnectionNode[];
  readonly edges: readonly ConnectionEdge[];
  // Max observedAt across the inputs. NEVER wall-clock — keeps the
  // snapshot byte-deterministic across replays.
  readonly updatedAt: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
}

// Helper id minters — exported so the materializer / tests / HTTP
// routes can build ids without re-implementing the convention.
export const nodeIdFor = (kind: ConnectionNodeKind, key: string): string =>
  `${kind}:${key}`;

export const edgeIdFor = (
  kind: ConnectionEdgeKind,
  fromNodeId: string,
  toNodeId: string,
): string => `edge:${kind}:${fromNodeId}:${toNodeId}`;

// Plugin-side mirror of the companion's Connections graph types.
// Kept loose intentionally — the companion is the source of truth;
// the side panel reads what's on the wire and renders it. Updating
// the companion's shape doesn't immediately break the panel.

export type ConnectionNodeKind =
  | 'thread'
  | 'workstream'
  | 'dispatch'
  | 'queue-item'
  | 'inbound-reminder'
  | 'coding-session'
  | 'timeline-visit'
  | 'visit-instance'
  | 'tab-session'
  | 'annotation'
  | 'snippet'
  | 'topic'
  | 'replica';

export interface ConnectionNode {
  readonly id: string;
  readonly kind: ConnectionNodeKind;
  readonly label: string;
  readonly firstSeenAt?: string;
  readonly lastSeenAt?: string;
  readonly originReplicaIds: readonly string[];
  readonly metadata: Record<string, unknown>;
}

export interface ConnectionEdgeProducedBy {
  readonly source: string;
  readonly eventType?: string;
  readonly dot?: { readonly replicaId: string; readonly seq: number };
  readonly recordId?: string;
  readonly revisionId?: string;
}

export interface ConnectionEdge {
  readonly id: string;
  readonly kind: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly observedAt: string;
  readonly producedBy: ConnectionEdgeProducedBy;
  readonly confidence: 'asserted' | 'observed' | 'inferred';
  readonly metadata?: Record<string, unknown>;
}

export interface ConnectionsSnapshot {
  readonly scope: Record<string, unknown>;
  readonly nodes: readonly ConnectionNode[];
  readonly edges: readonly ConnectionEdge[];
  readonly updatedAt: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
}

export interface ConnectionsScopedResult {
  readonly scope:
    | 'plugin-active'
    | 'companion-extended'
    | 'plugin-active-only-companion-unreachable';
  readonly snapshot: ConnectionsSnapshot;
  readonly note?: string;
}

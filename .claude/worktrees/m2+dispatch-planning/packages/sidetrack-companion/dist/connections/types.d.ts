export type ConnectionNodeKind = 'thread' | 'workstream' | 'dispatch' | 'queue-item' | 'inbound-reminder' | 'coding-session' | 'timeline-visit' | 'annotation';
export interface ConnectionNode {
    readonly id: string;
    readonly kind: ConnectionNodeKind;
    readonly label: string;
    readonly firstSeenAt?: string;
    readonly lastSeenAt?: string;
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
    readonly redacted?: boolean;
    readonly [key: string]: unknown;
}
export type ConnectionEdgeKind = 'thread_in_workstream' | 'workstream_parent_of' | 'dispatch_from_thread' | 'dispatch_in_workstream' | 'dispatch_reply_landed_in_thread' | 'dispatch_requested_coding_session' | 'queue_targets_thread' | 'queue_targets_workstream' | 'reminder_for_thread' | 'coding_session_in_workstream' | 'timeline_same_url_as_thread' | 'annotation_targets_thread' | 'annotation_targets_workstream' | 'thread_references_url' | 'dispatch_references_url' | 'annotation_references_url' | 'thread_quotes_thread' | 'thread_text_mentions_search_query' | 'visit_in_workstream';
export type ConnectionEdgeSource = 'event-log' | 'workboard-state' | 'timeline-projection' | 'coding-session-store' | 'dispatch-link-store' | 'annotation-store' | 'reminder-store';
export interface ConnectionEdge {
    readonly id: string;
    readonly kind: ConnectionEdgeKind;
    readonly fromNodeId: string;
    readonly toNodeId: string;
    readonly observedAt: string;
    readonly producedBy: {
        readonly source: ConnectionEdgeSource;
        readonly eventType?: string;
        readonly dot?: {
            readonly replicaId: string;
            readonly seq: number;
        };
        readonly recordId?: string;
    };
    readonly confidence: 'explicit' | 'deterministic';
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
    readonly updatedAt: string;
    readonly nodeCount: number;
    readonly edgeCount: number;
}
export declare const nodeIdFor: (kind: ConnectionNodeKind, key: string) => string;
export declare const edgeIdFor: (kind: ConnectionEdgeKind, fromNodeId: string, toNodeId: string) => string;
//# sourceMappingURL=types.d.ts.map
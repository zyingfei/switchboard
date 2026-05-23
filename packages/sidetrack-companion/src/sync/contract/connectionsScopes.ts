import type { ConnectionEdge, ConnectionNode } from '../../connections/types.js';
import type { InvalidationKey } from './invalidation.js';

export type ScopeKind = 'visit' | 'url' | 'tab-session' | 'workstream' | 'thread' | 'topic';

export interface Scope {
  readonly kind: ScopeKind;
  readonly id: string;
}

export const scopeKey = (scope: Scope): string => `${scope.kind}:${scope.id}`;

/**
 * Scope ownership is the replacement boundary for the Class B
 * materializer. Each graph entity has at least one owning scope; shared
 * entities may also be registered in secondary scopes so either scope
 * can replace its local view without orphaning rows owned elsewhere.
 *
 * Primary ownership:
 * - visit: visit-instance nodes and instance/tab/session/url/workstream edges.
 * - url: timeline-visit nodes and URL aggregate/reference/similarity edges.
 * - tab-session: tab-session nodes plus visit/session and opener edges.
 * - workstream: workstream nodes plus thread/topic/queue/coding/workstream membership edges.
 * - thread: thread nodes plus dispatch, annotation, queue, quote, and content-reference edges.
 * - topic: topic nodes plus topic membership and lineage edges.
 *
 * Secondary membership is endpoint-derived: when an edge touches a known
 * scoped node, that endpoint scope also owns the edge membership row.
 * Actual node/edge rows are single-copy in SQLite and are deleted only
 * after every membership row for that entity has been removed.
 */

const dedupeScopes = (scopes: readonly Scope[]): Scope[] => {
  const seen = new Set<string>();
  const out: Scope[] = [];
  for (const scope of scopes) {
    if (scope.id.length === 0) continue;
    const key = scopeKey(scope);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(scope);
  }
  return out.sort((a, b) => scopeKey(a).localeCompare(scopeKey(b)));
};

const idAfterPrefix = (nodeId: string, prefix: string): string | null =>
  nodeId.startsWith(prefix) && nodeId.length > prefix.length ? nodeId.slice(prefix.length) : null;

export const scopesForNode = (node: Pick<ConnectionNode, 'id' | 'kind' | 'metadata'>): Scope[] => {
  const scopes: Scope[] = [];
  if (node.kind === 'visit-instance') {
    scopes.push({ kind: 'visit', id: idAfterPrefix(node.id, 'visit-instance:') ?? node.id });
    const canonicalUrl = node.metadata['canonicalUrl'];
    const tabSessionId = node.metadata['tabSessionId'];
    if (typeof canonicalUrl === 'string') scopes.push({ kind: 'url', id: canonicalUrl });
    if (typeof tabSessionId === 'string') scopes.push({ kind: 'tab-session', id: tabSessionId });
  } else if (node.kind === 'timeline-visit') {
    scopes.push({ kind: 'url', id: idAfterPrefix(node.id, 'timeline-visit:') ?? node.id });
    const workstreamId = node.metadata['workstreamId'];
    if (typeof workstreamId === 'string') scopes.push({ kind: 'workstream', id: workstreamId });
  } else if (node.kind === 'tab-session') {
    scopes.push({ kind: 'tab-session', id: idAfterPrefix(node.id, 'tab-session:') ?? node.id });
  } else if (node.kind === 'workstream') {
    scopes.push({ kind: 'workstream', id: idAfterPrefix(node.id, 'workstream:') ?? node.id });
  } else if (node.kind === 'thread') {
    scopes.push({ kind: 'thread', id: idAfterPrefix(node.id, 'thread:') ?? node.id });
    const workstreamId = node.metadata['workstreamId'];
    if (typeof workstreamId === 'string') scopes.push({ kind: 'workstream', id: workstreamId });
  } else if (node.kind === 'topic') {
    scopes.push({ kind: 'topic', id: idAfterPrefix(node.id, 'topic:') ?? node.id });
  } else {
    const threadId = node.metadata['threadId'];
    const workstreamId = node.metadata['workstreamId'];
    if (typeof threadId === 'string') scopes.push({ kind: 'thread', id: threadId });
    if (typeof workstreamId === 'string') scopes.push({ kind: 'workstream', id: workstreamId });
  }
  return dedupeScopes(scopes);
};

const scopesForNodeId = (nodeId: string): Scope[] => {
  const direct: Scope[] = [];
  const visit = idAfterPrefix(nodeId, 'visit-instance:');
  const url = idAfterPrefix(nodeId, 'timeline-visit:');
  const tabSession = idAfterPrefix(nodeId, 'tab-session:');
  const workstream = idAfterPrefix(nodeId, 'workstream:');
  const thread = idAfterPrefix(nodeId, 'thread:');
  const topic = idAfterPrefix(nodeId, 'topic:');
  if (visit !== null) direct.push({ kind: 'visit', id: visit });
  if (url !== null) direct.push({ kind: 'url', id: url });
  if (tabSession !== null) direct.push({ kind: 'tab-session', id: tabSession });
  if (workstream !== null) direct.push({ kind: 'workstream', id: workstream });
  if (thread !== null) direct.push({ kind: 'thread', id: thread });
  if (topic !== null) direct.push({ kind: 'topic', id: topic });
  return direct;
};

export const scopesForEdge = (edge: ConnectionEdge): Scope[] =>
  dedupeScopes([...scopesForNodeId(edge.fromNodeId), ...scopesForNodeId(edge.toNodeId)]);

export const scopesForGraphRows = (input: {
  readonly nodes: readonly ConnectionNode[];
  readonly edges: readonly ConnectionEdge[];
}): {
  readonly nodeScopes: ReadonlyMap<string, readonly Scope[]>;
  readonly edgeScopes: ReadonlyMap<string, readonly Scope[]>;
} => {
  const nodeById = new Map(input.nodes.map((node) => [node.id, node] as const));
  const nodeScopes = new Map<string, readonly Scope[]>();
  for (const node of input.nodes) nodeScopes.set(node.id, scopesForNode(node));
  const edgeScopes = new Map<string, readonly Scope[]>();
  for (const edge of input.edges) {
    const endpointScopes = [
      ...(nodeById.get(edge.fromNodeId) === undefined
        ? scopesForNodeId(edge.fromNodeId)
        : scopesForNode(nodeById.get(edge.fromNodeId)!)),
      ...(nodeById.get(edge.toNodeId) === undefined
        ? scopesForNodeId(edge.toNodeId)
        : scopesForNode(nodeById.get(edge.toNodeId)!)),
    ];
    edgeScopes.set(`${edge.fromNodeId}\u0000${edge.toNodeId}`, dedupeScopes(endpointScopes));
  }
  return { nodeScopes, edgeScopes };
};

export const invalidationKeysToScopes = (keys: readonly InvalidationKey[]): Scope[] => {
  const scopes: Scope[] = [];
  for (const key of keys) {
    if (key.kind === 'url') scopes.push({ kind: 'url', id: key.canonicalUrl });
    else if (key.kind === 'tabSession') scopes.push({ kind: 'tab-session', id: key.tabSessionId });
    else if (key.kind === 'thread') scopes.push({ kind: 'thread', id: key.bacId });
    else if (key.kind === 'workstream') scopes.push({ kind: 'workstream', id: key.bacId });
    else if (key.kind === 'workstreamPathMemo') scopes.push({ kind: 'workstream', id: key.bacId });
    else if (key.kind === 'engagementVisit') scopes.push({ kind: 'visit', id: key.visitId });
    else if (key.kind === 'topicMember') {
      scopes.push({ kind: 'visit', id: key.visitId });
      scopes.push({ kind: 'url', id: key.visitId });
    } else if (key.kind === 'pageEvidence') scopes.push({ kind: 'url', id: key.canonicalUrl });
    else if (key.kind === 'resolverAnchors') {
      for (const nodeId of key.nodeIds) scopes.push(...scopesForNodeId(nodeId));
    }
  }
  return dedupeScopes(scopes);
};

export const dedupeScopeList = dedupeScopes;

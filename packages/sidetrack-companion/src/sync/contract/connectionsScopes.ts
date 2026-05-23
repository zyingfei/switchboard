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
 * materializer. Each graph entity has exactly one local primary scope.
 *
 * Primary ownership:
 * - visit: visit-instance nodes and edges originating from them.
 * - url: timeline-visit nodes and URL attribution/reference/similarity edges.
 * - tab-session: tab-session nodes and tab-session attribution/opener edges.
 * - workstream: workstream nodes and direct workstream edges only.
 * - thread: thread nodes and thread attribution/reference/quote edges.
 * - topic: topic nodes and topic membership/lineage edges.
 *
 * Scope rows are deliberately not transitive. A workstream scope owns
 * only the workstream node and direct workstream-originated rows; it
 * does not accumulate everything reachable through visit/thread/topic
 * edges.
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
  } else if (node.kind === 'timeline-visit') {
    scopes.push({ kind: 'url', id: idAfterPrefix(node.id, 'timeline-visit:') ?? node.id });
  } else if (node.kind === 'tab-session') {
    scopes.push({ kind: 'tab-session', id: idAfterPrefix(node.id, 'tab-session:') ?? node.id });
  } else if (node.kind === 'workstream') {
    scopes.push({ kind: 'workstream', id: idAfterPrefix(node.id, 'workstream:') ?? node.id });
  } else if (node.kind === 'thread') {
    scopes.push({ kind: 'thread', id: idAfterPrefix(node.id, 'thread:') ?? node.id });
  } else if (node.kind === 'topic') {
    scopes.push({ kind: 'topic', id: idAfterPrefix(node.id, 'topic:') ?? node.id });
  } else if (node.kind === 'annotation') {
    const url = node.metadata['url'];
    if (typeof url === 'string') scopes.push({ kind: 'url', id: url });
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

const firstScopeForNodeId = (nodeId: string): Scope | null => scopesForNodeId(nodeId)[0] ?? null;

const scopeForEdge = (edge: ConnectionEdge): Scope | null => {
  if (edge.kind === 'visit_in_topic' || edge.kind === 'topic.lineage') {
    return firstScopeForNodeId(edge.toNodeId) ?? firstScopeForNodeId(edge.fromNodeId);
  }
  return firstScopeForNodeId(edge.fromNodeId) ?? firstScopeForNodeId(edge.toNodeId);
};

export const scopesForEdge = (edge: ConnectionEdge): Scope[] => {
  const scope = scopeForEdge(edge);
  return scope === null ? [] : [scope];
};

export const scopesForGraphRows = (input: {
  readonly nodes: readonly ConnectionNode[];
  readonly edges: readonly ConnectionEdge[];
}): {
  readonly nodeScopes: ReadonlyMap<string, readonly Scope[]>;
  readonly edgeScopes: ReadonlyMap<string, readonly Scope[]>;
} => {
  const nodeScopes = new Map<string, Scope[]>();
  for (const node of input.nodes) nodeScopes.set(node.id, scopesForNode(node));
  const edgeScopes = new Map<string, readonly Scope[]>();
  for (const edge of [...input.edges].sort((a, b) => a.id.localeCompare(b.id))) {
    const scopes = scopesForEdge(edge);
    edgeScopes.set(`${edge.fromNodeId}\u0000${edge.toNodeId}`, scopes);
    const primaryScope = scopes[0];
    if (primaryScope === undefined) continue;
    for (const nodeId of [edge.fromNodeId, edge.toNodeId]) {
      if ((nodeScopes.get(nodeId) ?? []).length > 0) continue;
      nodeScopes.set(nodeId, [primaryScope]);
    }
  }
  for (const edge of [...input.edges].sort((a, b) => a.id.localeCompare(b.id))) {
    const edgeKey = `${edge.fromNodeId}\u0000${edge.toNodeId}`;
    if ((edgeScopes.get(edgeKey) ?? []).length > 0) continue;
    const primaryScope =
      (nodeScopes.get(edge.fromNodeId) ?? [])[0] ?? (nodeScopes.get(edge.toNodeId) ?? [])[0];
    if (primaryScope === undefined) continue;
    edgeScopes.set(edgeKey, [primaryScope]);
    for (const nodeId of [edge.fromNodeId, edge.toNodeId]) {
      if ((nodeScopes.get(nodeId) ?? []).length > 0) continue;
      nodeScopes.set(nodeId, [primaryScope]);
    }
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
      // Topic membership can be emitted by visit-scoped engagement changes
      // and URL-scoped topic projection changes; invalidate both local owners.
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

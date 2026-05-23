import { buildConnectionsSnapshot, type ConnectionsSnapshot } from './snapshot.js';
import type { ConnectionEdge, ConnectionNode } from './types.js';
import type { Scope } from '../sync/contract/connectionsScopes.js';
import {
  dedupeScopeList,
  scopeKey,
  scopesForGraphRows,
} from '../sync/contract/connectionsScopes.js';
import type { ConnectionsInput } from './snapshot.js';

// Scope recompute consumes the same causal projection as full rebuilds:
// Class A aggregate events are folded by `mergeRegister`-backed
// projectors before graph rows are emitted, and tombstones only delete
// events whose creating dot is covered by the tombstone deps.

export interface ScopeRecomputeOutput {
  readonly nodes: readonly ConnectionNode[];
  readonly edges: readonly ConnectionEdge[];
}

const rowsForScope = (snapshot: ConnectionsSnapshot, scope: Scope): ScopeRecomputeOutput => {
  const wanted = scopeKey(scope);
  const memberships = scopesForGraphRows({ nodes: snapshot.nodes, edges: snapshot.edges });
  const nodes = snapshot.nodes.filter((node) =>
    (memberships.nodeScopes.get(node.id) ?? []).some((member) => scopeKey(member) === wanted),
  );
  const edges = snapshot.edges.filter((edge) =>
    (memberships.edgeScopes.get(`${edge.fromNodeId}\u0000${edge.toNodeId}`) ?? []).some(
      (member) => scopeKey(member) === wanted,
    ),
  );
  return { nodes, edges };
};

export const scopesForConnectionsSnapshot = (snapshot: ConnectionsSnapshot): Scope[] => {
  const memberships = scopesForGraphRows({ nodes: snapshot.nodes, edges: snapshot.edges });
  return dedupeScopeList([
    ...[...memberships.nodeScopes.values()].flat(),
    ...[...memberships.edgeScopes.values()].flat(),
  ]);
};

export const recomputeVisitScope = (
  visitId: string,
  input: ConnectionsInput,
): ScopeRecomputeOutput =>
  rowsForScope(buildConnectionsSnapshot(input), { kind: 'visit', id: visitId });

export const recomputeUrlScope = (
  canonicalUrl: string,
  input: ConnectionsInput,
): ScopeRecomputeOutput =>
  rowsForScope(buildConnectionsSnapshot(input), { kind: 'url', id: canonicalUrl });

export const recomputeTabSessionScope = (
  tabSessionId: string,
  input: ConnectionsInput,
): ScopeRecomputeOutput =>
  rowsForScope(buildConnectionsSnapshot(input), { kind: 'tab-session', id: tabSessionId });

export const recomputeWorkstreamScope = (
  workstreamId: string,
  input: ConnectionsInput,
): ScopeRecomputeOutput =>
  rowsForScope(buildConnectionsSnapshot(input), { kind: 'workstream', id: workstreamId });

export const recomputeThreadScope = (
  threadId: string,
  input: ConnectionsInput,
): ScopeRecomputeOutput =>
  rowsForScope(buildConnectionsSnapshot(input), { kind: 'thread', id: threadId });

export const recomputeTopicScope = (
  topicId: string,
  input: ConnectionsInput,
): ScopeRecomputeOutput =>
  rowsForScope(buildConnectionsSnapshot(input), { kind: 'topic', id: topicId });

export const recomputeScope = (scope: Scope, input: ConnectionsInput): ScopeRecomputeOutput => {
  if (scope.kind === 'visit') return recomputeVisitScope(scope.id, input);
  if (scope.kind === 'url') return recomputeUrlScope(scope.id, input);
  if (scope.kind === 'tab-session') return recomputeTabSessionScope(scope.id, input);
  if (scope.kind === 'workstream') return recomputeWorkstreamScope(scope.id, input);
  if (scope.kind === 'thread') return recomputeThreadScope(scope.id, input);
  return recomputeTopicScope(scope.id, input);
};

export const unionScopeOutputs = (
  outputs: readonly ScopeRecomputeOutput[],
): ScopeRecomputeOutput => {
  const nodes = new Map<string, ConnectionNode>();
  const edges = new Map<string, ConnectionEdge>();
  for (const output of outputs) {
    for (const node of output.nodes) nodes.set(node.id, node);
    for (const edge of output.edges) edges.set(edge.id, edge);
  }
  return {
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
};

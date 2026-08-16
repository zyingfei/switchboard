import type { ConnectionsSnapshot } from './snapshot.js';
import type { ConnectionEdge, ConnectionNode } from './types.js';
import type { Scope } from '../sync/contract/connectionsScopes.js';
import {
  dedupeScopeList,
  scopeKey,
  scopesForGraphRows,
} from '../sync/contract/connectionsScopes.js';

// Scope recompute consumes the same causal projection as full rebuilds:
// Class A aggregate events are folded by `mergeRegister`-backed
// projectors before graph rows are emitted, and tombstones only delete
// events whose creating dot is covered by the tombstone deps.

export interface ScopeRecomputeOutput {
  readonly nodes: readonly ConnectionNode[];
  readonly edges: readonly ConnectionEdge[];
}

// Perf note (2026-08-16, item 2 of the shutdown-watchdog +
// bounded-recomputeScopes fix): every scoped-delta drain in
// connectionsMaterializer.ts calls recomputeScope/rowsForScope once PER
// DIRTY SCOPE against the SAME snapshot object -- several independent
// hot loops there do this (the per-scope catch-up loop, the
// scopesToPreserve map, two separate dirtyScopes maps). rowsForScope
// used to call scopesForGraphRows -- a full O(nodes) pass plus TWO
// O(edges log edges) sorts -- from scratch on EVERY call, then linearly
// filtered the full nodes/edges arrays again to pick out one scope's
// rows. That makes a whole drain O(scopes * (nodes + edges log edges))
// when it only needs to be O(nodes + edges log edges) ONCE, followed by
// O(1)-amortized per-scope lookups.
//
// Measured live: `scopedDelta.recomputeScopes n=4781 nodes=4614
// edges=81046` took 723004ms in a single catch-up chunk (~151ms/scope)
// -- this redundant re-derivation is where that time went.
//
// Fix: build a per-scope node/edge INDEX once per snapshot (same cost
// as the old scopesForGraphRows call) and cache it by snapshot object
// identity. ConnectionsSnapshot.nodes/.edges are readonly -- every
// drain constructs a genuinely new snapshot object, so a WeakMap keyed
// on that object is automatically correct (a new snapshot object is
// always a cache miss; nothing can ever serve a stale index for a
// mutated snapshot) and automatically bounded (entries are reclaimed
// by the GC once a drain's snapshot goes out of scope -- no manual
// eviction, no size cap, no env gate needed). This changes ONLY where
// the O(nodes + edges) work happens (once, shared across every scope
// in a drain, instead of once per scope); the per-scope OUTPUT (which
// nodes/edges land in which scope, and their relative order) is
// unchanged -- see scopeRecompute.perf.test.ts for a byte-identical-
// output proof against the original filter-based implementation.
interface ScopeMembershipIndex {
  readonly nodesByScope: ReadonlyMap<string, readonly ConnectionNode[]>;
  readonly edgesByScope: ReadonlyMap<string, readonly ConnectionEdge[]>;
}

// Test-only counter: how many times the O(nodes + edges) index build
// actually ran. The fix's whole point is that this stays at 1 per
// snapshot no matter how many scopes are queried against it — see
// scopeRecompute.perf.test.ts.
let scopeMembershipIndexBuildCount = 0;
export const __scopeMembershipIndexBuildCountForTests = (): number =>
  scopeMembershipIndexBuildCount;

const buildScopeMembershipIndex = (snapshot: ConnectionsSnapshot): ScopeMembershipIndex => {
  scopeMembershipIndexBuildCount += 1;
  const memberships = scopesForGraphRows({ nodes: snapshot.nodes, edges: snapshot.edges });
  const nodesByScope = new Map<string, ConnectionNode[]>();
  for (const node of snapshot.nodes) {
    for (const scope of memberships.nodeScopes.get(node.id) ?? []) {
      const key = scopeKey(scope);
      const bucket = nodesByScope.get(key);
      if (bucket === undefined) nodesByScope.set(key, [node]);
      else bucket.push(node);
    }
  }
  const edgesByScope = new Map<string, ConnectionEdge[]>();
  for (const edge of snapshot.edges) {
    const membershipKey = `${edge.fromNodeId}\u0000${edge.toNodeId}`;
    for (const scope of memberships.edgeScopes.get(membershipKey) ?? []) {
      const key = scopeKey(scope);
      const bucket = edgesByScope.get(key);
      if (bucket === undefined) edgesByScope.set(key, [edge]);
      else bucket.push(edge);
    }
  }
  return { nodesByScope, edgesByScope };
};

let scopeMembershipIndexCache = new WeakMap<ConnectionsSnapshot, ScopeMembershipIndex>();

const membershipIndexFor = (snapshot: ConnectionsSnapshot): ScopeMembershipIndex => {
  const cached = scopeMembershipIndexCache.get(snapshot);
  if (cached !== undefined) return cached;
  const computed = buildScopeMembershipIndex(snapshot);
  scopeMembershipIndexCache.set(snapshot, computed);
  return computed;
};

/** Test-only: reset the cache so tests can't observe cross-test
 * snapshot identity reuse. Never called from production code. */
export const __resetScopeMembershipCacheForTests = (): void => {
  scopeMembershipIndexCache = new WeakMap();
  scopeMembershipIndexBuildCount = 0;
};

const rowsForScope = (snapshot: ConnectionsSnapshot, scope: Scope): ScopeRecomputeOutput => {
  const wanted = scopeKey(scope);
  const index = membershipIndexFor(snapshot);
  return {
    nodes: index.nodesByScope.get(wanted) ?? [],
    edges: index.edgesByScope.get(wanted) ?? [],
  };
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
  fullSnapshot: ConnectionsSnapshot,
): ScopeRecomputeOutput =>
  rowsForScope(fullSnapshot, { kind: 'visit', id: visitId });

export const recomputeUrlScope = (
  canonicalUrl: string,
  fullSnapshot: ConnectionsSnapshot,
): ScopeRecomputeOutput =>
  rowsForScope(fullSnapshot, { kind: 'url', id: canonicalUrl });

export const recomputeTabSessionScope = (
  tabSessionId: string,
  fullSnapshot: ConnectionsSnapshot,
): ScopeRecomputeOutput =>
  rowsForScope(fullSnapshot, { kind: 'tab-session', id: tabSessionId });

export const recomputeWorkstreamScope = (
  workstreamId: string,
  fullSnapshot: ConnectionsSnapshot,
): ScopeRecomputeOutput =>
  rowsForScope(fullSnapshot, { kind: 'workstream', id: workstreamId });

export const recomputeThreadScope = (
  threadId: string,
  fullSnapshot: ConnectionsSnapshot,
): ScopeRecomputeOutput =>
  rowsForScope(fullSnapshot, { kind: 'thread', id: threadId });

export const recomputeTopicScope = (
  topicId: string,
  fullSnapshot: ConnectionsSnapshot,
): ScopeRecomputeOutput =>
  rowsForScope(fullSnapshot, { kind: 'topic', id: topicId });

export const recomputeScope = (
  scope: Scope,
  fullSnapshot: ConnectionsSnapshot,
): ScopeRecomputeOutput => {
  if (scope.kind === 'visit') return recomputeVisitScope(scope.id, fullSnapshot);
  if (scope.kind === 'url') return recomputeUrlScope(scope.id, fullSnapshot);
  if (scope.kind === 'tab-session') return recomputeTabSessionScope(scope.id, fullSnapshot);
  if (scope.kind === 'workstream') return recomputeWorkstreamScope(scope.id, fullSnapshot);
  if (scope.kind === 'thread') return recomputeThreadScope(scope.id, fullSnapshot);
  return recomputeTopicScope(scope.id, fullSnapshot);
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

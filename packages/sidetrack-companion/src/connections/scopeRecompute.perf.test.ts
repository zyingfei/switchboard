import { beforeEach, describe, expect, it } from 'vitest';

import type { ConnectionsSnapshot } from './snapshot.js';
import type { ConnectionEdge, ConnectionNode } from './types.js';
import {
  scopeKey,
  scopesForGraphRows,
  type Scope,
} from '../sync/contract/connectionsScopes.js';
import {
  __resetScopeMembershipCacheForTests,
  __scopeMembershipIndexBuildCountForTests,
  recomputeScope,
  scopesForConnectionsSnapshot,
  type ScopeRecomputeOutput,
} from './scopeRecompute.js';

// Regression/perf coverage for the scopedDelta.recomputeScopes hot path
// (measured live 2026-08-15: `n=4781 nodes=4614 edges=81046` took
// 723004ms in a single catch-up chunk — ~151ms/scope). The root cause
// was `rowsForScope` calling `scopesForGraphRows` (a full O(nodes) pass
// plus TWO O(edges log edges) sorts) from scratch on EVERY scope, then
// linearly re-filtering the whole nodes/edges arrays to pick out one
// scope's rows — O(scopes * (nodes + edges log edges)) total. The fix
// builds a per-scope node/edge index once per snapshot (WeakMap-cached
// by snapshot object identity) and looks scopes up in it — see the perf
// note in scopeRecompute.ts.

// A byte-for-byte reproduction of the ORIGINAL (pre-fix) per-scope
// implementation: rebuild the full membership map from scratch, then
// linearly filter, on every call. Kept here (not in production code) so
// this test can assert the new cached implementation produces IDENTICAL
// output to the thing it replaced, not just "plausible" output.
const rowsForScopeUncached = (
  snapshot: ConnectionsSnapshot,
  scope: Scope,
): ScopeRecomputeOutput => {
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

/**
 * A synthetic snapshot shaped like the live incident: `scopeCount`
 * independent url-scoped timeline visits, each contributing one node
 * plus a handful of `closest_visit` similarity edges to neighboring
 * visits (so scopes overlap at the edges the way a real similarity
 * graph does, instead of each scope being a trivially isolated
 * singleton).
 */
const buildSyntheticSnapshot = (scopeCount: number, edgesPerNode: number): ConnectionsSnapshot => {
  const nodes: ConnectionNode[] = [];
  for (let i = 0; i < scopeCount; i += 1) {
    nodes.push({
      id: `timeline-visit:https://scope-recompute-perf.test/${String(i)}`,
      kind: 'timeline-visit',
      label: `Visit ${String(i)}`,
      originReplicaIds: [],
      metadata: { canonicalUrl: `https://scope-recompute-perf.test/${String(i)}` },
    });
  }
  const edges: ConnectionEdge[] = [];
  for (let i = 0; i < scopeCount; i += 1) {
    for (let k = 1; k <= edgesPerNode; k += 1) {
      const j = (i + k) % scopeCount;
      if (j === i) continue;
      const fromNodeId = nodes[i]?.id;
      const toNodeId = nodes[j]?.id;
      if (fromNodeId === undefined || toNodeId === undefined) continue;
      edges.push({
        id: `edge:closest_visit:${fromNodeId}:${toNodeId}`,
        kind: 'closest_visit',
        fromNodeId,
        toNodeId,
        observedAt: '2026-08-15T00:00:00.000Z',
        producedBy: { source: 'ranker', revisionId: 'scope-recompute-perf' },
        confidence: 'inferred',
      });
    }
  }
  return {
    scope: {},
    nodes,
    edges,
    updatedAt: '2026-08-15T00:00:00.000Z',
    nodeCount: nodes.length,
    edgeCount: edges.length,
  };
};

beforeEach(() => {
  __resetScopeMembershipCacheForTests();
});

describe('scoped-delta recomputeScope — cached index correctness', () => {
  it('produces byte-identical output to the original per-call implementation across every scope', () => {
    const snapshot = buildSyntheticSnapshot(120, 4);
    const scopes = scopesForConnectionsSnapshot(snapshot);
    expect(scopes.length).toBeGreaterThan(0);

    for (const scope of scopes) {
      const cached = recomputeScope(scope, snapshot);
      const uncached = rowsForScopeUncached(snapshot, scope);
      expect(cached.nodes).toEqual(uncached.nodes);
      expect(cached.edges).toEqual(uncached.edges);
    }
  });
});

describe('scoped-delta recomputeScope — membership index is built once per snapshot', () => {
  it('builds the O(nodes + edges) index exactly once no matter how many scopes are queried', () => {
    const snapshot = buildSyntheticSnapshot(300, 3);
    const scopes = scopesForConnectionsSnapshot(snapshot);
    expect(scopes.length).toBeGreaterThan(50);

    expect(__scopeMembershipIndexBuildCountForTests()).toBe(0);
    for (const scope of scopes) recomputeScope(scope, snapshot);
    // This is the load-bearing assertion: before the fix, an equivalent
    // per-scope loop rebuilt the full membership map from scratch on
    // EVERY call — the live incident's 723s/4781-scope chunk. With the
    // cache, one snapshot -> exactly one build, regardless of scope
    // count.
    expect(__scopeMembershipIndexBuildCountForTests()).toBe(1);

    // Querying the SAME snapshot again (e.g. a second pass over
    // dirtyScopes against the same scopedSnapshot, which several call
    // sites in connectionsMaterializer.ts do) must still hit the cache.
    for (const scope of scopes) recomputeScope(scope, snapshot);
    expect(__scopeMembershipIndexBuildCountForTests()).toBe(1);
  });

  it('never serves a stale index: a NEW snapshot object is always a fresh build', () => {
    const snapshotA = buildSyntheticSnapshot(40, 2);
    const snapshotB = buildSyntheticSnapshot(40, 2); // same shape, different object identity
    const scopesA = scopesForConnectionsSnapshot(snapshotA);
    const scopesB = scopesForConnectionsSnapshot(snapshotB);

    for (const scope of scopesA) recomputeScope(scope, snapshotA);
    expect(__scopeMembershipIndexBuildCountForTests()).toBe(1);

    for (const scope of scopesB) recomputeScope(scope, snapshotB);
    expect(__scopeMembershipIndexBuildCountForTests()).toBe(2);
  });
});

describe('scoped-delta recomputeScope — wall-clock speedup', () => {
  it(
    'is substantially faster than the original per-call implementation over many scopes ' +
      'against one snapshot',
    () => {
      // Sized to keep the test fast (well under a second either way at
      // this scale) while still giving the O(scopes) factor enough room
      // to show a real, non-noise-level ratio. The live incident was
      // 4781 scopes against an 81k-edge snapshot; this is deliberately
      // much smaller so CI stays fast — the ASYMPTOTIC gap this proves
      // is what matters, not matching production scale.
      const snapshot = buildSyntheticSnapshot(400, 5);
      const scopes = scopesForConnectionsSnapshot(snapshot);
      expect(scopes.length).toBeGreaterThan(100);

      const uncachedStartedAtMs = performance.now();
      for (const scope of scopes) rowsForScopeUncached(snapshot, scope);
      const uncachedMs = performance.now() - uncachedStartedAtMs;

      __resetScopeMembershipCacheForTests();
      const cachedStartedAtMs = performance.now();
      for (const scope of scopes) recomputeScope(scope, snapshot);
      const cachedMs = performance.now() - cachedStartedAtMs;

      // Generous ratio (not an absolute ms bound) so this doesn't flake
      // on a loaded shared machine — the fix's actual live-measured
      // effect is far larger than 3x at production scale.
      expect(cachedMs).toBeLessThan(uncachedMs / 3);
    },
  );
});

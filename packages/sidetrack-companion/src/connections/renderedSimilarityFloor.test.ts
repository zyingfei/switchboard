// Pure unit coverage for the RENDERED-edge floor — the terminal invariant
// on the served artifact (round 3). Tests the decision + endpoint-completion
// carry-forward in isolation (the round-1/round-2 mistake was testing one
// layer too high; the store-level acceptance tests live in
// connectionsMaterializer.renderedSimilarityFloor.test.ts).

import { describe, expect, it } from 'vitest';

import { nodeIdFor, edgeIdFor } from './types.js';
import type { ConnectionEdge, ConnectionNode, ConnectionsSnapshot } from './types.js';
import { recomputeSnapshotMetadataForCarriedRows } from './snapshot.js';
import {
  applyRenderedSimilarityFloor,
  countRenderedSimilarityFamilyEdges,
  isRenderedSimilarityCollapse,
} from './renderedSimilarityFloor.js';

const visitNode = (key: string): ConnectionNode => ({
  id: nodeIdFor('timeline-visit', key),
  kind: 'timeline-visit',
  label: key,
  originReplicaIds: ['replica-A'],
  metadata: { canonicalUrl: `https://example.test/${key}`, url: `https://example.test/${key}` },
});

const resemblesEdge = (from: string, to: string, cosine = 0.9): ConnectionEdge => ({
  id: edgeIdFor(
    'visit_resembles_visit',
    nodeIdFor('timeline-visit', from),
    nodeIdFor('timeline-visit', to),
  ),
  kind: 'visit_resembles_visit',
  fromNodeId: nodeIdFor('timeline-visit', from),
  toNodeId: nodeIdFor('timeline-visit', to),
  observedAt: '2026-07-24T00:00:00.000Z',
  producedBy: { source: 'visit-similarity', revisionId: 'rev-good' },
  confidence: 'inferred',
  family: 'urlmatch',
  metadata: { cosine, threshold: 0.85 },
});

const snapshot = (
  nodes: readonly ConnectionNode[],
  edges: readonly ConnectionEdge[],
): ConnectionsSnapshot => ({
  scope: {},
  nodes: [...nodes],
  edges: [...edges],
  updatedAt: '2026-07-24T00:00:00.000Z',
  nodeCount: nodes.length,
  edgeCount: edges.length,
  snapshotRevision: 'test-rev',
});

// A dense served snapshot: 6 visits, all pairs resemble (15 edges).
const denseServed = (): ConnectionsSnapshot => {
  const keys = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
  const nodes = keys.map(visitNode);
  const edges: ConnectionEdge[] = [];
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      edges.push(resemblesEdge(keys[i]!, keys[j]!));
    }
  }
  return snapshot(nodes, edges);
};

const recompute = (candidate: ConnectionsSnapshot) =>
  (nodes: readonly ConnectionNode[], edges: readonly ConnectionEdge[], updatedAt: string) =>
    recomputeSnapshotMetadataForCarriedRows(candidate, nodes, edges, updatedAt);

describe('renderedSimilarityFloor — cheap count (T5)', () => {
  it('counts both similarity-family edge kinds; ignores others', () => {
    const closest: ConnectionEdge = {
      ...resemblesEdge('alpha', 'bravo'),
      id: edgeIdFor(
        'closest_visit',
        nodeIdFor('timeline-visit', 'alpha'),
        nodeIdFor('timeline-visit', 'bravo'),
      ),
      kind: 'closest_visit',
      producedBy: { source: 'ranker', revisionId: 'r1' },
    };
    const unrelated: ConnectionEdge = {
      ...resemblesEdge('alpha', 'bravo'),
      id: 'edge:thread_in_workstream:thread:t1:workstream:w1',
      kind: 'thread_in_workstream',
    };
    const s = snapshot(
      [visitNode('alpha'), visitNode('bravo')],
      [resemblesEdge('alpha', 'bravo'), closest, unrelated],
    );
    expect(countRenderedSimilarityFamilyEdges(s)).toBe(2);
  });

  it('flags a collapse only below 10% of the previous served count', () => {
    expect(isRenderedSimilarityCollapse(0, 100)).toBe(true);
    expect(isRenderedSimilarityCollapse(9, 100)).toBe(true);
    expect(isRenderedSimilarityCollapse(10, 100)).toBe(false);
    // No previous signal — never a collapse (nothing to protect).
    expect(isRenderedSimilarityCollapse(0, 0)).toBe(false);
  });
});

describe('renderedSimilarityFloor — decision + endpoint-completion carry-forward (T1)', () => {
  it('publishes unchanged when the candidate did not collapse', () => {
    const previous = denseServed();
    const candidate = denseServed(); // same 15 edges
    const outcome = applyRenderedSimilarityFloor({
      candidate,
      previous,
      resetAllowed: false,
      recompute: recompute(candidate),
    });
    expect(outcome.action).toBe('publish');
    if (outcome.action === 'publish') {
      expect(outcome.candidateCount).toBe(15);
      expect(outcome.previousServedCount).toBe(15);
      expect(outcome.collapseAllowedByReset).toBe(false);
    }
  });

  it('REPAIRS a window-poor render that dropped every endpoint node', () => {
    const previous = denseServed(); // 6 visit nodes + 15 similarity edges
    // The candidate is the SAME snapshot rendered from a window-poor node
    // set: only 2 timeline-visit nodes survived, so Pass 7 dropped every
    // similarity edge (0 rendered) even though the revision held 15.
    const candidate = snapshot([visitNode('alpha'), visitNode('bravo')], []);
    const outcome = applyRenderedSimilarityFloor({
      candidate,
      previous,
      resetAllowed: false,
      recompute: recompute(candidate),
    });
    expect(outcome.action).toBe('repair');
    if (outcome.action !== 'repair') return;
    expect(outcome.candidateCount).toBe(0);
    expect(outcome.previousServedCount).toBe(15);
    // The repair restored all 15 similarity-family rows...
    expect(outcome.repairedCount).toBe(15);
    expect(countRenderedSimilarityFamilyEdges(outcome.snapshot)).toBe(15);
    // ...AND completed the missing endpoint timeline-visit nodes (all 6 back).
    const visitNodeCount = outcome.snapshot.nodes.filter(
      (node) => node.kind === 'timeline-visit',
    ).length;
    expect(visitNodeCount).toBe(6);
    // Every carried edge references a node that exists in the repaired snapshot
    // (no dangling endpoints — the endpoint-completion invariant).
    const nodeIds = new Set(outcome.snapshot.nodes.map((node) => node.id));
    for (const edge of outcome.snapshot.edges) {
      if (edge.kind !== 'visit_resembles_visit') continue;
      expect(nodeIds.has(edge.fromNodeId)).toBe(true);
      expect(nodeIds.has(edge.toNodeId)).toBe(true);
    }
    // Metadata recomputed (nodeCount/edgeCount consistent with arrays).
    expect(outcome.snapshot.nodeCount).toBe(outcome.snapshot.nodes.length);
    expect(outcome.snapshot.edgeCount).toBe(outcome.snapshot.edges.length);
  });

  it('keeps freshly re-rendered edges on collision (candidate wins over previous)', () => {
    const previous = denseServed();
    // Candidate re-rendered ONE pair with a different cosine (fresh producer
    // value) but is otherwise window-poor (collapse). The fresh edge must win.
    const freshEdge = resemblesEdge('alpha', 'bravo', 0.99);
    const candidate = snapshot([visitNode('alpha'), visitNode('bravo')], [freshEdge]);
    const outcome = applyRenderedSimilarityFloor({
      candidate,
      previous,
      resetAllowed: false,
      recompute: recompute(candidate),
    });
    expect(outcome.action).toBe('repair');
    if (outcome.action !== 'repair') return;
    const carriedAlphaBravo = outcome.snapshot.edges.find((edge) => edge.id === freshEdge.id);
    expect(carriedAlphaBravo?.metadata?.['cosine']).toBe(0.99); // the fresh value, not 0.9
    expect(outcome.repairedCount).toBe(15);
  });

  it('publishes a collapse HONESTLY under a legitimate reset (no repair)', () => {
    const previous = denseServed();
    const candidate = snapshot([visitNode('alpha')], []); // collapsed
    const outcome = applyRenderedSimilarityFloor({
      candidate,
      previous,
      resetAllowed: true, // e.g. a privacy purge / model change
      recompute: recompute(candidate),
    });
    expect(outcome.action).toBe('publish');
    if (outcome.action === 'publish') {
      expect(outcome.collapseAllowedByReset).toBe(true);
      expect(outcome.candidateCount).toBe(0);
    }
    // Candidate is NOT mutated — the reset's empty render stands.
    expect(countRenderedSimilarityFamilyEdges(candidate)).toBe(0);
  });

  it('publishes honestly on a fresh vault (no previous snapshot to repair from)', () => {
    const candidate = snapshot([visitNode('alpha'), visitNode('bravo')], []);
    const outcome = applyRenderedSimilarityFloor({
      candidate,
      previous: null,
      resetAllowed: false,
      recompute: recompute(candidate),
    });
    expect(outcome.action).toBe('publish');
    if (outcome.action === 'publish') {
      expect(outcome.previousServedCount).toBe(0);
    }
  });

  it('does not resurrect an edge whose endpoint is gone from BOTH snapshots', () => {
    // Previous served a `charlie` endpoint, but `charlie` is a genuinely
    // deleted visit: absent from the candidate AND we simulate it absent from
    // the previous node set too (a torn previous snapshot). That edge cannot be
    // honestly carried — endpoint-completion is completion, not resurrection.
    const keys = ['alpha', 'bravo'];
    const previousNodes = keys.map(visitNode); // no 'charlie' node
    const previousEdges = [
      resemblesEdge('alpha', 'bravo'),
      resemblesEdge('alpha', 'charlie'), // dangling — charlie node missing
      resemblesEdge('bravo', 'charlie'), // dangling
    ];
    const previous = snapshot(previousNodes, previousEdges);
    const candidate = snapshot([visitNode('alpha')], []); // collapsed
    const outcome = applyRenderedSimilarityFloor({
      candidate,
      previous,
      resetAllowed: false,
      recompute: recompute(candidate),
    });
    expect(outcome.action).toBe('repair');
    if (outcome.action !== 'repair') return;
    // Only alpha↔bravo carried (both endpoints exist); the two charlie edges
    // are dropped (no honest endpoint node to attach to).
    expect(outcome.repairedCount).toBe(1);
    const nodeIds = new Set(outcome.snapshot.nodes.map((node) => node.id));
    for (const edge of outcome.snapshot.edges) {
      expect(nodeIds.has(edge.fromNodeId)).toBe(true);
      expect(nodeIds.has(edge.toNodeId)).toBe(true);
    }
  });
});

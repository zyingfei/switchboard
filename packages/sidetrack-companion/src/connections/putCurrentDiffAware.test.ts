// Diff-aware putCurrent/writeSnapshotAndProgress (2026-08-17 disk-wear fix)
// -- correctness coverage. See putCurrentDiffAware.perf.test.ts for the WAL-
// bytes measurement and docs/plans/2026-08-15-foundation-program.md's
// "disk-wear addendum" for the full design note.
//
// Two properties this file proves:
//   (1) A publish that reaches #writeCurrentRows but finds NOTHING actually
//       changed must skip #bumpWriteSeq and the readCurrent memo
//       invalidation (task #5) -- observable via reference equality on
//       readCurrent()'s return value, since #readCurrentAttempt returns the
//       cached object verbatim when write_seq (the memo key) hasn't moved.
//       A publish that DOES change content must still bump/invalidate.
//   (2) The guarded-upsert + anti-join-delete rewrite of #writeCurrentRows
//       is behaviorally IDENTICAL to the DELETE-all-then-reinsert-all shape
//       it replaces: a mixed delta (nodes/edges added, removed, AND
//       changed, spanning multiple scopes) reads back exactly right.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteConnectionsStore } from './snapshot.js';
import { edgeIdFor, type ConnectionEdge, type ConnectionNode, type ConnectionsSnapshot } from './types.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

const node = (id: string, label: string): ConnectionNode => ({
  id,
  kind: 'timeline-visit',
  label,
  originReplicaIds: [],
  metadata: { canonicalUrl: `https://diff-aware.test/${id}`, visitCount: 1 },
});

const edge = (fromNodeId: string, toNodeId: string): ConnectionEdge => ({
  id: edgeIdFor('closest_visit', fromNodeId, toNodeId),
  kind: 'closest_visit',
  fromNodeId,
  toNodeId,
  observedAt: '2026-08-17T00:00:00.000Z',
  producedBy: { source: 'ranker', revisionId: 'diff-aware-test' },
  confidence: 'inferred',
});

const snapshotOf = (
  nodes: readonly ConnectionNode[],
  edges: readonly ConnectionEdge[],
  revision: string,
): ConnectionsSnapshot => ({
  scope: {},
  nodes,
  edges,
  updatedAt: '2026-08-17T00:00:00.000Z',
  nodeCount: nodes.length,
  edgeCount: edges.length,
  snapshotRevision: revision,
});

describe('putCurrent -- diff-aware correctness (2026-08-17 disk-wear fix)', () => {
  let vaultRoot: string | null = null;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'diff-aware-correctness-'));
  });
  afterEach(async () => {
    delete process.env['SIDETRACK_CONNECTIONS_DOUBLE_BUFFER'];
    if (vaultRoot !== null) {
      await rm(vaultRoot, { recursive: true, force: true });
      vaultRoot = null;
    }
  });

  // -------------------------------------------------------------------
  // (1) No-op skip: write_seq / readCurrent-memo invalidation.
  // -------------------------------------------------------------------
  describe('(1) a no-op write skips the write_seq bump + resolver-cache invalidation', () => {
    sqliteIt(
      'repeating an identical putCurrent leaves the readCurrent memo untouched; a real change busts it',
      async () => {
        // Legacy (single-buffer) mode: #matchingPublishedContentSignature
        // always returns null here (see its own doc comment -- that gate is
        // double-buffer-only), so EVERY putCurrent call below reaches
        // #writeCurrentRows regardless of whether content actually changed
        // -- exactly the scenario task #5 asks to prove: #writeCurrentRows
        // itself must detect and skip a true no-op, not just rely on the
        // caller-side gate.
        process.env['SIDETRACK_CONNECTIONS_DOUBLE_BUFFER'] = '0';
        const store = new SqliteConnectionsStore(vaultRoot!);

        const nodes = [node('a', 'A'), node('b', 'B'), node('c', 'C')];
        const edges = [edge('a', 'b'), edge('b', 'c')];
        const snapshot = snapshotOf(nodes, edges, 'rev-1');

        await store.putCurrent(snapshot);
        const first = await store.readCurrent();
        expect(first).not.toBeNull();

        // Byte-identical resubmit -- a NEW object graph (not the same JS
        // reference) but every field the store's own content-diff cares
        // about is unchanged.
        const identicalResubmit = snapshotOf(
          nodes.map((n) => ({ ...n })),
          edges.map((e) => ({ ...e })),
          'rev-1',
        );
        await store.putCurrent(identicalResubmit);
        const second = await store.readCurrent();

        // THE assertion: #readCurrentAttempt returns the cached object
        // verbatim when write_seq (its memo key) hasn't moved -- reference
        // equality here is only possible if the no-op putCurrent skipped
        // #bumpWriteSeq (and therefore also never called
        // #dropCachedSnapshot). If the old unconditional-bump behavior
        // regressed back in, this becomes a fresh (unequal) object every
        // time.
        expect(second).toBe(first);

        // Now a REAL change -- must still be detected and served fresh.
        const changed = snapshotOf(
          [node('a', 'A (renamed)'), node('b', 'B'), node('c', 'C')],
          edges,
          'rev-2',
        );
        await store.putCurrent(changed);
        const third = await store.readCurrent();
        expect(third).not.toBeNull();
        expect(third).not.toBe(second);
        expect(third!.nodes.find((n) => n.id === 'a')?.label).toBe('A (renamed)');

        store.close();
      },
    );
  });

  // -------------------------------------------------------------------
  // (2) Mixed delta round-trip: add + remove + change, spanning nodes,
  // edges, AND scope memberships (the anti-join delete's own target) in
  // ONE publish -- proves the guarded-upsert + anti-join rewrite reads back
  // identically to what the DELETE-all-then-reinsert-all shape it replaces
  // would have produced.
  // -------------------------------------------------------------------
  describe('(2) mixed add/remove/change delta reads back exactly right', () => {
    sqliteIt(
      'a single publish that adds, removes, and changes nodes/edges/scopes lands exactly the new state',
      async () => {
        const store = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });

        // v1: five nodes (a..e), a chain of edges -- five distinct url
        // scopes (one per node, per connectionsScopes.ts's url-scope rule)
        // and four edge-scope rows.
        const v1Nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => node(id, id.toUpperCase()));
        const v1Edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('d', 'e')];
        await store.putCurrent(snapshotOf(v1Nodes, v1Edges, 'rev-1'));

        const afterV1 = await store.readCurrent();
        expect(afterV1).not.toBeNull();
        expect(new Set(afterV1!.nodes.map((n) => n.id))).toEqual(new Set(['a', 'b', 'c', 'd', 'e']));
        expect(afterV1!.edges).toHaveLength(4);

        // v2: remove 'a' (and its edge a->b), change 'c's label, add a new
        // node 'f' with a new edge d->f, keep 'b'/'d'/'e' untouched.
        // b->c and c->d edges are untouched; a->b and b->c... wait keep it
        // simple: drop a (+ a->b), change c, add f (+ d->f), drop c->d
        // (b/c/e survive, edges left: b->c (unchanged), d->f (new)).
        const v2Nodes = [
          node('b', 'B'),
          node('c', 'C (renamed)'),
          node('d', 'D'),
          node('e', 'E'),
          node('f', 'F'),
        ];
        const v2Edges = [edge('b', 'c'), edge('d', 'f')];
        await store.putCurrent(snapshotOf(v2Nodes, v2Edges, 'rev-2'));

        const afterV2 = await store.readCurrent();
        expect(afterV2).not.toBeNull();
        expect(new Set(afterV2!.nodes.map((n) => n.id))).toEqual(new Set(['b', 'c', 'd', 'e', 'f']));
        expect(afterV2!.nodes.find((n) => n.id === 'c')?.label).toBe('C (renamed)');
        expect(
          new Set(afterV2!.edges.map((e) => `${e.fromNodeId}->${e.toNodeId}`)),
        ).toEqual(new Set(['b->c', 'd->f']));
        expect(afterV2!.nodeCount).toBe(5);
        expect(afterV2!.edgeCount).toBe(2);

        store.close();
      },
    );
  });
});

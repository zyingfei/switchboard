// Diff-aware putCurrent/writeSnapshotAndProgress (2026-08-17 disk-wear fix).
// See docs/plans/2026-08-15-foundation-program.md's "disk-wear addendum" for
// the live trace evidence this closes: ~506MB/min WAL writes on the test
// companion, dominated by connections/current*.db-wal, traced to
// connectionsMaterializer.ts's forceFullRebuildForThreadReconcile calling
// writeSnapshotAndProgress with dirtyScopes===undefined on essentially every
// catch-up/drain. Before this PR, #writeCurrentRows rewrote node_order/
// edge_order/metadata.current unconditionally EVERY publish and did
// DELETE-all-then-reinsert-all on connections_scope_nodes/_edges whenever
// dirtyScopes was undefined (the full-rebuild case) — an O(snapshot) write
// regardless of how small the actual content delta was. This test proves the
// fix: a 10-row change on a ~10k-node/50k-edge snapshot now writes bytes on
// the order of the CHANGE, not the snapshot.
//
// "naive vs diff-aware" framing: the OLD code wrote roughly the same volume
// on EVERY publish, changed or not — so the fixture's own on-disk size
// (`fixtureBytes`, written by the cold FIRST publish) is the naive-path
// stand-in this test compares the diff-aware SECOND publish's bytes against
// (same technique inPlacePublish.test.ts's "(3) write volume is O(delta)"
// suite already uses for replaceScopeRows).

import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SqliteConnectionsStore } from './snapshot.js';
import { generationDbPath, readPointer } from './generationBuffer.js';
import { edgeIdFor, type ConnectionEdge, type ConnectionNode } from './types.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

const NODE_COUNT = 10_000;
const EDGES_PER_NODE = 5; // -> ~50,000 edges total, matching the task's fixture spec.

const node = (i: number): ConnectionNode => ({
  id: `timeline-visit:https://diff-aware-perf.test/${String(i)}`,
  kind: 'timeline-visit',
  label: `Visit ${String(i)}`,
  originReplicaIds: [],
  metadata: {
    canonicalUrl: `https://diff-aware-perf.test/${String(i)}`,
    visitCount: 1,
  },
});

const edge = (fromNodeId: string, toNodeId: string, salt: number): ConnectionEdge => ({
  id: edgeIdFor('closest_visit', fromNodeId, `${toNodeId}#salt${String(salt)}`),
  kind: 'closest_visit',
  fromNodeId,
  toNodeId,
  observedAt: '2026-08-17T00:00:00.000Z',
  producedBy: { source: 'ranker', revisionId: 'diff-aware-perf' },
  confidence: 'inferred',
});

/** `NODE_COUNT` url-scoped timeline-visit nodes, each with `EDGES_PER_NODE`
 *  outgoing `closest_visit` edges to its nearest neighbors — dense enough to
 *  reach ~50k edges and give every node real scope-membership rows in
 *  connections_scope_nodes/_edges (the anti-join delete's target). */
const buildFixture = (): { readonly nodes: ConnectionNode[]; readonly edges: ConnectionEdge[] } => {
  const nodes = Array.from({ length: NODE_COUNT }, (_, i) => node(i));
  const edges: ConnectionEdge[] = [];
  for (let i = 0; i < NODE_COUNT; i += 1) {
    const from = nodes[i]!.id;
    for (let k = 1; k <= EDGES_PER_NODE; k += 1) {
      const to = nodes[(i + k) % NODE_COUNT]!.id;
      edges.push(edge(from, to, k));
    }
  }
  return { nodes, edges };
};

describe('putCurrent -- diff-aware WAL writes (2026-08-17 disk-wear fix)', () => {
  sqliteIt(
    'a 10-row change on a ~10k-node/50k-edge snapshot writes O(changed) bytes, not O(snapshot)',
    async () => {
      const vaultRoot = await mkdtemp(join(tmpdir(), 'diff-aware-perf-'));
      try {
        const { nodes, edges } = buildFixture();
        const connectionsDir = join(vaultRoot, '_BAC', 'connections');
        const writer = new SqliteConnectionsStore(vaultRoot, { role: 'child-writer' });

        // First publish: cold, from an empty vault. Necessarily O(snapshot)
        // (nothing to diff against) -- this is the "naive-equivalent" write
        // volume stand-in (see file header).
        const serializeStart = performance.now();
        JSON.stringify(nodes); // Same-order-of-magnitude "content_hash overhead"
        JSON.stringify(edges); // proxy -- see the second-publish comparison below.
        const bodySerializeMs = performance.now() - serializeStart;

        await writer.putCurrent({
          scope: {},
          nodes,
          edges,
          updatedAt: '2026-08-17T00:00:00.000Z',
          nodeCount: nodes.length,
          edgeCount: edges.length,
          snapshotRevision: 'rev-1',
        });

        const genId = readPointer(connectionsDir);
        expect(genId).not.toBeNull();
        const genPath = generationDbPath(connectionsDir, genId!);
        const walPath = `${genPath}-wal`;
        const fixtureBytes = statSync(genPath).size;
        // Document the achieved fixture size (sanity check on the fixture
        // shape, not a strict requirement).
        expect(fixtureBytes).toBeGreaterThan(1_000_000);

        // Second publish: 10 node labels changed; everything else --
        // remaining 9,990 nodes, all 50,000 edges, every scope membership,
        // node_order/edge_order -- BYTE-IDENTICAL to the first publish.
        const dbBytesBefore = statSync(genPath).size;
        const walBytesBefore = existsSync(walPath) ? statSync(walPath).size : 0;

        const changedNodes = nodes.map((n, i) =>
          i < 10 ? { ...n, label: `${n.label} (changed)` } : n,
        );

        const guardedCompareStart = performance.now();
        await writer.putCurrent({
          scope: {},
          nodes: changedNodes,
          edges,
          updatedAt: '2026-08-17T00:00:00.000Z',
          nodeCount: nodes.length,
          edgeCount: edges.length,
          snapshotRevision: 'rev-2',
        });
        const secondPublishMs = performance.now() - guardedCompareStart;

        const dbBytesAfter = statSync(genPath).size;
        const walBytesAfter = existsSync(walPath) ? statSync(walPath).size : 0;
        const secondWriteBytes =
          Math.max(0, dbBytesAfter - dbBytesBefore) + Math.max(0, walBytesAfter - walBytesBefore);

        writer.close();

        console.warn(
          `[putCurrent.diff-aware-perf] nodes=${String(nodes.length)} edges=${String(edges.length)} ` +
            `fixtureBytes=${String(fixtureBytes)} bodySerializeMs=${bodySerializeMs.toFixed(1)} ` +
            `changedRows=10 secondPublishMs=${secondPublishMs.toFixed(1)} ` +
            `secondWriteBytes=${String(secondWriteBytes)} ` +
            `(${(secondWriteBytes / fixtureBytes * 100).toFixed(4)}% of naive-equivalent fixture size)`,
        );

        // THE assertion this test exists for: a 10-row change writes O(changed)
        // bytes -- comfortably under 1MB, and nowhere close to the fixture's
        // own size (which is what the old unconditional
        // rewrite-node_order/edge_order + DELETE-all-scope-tables shape would
        // have written on EVERY publish, changed or not).
        expect(secondWriteBytes).toBeLessThan(1024 * 1024);
        expect(secondWriteBytes).toBeLessThan(fixtureBytes * 0.05);

        // Overhead check (task's "content-hash computation overhead" ask):
        // this PR does NOT add a content_hash column -- it extends the
        // pre-existing full-row JS string-compare idiom already used for
        // nodes/edges (see #writeCurrentRows) to node_order/edge_order/
        // metadata.current, and uses a pure SQL anti-join for the scope
        // tables (no JS-side row materialization at all). The guarded
        // second publish (diff + comparisons + the anti-join deletes) must
        // not be dramatically more expensive than serializing the fixture's
        // own node/edge bodies once (the cost the pre-existing code already
        // paid on every publish, changed or not).
        expect(secondPublishMs).toBeLessThan(Math.max(2000, bodySerializeMs * 20));
      } finally {
        await rm(vaultRoot, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

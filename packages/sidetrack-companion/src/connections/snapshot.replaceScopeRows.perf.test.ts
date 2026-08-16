import { describe, expect, vi, it } from 'vitest';

import { SqliteConnectionsStore } from './snapshot.js';
import { edgeIdFor, type ConnectionEdge, type ConnectionNode } from './types.js';
import { EMPTY_PROGRESS } from '../sync/contract/materializerProgress.js';

// Regression coverage for the 2026-08-16 "connections reconcile child hangs
// forever" incident. LIVE EVIDENCE: the reconcile child's phase log always
// stopped dead right after `scopedDelta.carryForwardSimilarity` — the very
// next store call is `replaceScopeRows` — then the child sat with its main
// thread 100% inside ONE `sqlite3_step` (sqlite3VdbeExec ->
// sqlite3BtreeNext -> moveToChild -> readDbPage -> pread) until the
// SIDETRACK_CONNECTIONS_CHILD_NOPROGRESS_MS watchdog SIGKILLed it — every
// restart, forever, always at the same spot.
//
// ROOT CAUSE (confirmed by reproducing the exact deleteOrphanEdges
// statement against an offline copy of the live vault's connections
// snapshot db, isolated from the live process): `trg_edges_index_au` /
// `trg_edges_index_ad` (the triggers that keep `edges_index` — the
// edge_id -> (src, dst, kind) lookup table — in sync with `edges`) each run
//   DELETE FROM edges_index WHERE src = OLD.src AND dst = OLD.dst
// once PER ROW touched on `edges`. `edges_index` was never given an index
// covering (src, dst) — only a PK on edge_id and an index on kind — so that
// DELETE resolved to `SCAN edges_index`: a full table scan, once per
// trigger firing. A scoped delta that deletes/updates K rows on `edges`
// against an edges_index of M rows costs O(K * M), not O(K). At this
// vault's live scale (K ~86,000 orphaned edges, M ~107,000 edges_index
// rows) that is ~9 billion row comparisons — comfortably past the 30-minute
// no-progress watchdog. Because replaceScopeRows runs the whole delta in
// one `BEGIN IMMEDIATE` transaction, a SIGKILL mid-statement rolls the
// transaction back completely, so the next reconcile child re-attempts the
// identical work and hangs at the identical spot — an infinite loop with no
// self-healing.
//
// Measured live (offline copy, 2026-08-16): the exact deleteOrphanEdges
// statement went from still running after 5+ minutes (killed, never
// finished) to 2.279s once `edges_index` carried an index on (src, dst),
// against an 18,966-node / 106,664-edge / 107,007-edges_index-row copy of
// the actual vault.
//
// The fix (in snapshot.ts's two schema-init blocks — #openDatabaseSerialized
// and #initSchemaOn) is one line:
//   CREATE INDEX IF NOT EXISTS idx_edges_index_src_dst ON edges_index(src, dst);
// `IF NOT EXISTS` + running on every writable-handle open makes this
// self-healing for every existing generation file (including the shadow
// clones the child-writer/parent-reader roles create per drain) the next
// time it is opened writable — no separate backfill/migration path needed.

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

const node = (id: string, label: string): ConnectionNode => ({
  id,
  kind: 'timeline-visit',
  label,
  originReplicaIds: [],
  metadata: { canonicalUrl: id.replace(/^timeline-visit:/u, '') },
});

const edge = (fromNodeId: string, toNodeId: string): ConnectionEdge => ({
  id: edgeIdFor('closest_visit', fromNodeId, toNodeId),
  kind: 'closest_visit',
  fromNodeId,
  toNodeId,
  observedAt: '2026-08-16T00:00:00.000Z',
  producedBy: { source: 'ranker', revisionId: 'replace-scope-rows-perf' },
  confidence: 'inferred',
});

/** `visitCount` independent url-scoped timeline visits, each with one
 *  `closest_visit` edge to its neighbor — shaped like the live incident's
 *  scoped-delta graph (see scopeRecompute.perf.test.ts's synthetic
 *  snapshot, same shape). Each edge's owning scope is `{kind:'url', id:
 *  <fromNodeId's URL>}` (connectionsScopes.ts's scopeForEdge), so
 *  `visitCount` visits produce `visitCount` distinct url scopes and
 *  `visitCount` distinct (src, dst) edges/edges_index rows. */
const buildGraph = (
  visitCount: number,
): { readonly nodes: ConnectionNode[]; readonly edges: ConnectionEdge[] } => {
  const nodes: ConnectionNode[] = [];
  for (let i = 0; i < visitCount; i += 1) {
    nodes.push(node(`timeline-visit:https://replace-scope-rows-perf.test/${String(i)}`, `Visit ${String(i)}`));
  }
  const edges: ConnectionEdge[] = [];
  for (let i = 0; i < visitCount; i += 1) {
    const from = nodes[i]?.id;
    const to = nodes[(i + 1) % visitCount]?.id;
    if (from === undefined || to === undefined) continue;
    edges.push(edge(from, to));
  }
  return { nodes, edges };
};

const urlScopeFor = (nodeId: string): { readonly kind: 'url'; readonly id: string } => ({
  kind: 'url',
  id: nodeId.replace(/^timeline-visit:/u, ''),
});

/** Grabs a live handle to the store's underlying bun:sqlite Database by
 *  intercepting the first `.query()` call it makes — matches the technique
 *  already used in sqlite-store.test.ts's replaceScopeRows query-shape
 *  assertion. The instance is real (not a new connection), so calling
 *  `.exec()` / `.query()` on it afterward operates on the exact db the
 *  store is using, including for an in-memory (`:memory:`) database. */
const captureDb = async (
  run: () => Promise<void>,
): Promise<InstanceType<typeof import('bun:sqlite').Database>> => {
  const { Database } = (await import('bun:sqlite')) as typeof import('bun:sqlite');
  const originalQuery = Database.prototype.query;
  let captured: InstanceType<typeof Database> | null = null;
  const spy = vi
    .spyOn(Database.prototype, 'query')
    .mockImplementation(function capture(this: InstanceType<typeof Database>, sql: string) {
      captured ??= this;
      return originalQuery.call(this, sql);
    });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  if (captured === null) throw new Error('store never issued a query — nothing captured');
  return captured;
};

describe('replaceScopeRows — edges_index cleanup index (2026-08-16 reconcile-child hang)', () => {
  sqliteIt('schema carries an index on edges_index(src, dst)', async () => {
    const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
    const { nodes, edges } = buildGraph(3);
    const db = await captureDb(async () => {
      await store.replaceScopeRows({
        scopes: nodes.map((n) => urlScopeFor(n.id)),
        nodes,
        edges,
        progress: { ...EMPTY_PROGRESS('connections', 'connections@test'), snapshotRevisionId: 'seed' },
      });
    });

    const indexRows = db.query("PRAGMA index_list('edges_index')").all() as readonly {
      readonly name: string;
    }[];
    expect(indexRows.some((row) => row.name === 'idx_edges_index_src_dst')).toBe(true);

    // The load-bearing assertion: the trigger statement that fires once per
    // row touched on `edges` (trg_edges_index_au / trg_edges_index_ad) must
    // resolve to an indexed SEARCH, never a full SCAN of edges_index.
    const plan = db
      .query('EXPLAIN QUERY PLAN DELETE FROM edges_index WHERE src = ? AND dst = ?')
      .all('irrelevant-src', 'irrelevant-dst') as readonly { readonly detail: string }[];
    expect(plan.some((row) => row.detail.includes('SCAN edges_index'))).toBe(false);
    expect(plan.some((row) => row.detail.includes('SEARCH edges_index'))).toBe(true);
    store.close();
  });

  sqliteIt(
    'deleting a large batch of edges is asymptotically faster with the index than without it',
    async () => {
      // Sized to keep this fast and non-flaky on a loaded CI box while
      // still giving the O(deletes * edges_index size) factor room to show
      // a real, non-noise ratio. The live incident was ~86k deletes against
      // a ~107k-row edges_index (9 billion comparisons, 30+ min); this is
      // deliberately much smaller — the ASYMPTOTIC gap is what matters.
      const visitCount = 1500;
      const { nodes, edges } = buildGraph(visitCount);
      const allScopes = nodes.map((n) => urlScopeFor(n.id));

      const seed = async (store: SqliteConnectionsStore): Promise<void> => {
        await store.replaceScopeRows({
          scopes: allScopes,
          nodes,
          edges,
          progress: {
            ...EMPTY_PROGRESS('connections', 'connections@test'),
            snapshotRevisionId: 'seed',
          },
        });
      };
      // Deleting (not replacing) half the scopes' edges — empty nodes/edges
      // for those scopes — forces deleteOrphanEdges to actually remove rows
      // from `edges`, firing trg_edges_index_ad for each one.
      const deletedScopes = allScopes.slice(0, Math.floor(visitCount / 2));
      const timeDelete = async (store: SqliteConnectionsStore): Promise<number> => {
        const startedAtMs = performance.now();
        await store.replaceScopeRows({
          scopes: deletedScopes,
          nodes: [],
          edges: [],
          progress: {
            ...EMPTY_PROGRESS('connections', 'connections@test'),
            snapshotRevisionId: 'delete-batch',
          },
        });
        return performance.now() - startedAtMs;
      };

      const withIndexStore = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
      await seed(withIndexStore);
      const withIndexMs = await timeDelete(withIndexStore);
      withIndexStore.close();

      const withoutIndexStore = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
      const db = await captureDb(() => seed(withoutIndexStore));
      // Simulate the pre-fix schema: drop the index this test (and the
      // production fix) relies on. Schema init already ran (#initialized is
      // now true), so it will not be silently re-created underneath us.
      db.exec('DROP INDEX IF EXISTS idx_edges_index_src_dst');
      const withoutIndexMs = await timeDelete(withoutIndexStore);
      withoutIndexStore.close();

      // Generous ratio (not an absolute ms bound) so this doesn't flake on
      // a loaded shared machine — the fix's actual live-measured effect is
      // far larger than 3x at production scale.
      expect(withIndexMs).toBeLessThan(withoutIndexMs / 3);
    },
  );
});

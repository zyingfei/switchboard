import { describe, expect, vi, it } from 'vitest';

import { SqliteConnectionsStore } from './snapshot.js';
import { EMPTY_PROGRESS } from '../sync/contract/materializerProgress.js';

// Row-value IN rewrite (2026-08-21, F9 follow-up — RE-DERIVED from the #402
// investigation's spike; see docs/plans/2026-08-15-foundation-program.md's
// 2026-08-21 F9 landing note and snapshot.ts's own comments on
// deleteScopeEdges/deleteOrphanEdges). The #378 incident (2026-08-16, see
// snapshot.replaceScopeRows.perf.test.ts) fixed a MISSING INDEX that turned
// an O(n) trigger into O(n * table_size); this is a SEPARATE, smaller cost
// the #402 investigation found: `replaceScopeRows`' own deleteScopeEdges/
// deleteOrphanEdges statements resolve to a full `SCAN` of their target
// table (connections_scope_edges / edges) because the EXISTS-correlated
// WHERE clause gives SQLite's planner no equality predicate to seek on for
// the outer table — deliberately accepted at the time
// (queryPlanLint.test.ts's `allowScanTables`) and filed as a ready-to-
// implement follow-up citing a `rowid IN (SELECT ... JOIN ...)` shape and a
// 54x number measured against a real vault copy.
//
// RE-DERIVATION FINDING, reported honestly per "evidence before
// conclusions": that literal `rowid IN (SELECT c.rowid FROM small_temp JOIN
// big_table c ON ...)` shape does NOT reliably avoid the scan on this
// repo's bun:sqlite/SQLite version — the query planner is free to reorder
// an ordinary JOIN and, at the selectivity this fixture models, chooses to
// drive the join from the BIG table (`SCAN c` in EXPLAIN QUERY PLAN, just
// with a Bloom-filter pre-check instead of a correlated subquery), which
// measured NO reliable speedup (sometimes a small regression) here. Two
// alternatives were spiked and empirically compared: forcing join order
// with `CROSS JOIN` (disables SQLite's reordering for that join), and
// restating the predicate as a row-value `(col1, col2) IN (subquery)`
// membership test with no JOIN at all. The row-value `IN` form won on both
// simplicity and measured speed and is what shipped. A SEPARATE, sharper
// finding while spiking the orphan-edges statement: naively extending the
// SAME row-value idiom to the NOT-EXISTS half (`(src, dst) NOT IN (SELECT
// ... FROM connections_scope_edges)`) is not just unhelpful but
// CATASTROPHIC — SQLite's row-value `NOT IN` against a large,
// non-uniquely-keyed subquery measured ~340x SLOWER (9+ seconds vs tens of
// ms) than the original EXISTS-correlated shape, almost certainly SQL's
// three-valued NULL-comparison semantics forcing a much more conservative
// plan. `deleteOrphanEdges` therefore keeps `NOT EXISTS` for that half and
// only replaces the OTHER (membership-in-the-touched-set) half with row-
// value `IN`. Measured, reproducible speedup on the fixture below is real
// but modest (roughly 1.5x-4x depending on run/fixture shape, not 54x) —
// the PLAN SHAPE change (SCAN -> SEARCH) is the load-bearing, asymptotic
// win; the wall-clock ratio on an in-memory/small-file synthetic fixture
// understates it relative to a real multi-hundred-MB generation file under
// disk-cache pressure, which the 54x figure was measured against and this
// suite does not attempt to reproduce.
//
// This file proves the shipped rewrite three ways: (1) equivalence — it
// deletes EXACTLY the same rows as the old EXISTS-correlated shape,
// including the #378-adjacent many-to-many scope/edge shapes; (2) measured
// speed on a large synthetic fixture; (3) a regression guard proving the
// NOT-IN trap really is catastrophic on this exact schema, so nobody
// "simplifies" deleteOrphanEdges into it later without re-reading this.

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

/** Grabs a live handle to the store's underlying bun:sqlite Database by
 *  intercepting the first `.query()` call — same technique as
 *  snapshot.replaceScopeRows.perf.test.ts / queryPlanLint.test.ts. */
const captureDb = async (
  run: () => Promise<void>,
): Promise<InstanceType<typeof import('bun:sqlite').Database>> => {
  const { Database } = (await import('bun:sqlite')) as typeof import('bun:sqlite');
  const originalQuery = Database.prototype.query;
  let captured: InstanceType<typeof Database> | null = null;
  const spy = vi
    .spyOn(Database.prototype, 'query')
    .mockImplementation(function capture(this: InstanceType<typeof Database>, sql: string) {
      // Capturing the spied receiver instance is the whole point of this
      // hook — there is no other way to get at the store's live bun:sqlite
      // handle (same pattern as queryPlanLint.test.ts's captureDb).
      // eslint-disable-next-line @typescript-eslint/no-this-alias
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

/** A real store's schema, including the temp_replace_* tables (created
 *  lazily inside replaceScopeRows itself) — created via one no-op
 *  replaceScopeRows call, same pattern as queryPlanLint.test.ts's
 *  buildSeededStore. Using the REAL schema (not hand-copied DDL) means this
 *  test can never silently drift from production. */
const buildSeededSchema = async (): Promise<{
  readonly store: SqliteConnectionsStore;
  readonly db: InstanceType<typeof import('bun:sqlite').Database>;
}> => {
  const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
  const db = await captureDb(async () => {
    await store.replaceScopeRows({
      scopes: [],
      nodes: [],
      edges: [],
      progress: { ...EMPTY_PROGRESS('connections', 'connections@rowid-test'), snapshotRevisionId: 'seed' },
    });
  });
  return { store, db };
};

const OLD_DELETE_SCOPE_EDGES = `DELETE FROM connections_scope_edges
 WHERE EXISTS (
   SELECT 1
   FROM temp_replace_scopes s
   WHERE s.scope_kind = connections_scope_edges.scope_kind
     AND s.scope_id = connections_scope_edges.scope_id
 )`;

const NEW_DELETE_SCOPE_EDGES = `DELETE FROM connections_scope_edges
 WHERE (scope_kind, scope_id) IN (
   SELECT scope_kind, scope_id FROM temp_replace_scopes
 )`;

const OLD_DELETE_ORPHAN_EDGES = `DELETE FROM edges
 WHERE EXISTS (
   SELECT 1
   FROM temp_replace_edges t
   WHERE t.edge_src = edges.src AND t.edge_dst = edges.dst
 )
   AND NOT EXISTS (
     SELECT 1
     FROM connections_scope_edges c
     WHERE c.edge_src = edges.src AND c.edge_dst = edges.dst
   )`;

const NEW_DELETE_ORPHAN_EDGES = `DELETE FROM edges
 WHERE (src, dst) IN (
   SELECT edge_src, edge_dst FROM temp_replace_edges
 )
   AND NOT EXISTS (
     SELECT 1 FROM connections_scope_edges c
     WHERE c.edge_src = edges.src AND c.edge_dst = edges.dst
   )`;

// The trap found while re-deriving this rewrite: restating the ORPHAN check
// (against connections_scope_edges, a large table with NO unique constraint
// on (edge_src, edge_dst) alone) as `NOT IN (subquery)` instead of
// `NOT EXISTS` is catastrophically slower, not faster — SQLite's row-value
// `NOT IN` must account for the possibility of a NULL-valued row on either
// side of the comparison per SQL's three-valued logic, which defeats the
// index-driven plan `IN`/`NOT EXISTS` get. Kept here, committed and
// regression-tested, specifically so nobody "simplifies" deleteOrphanEdges
// to `NOT IN` later — see the measured perf test below for the exact
// before/after numbers on this repo's own hardware.
const DANGEROUS_NOT_IN_ORPHAN_EDGES = `DELETE FROM edges
 WHERE (src, dst) IN (
   SELECT edge_src, edge_dst FROM temp_replace_edges
 )
   AND (src, dst) NOT IN (
     SELECT edge_src, edge_dst FROM connections_scope_edges
   )`;

interface EdgeFixtureRow {
  readonly src: string;
  readonly dst: string;
}
interface ScopeEdgeFixtureRow {
  readonly scopeKind: string;
  readonly scopeId: string;
  readonly src: string;
  readonly dst: string;
}

/** Seeds `edges` + `connections_scope_edges` directly (bypassing
 *  replaceScopeRows' own upsert path, for exact fixture control) plus the
 *  temp_replace_scopes/temp_replace_edges tables the delete statements read
 *  from — the same tables the real replaceScopeRows populates from its
 *  `scopes`/`edges` input before running its delete path. */
const seedFixture = (
  db: InstanceType<typeof import('bun:sqlite').Database>,
  fixture: {
    readonly edges: readonly EdgeFixtureRow[];
    readonly scopeEdges: readonly ScopeEdgeFixtureRow[];
    readonly replacedScopes: readonly { readonly kind: string; readonly id: string }[];
    readonly touchedEdges: readonly EdgeFixtureRow[];
  },
): void => {
  db.exec('DELETE FROM temp_replace_scopes; DELETE FROM temp_replace_edges;');
  const insertEdge = db.query('INSERT INTO edges (src, dst, data) VALUES (?, ?, ?)');
  for (const row of fixture.edges) {
    insertEdge.run(row.src, row.dst, JSON.stringify([{ id: `e:${row.src}->${row.dst}`, kind: 'closest_visit' }]));
  }
  const insertScopeEdge = db.query(
    'INSERT INTO connections_scope_edges (scope_kind, scope_id, edge_src, edge_dst) VALUES (?, ?, ?, ?)',
  );
  for (const row of fixture.scopeEdges) {
    insertScopeEdge.run(row.scopeKind, row.scopeId, row.src, row.dst);
  }
  const insertTempScope = db.query('INSERT OR IGNORE INTO temp_replace_scopes VALUES (?, ?)');
  for (const scope of fixture.replacedScopes) insertTempScope.run(scope.kind, scope.id);
  const insertTempEdge = db.query('INSERT OR IGNORE INTO temp_replace_edges VALUES (?, ?)');
  for (const row of fixture.touchedEdges) insertTempEdge.run(row.src, row.dst);
};

const remainingRows = (
  db: InstanceType<typeof import('bun:sqlite').Database>,
  table: 'edges' | 'connections_scope_edges',
): readonly unknown[] =>
  table === 'edges'
    ? db.query('SELECT src, dst FROM edges ORDER BY src, dst').all()
    : db
        .query(
          'SELECT scope_kind, scope_id, edge_src, edge_dst FROM connections_scope_edges ORDER BY scope_kind, scope_id, edge_src, edge_dst',
        )
        .all();

describe('replaceScopeRows rowid rewrite — equivalence (2026-08-21 F9 follow-up)', () => {
  sqliteIt(
    'deleteScopeEdges: OLD and NEW statements delete the identical row set, including a scope untouched this drain',
    async () => {
      const { store: oldStore, db: oldDb } = await buildSeededSchema();
      const { store: newStore, db: newDb } = await buildSeededSchema();
      try {
        const fixture = {
          edges: [],
          // Two scopes replaced this drain (scope-a, scope-b), one NOT
          // replaced (scope-c) -- the #378-adjacent shape: a big table with
          // many scope_kind/scope_id groups, only some of which are in the
          // small temp_replace_scopes driver set.
          scopeEdges: [
            { scopeKind: 'url', scopeId: 'scope-a', src: 'a', dst: 'b' },
            { scopeKind: 'url', scopeId: 'scope-b', src: 'c', dst: 'd' },
            { scopeKind: 'url', scopeId: 'scope-c', src: 'e', dst: 'f' },
            // Same (src, dst) referenced from BOTH a replaced and an
            // untouched scope -- proves the delete is scoped per-ROW
            // (scope_kind, scope_id, edge_src, edge_dst), not per edge.
            { scopeKind: 'url', scopeId: 'scope-a', src: 'g', dst: 'h' },
            { scopeKind: 'url', scopeId: 'scope-c', src: 'g', dst: 'h' },
          ],
          replacedScopes: [
            { kind: 'url', id: 'scope-a' },
            { kind: 'url', id: 'scope-b' },
          ],
          touchedEdges: [],
        };
        seedFixture(oldDb, fixture);
        seedFixture(newDb, fixture);

        oldDb.exec('BEGIN IMMEDIATE');
        oldDb.query(OLD_DELETE_SCOPE_EDGES).run();
        oldDb.exec('COMMIT');

        newDb.exec('BEGIN IMMEDIATE');
        newDb.query(NEW_DELETE_SCOPE_EDGES).run();
        newDb.exec('COMMIT');

        const oldRemaining = remainingRows(oldDb, 'connections_scope_edges');
        const newRemaining = remainingRows(newDb, 'connections_scope_edges');
        expect(newRemaining).toEqual(oldRemaining);
        // Pin the expected content directly too, not just "old === new" --
        // scope-c's rows (including the shared (g,h) edge's scope-c row)
        // must survive; scope-a/scope-b's rows must not.
        expect(newRemaining).toEqual([
          { scope_kind: 'url', scope_id: 'scope-c', edge_src: 'e', edge_dst: 'f' },
          { scope_kind: 'url', scope_id: 'scope-c', edge_src: 'g', edge_dst: 'h' },
        ]);
      } finally {
        oldStore.close();
        newStore.close();
      }
    },
  );

  sqliteIt(
    'deleteOrphanEdges: OLD and NEW statements delete the identical row set across every #378-relevant edge case',
    async () => {
      const { store: oldStore, db: oldDb } = await buildSeededSchema();
      const { store: newStore, db: newDb } = await buildSeededSchema();
      try {
        const fixture = {
          // (a,b): touched this drain, its only scope ref was just removed
          //        (not re-listed in scopeEdges below) -> truly orphaned,
          //        must be deleted.
          // (c,d): touched this drain, but STILL has a surviving scope ref
          //        (scope-keep, untouched) -> must NOT be deleted.
          // (e,f): untouched this drain (absent from temp_replace_edges)
          //        even though it also has no scope ref -- deleteOrphanEdges
          //        only considers rows the drain actually touched.
          // (g,h): touched this drain, had TWO scope refs, only one of
          //        which survives -> must NOT be deleted (still referenced).
          edges: [
            { src: 'a', dst: 'b' },
            { src: 'c', dst: 'd' },
            { src: 'e', dst: 'f' },
            { src: 'g', dst: 'h' },
          ],
          scopeEdges: [
            { scopeKind: 'url', scopeId: 'scope-keep', src: 'c', dst: 'd' },
            { scopeKind: 'url', scopeId: 'scope-keep', src: 'g', dst: 'h' },
          ],
          replacedScopes: [],
          touchedEdges: [
            { src: 'a', dst: 'b' },
            { src: 'c', dst: 'd' },
            { src: 'g', dst: 'h' },
          ],
        };
        seedFixture(oldDb, fixture);
        seedFixture(newDb, fixture);

        oldDb.exec('BEGIN IMMEDIATE');
        oldDb.query(OLD_DELETE_ORPHAN_EDGES).run();
        oldDb.exec('COMMIT');

        newDb.exec('BEGIN IMMEDIATE');
        newDb.query(NEW_DELETE_ORPHAN_EDGES).run();
        newDb.exec('COMMIT');

        const oldRemaining = remainingRows(oldDb, 'edges');
        const newRemaining = remainingRows(newDb, 'edges');
        expect(newRemaining).toEqual(oldRemaining);
        expect(newRemaining).toEqual([
          { src: 'c', dst: 'd' },
          { src: 'e', dst: 'f' },
          { src: 'g', dst: 'h' },
        ]);
      } finally {
        oldStore.close();
        newStore.close();
      }
    },
  );

  sqliteIt(
    'deleteScopeEdges + deleteOrphanEdges together reproduce a real scoped-timeline-delta round-trip identically',
    async () => {
      // End-to-end shape: replaceScopeRows runs deleteScopeEdges THEN
      // deleteOrphanEdges in sequence (snapshot.ts:7532-7535) -- prove the
      // PAIR composes identically under OLD vs NEW, not just each statement
      // in isolation.
      const { store: oldStore, db: oldDb } = await buildSeededSchema();
      const { store: newStore, db: newDb } = await buildSeededSchema();
      try {
        const fixture = {
          edges: [
            { src: 'a', dst: 'b' }, // orphaned by the scope delete -> edges delete removes it
            { src: 'c', dst: 'd' }, // kept alive by scope-keep
            { src: 'e', dst: 'f' }, // untouched entirely
          ],
          scopeEdges: [
            { scopeKind: 'url', scopeId: 'scope-replaced', src: 'a', dst: 'b' },
            { scopeKind: 'url', scopeId: 'scope-replaced', src: 'c', dst: 'd' },
            { scopeKind: 'url', scopeId: 'scope-keep', src: 'c', dst: 'd' },
            { scopeKind: 'url', scopeId: 'scope-untouched', src: 'e', dst: 'f' },
          ],
          replacedScopes: [{ kind: 'url', id: 'scope-replaced' }],
          touchedEdges: [
            { src: 'a', dst: 'b' },
            { src: 'c', dst: 'd' },
          ],
        };
        seedFixture(oldDb, fixture);
        seedFixture(newDb, fixture);

        oldDb.exec('BEGIN IMMEDIATE');
        oldDb.query(OLD_DELETE_SCOPE_EDGES).run();
        oldDb.query(OLD_DELETE_ORPHAN_EDGES).run();
        oldDb.exec('COMMIT');

        newDb.exec('BEGIN IMMEDIATE');
        newDb.query(NEW_DELETE_SCOPE_EDGES).run();
        newDb.query(NEW_DELETE_ORPHAN_EDGES).run();
        newDb.exec('COMMIT');

        expect(remainingRows(newDb, 'edges')).toEqual(remainingRows(oldDb, 'edges'));
        expect(remainingRows(newDb, 'connections_scope_edges')).toEqual(
          remainingRows(oldDb, 'connections_scope_edges'),
        );
        expect(remainingRows(newDb, 'edges')).toEqual([
          { src: 'c', dst: 'd' },
          { src: 'e', dst: 'f' },
        ]);
      } finally {
        oldStore.close();
        newStore.close();
      }
    },
  );
});

describe('replaceScopeRows rowid rewrite — measured speed (2026-08-21 F9 follow-up)', () => {
  sqliteIt(
    'deleteScopeEdges + deleteOrphanEdges are measurably faster with the row-value IN rewrite on a large fixture',
    async () => {
      // Scaled toward the real-vault shape the #402 investigation measured
      // (edges_index ~107k rows) while staying CI-fast. CRITICAL for
      // reproducing a real speedup: the TOTAL distinct-scope population
      // must be much larger than the REPLACED set this one drain touches
      // (matches the live phase-log line the investigation cites --
      // "scopes=4742" touched out of a much larger accumulated total across
      // the vault's history). A fixture where the replaced set covers 100%
      // of the corpus (tried first, while re-deriving this) shows NO
      // speedup at all: both the old scan and the new search must still
      // visit every row when literally every row matches, which is not the
      // shape a real scoped-timeline-delta has.
      const TOTAL_EDGE_COUNT = 110_000;
      const TOTAL_SCOPE_COUNT = 50_000;
      const REPLACED_SCOPE_COUNT = 4742;

      const buildLargeFixture = (): {
        readonly edges: readonly EdgeFixtureRow[];
        readonly scopeEdges: readonly ScopeEdgeFixtureRow[];
        readonly replacedScopes: readonly { readonly kind: string; readonly id: string }[];
        readonly touchedEdges: readonly EdgeFixtureRow[];
      } => {
        const edges: EdgeFixtureRow[] = [];
        for (let i = 0; i < TOTAL_EDGE_COUNT; i += 1) {
          edges.push({ src: `n${String(i)}`, dst: `n${String((i + 1) % TOTAL_EDGE_COUNT)}` });
        }
        // Every edge has exactly one scope reference, spread across the
        // FULL scope population (not just the replaced slice).
        const scopeEdges: ScopeEdgeFixtureRow[] = edges.map((edgeRow, i) => ({
          scopeKind: 'url',
          scopeId: `scope-${String(i % TOTAL_SCOPE_COUNT)}`,
          src: edgeRow.src,
          dst: edgeRow.dst,
        }));
        const replacedScopes = Array.from({ length: REPLACED_SCOPE_COUNT }, (_unused, i) => ({
          kind: 'url',
          id: `scope-${String(i)}`,
        }));
        // Only edges whose scope falls in the replaced slice are touched
        // this drain -- the minority, matching the real shape.
        const touchedEdges = edges.filter((_edgeRow, i) => i % TOTAL_SCOPE_COUNT < REPLACED_SCOPE_COUNT);
        return { edges, scopeEdges, replacedScopes, touchedEdges };
      };

      const fixture = buildLargeFixture();

      const { store: oldStore, db: oldDb } = await buildSeededSchema();
      const { store: newStore, db: newDb } = await buildSeededSchema();
      try {
        seedFixture(oldDb, fixture);
        seedFixture(newDb, fixture);
        oldDb.exec('ANALYZE');
        newDb.exec('ANALYZE');

        const timeStatement = (
          db: InstanceType<typeof import('bun:sqlite').Database>,
          sql: string,
        ): number => {
          const startedAtMs = performance.now();
          db.exec('BEGIN IMMEDIATE');
          db.query(sql).run();
          db.exec('COMMIT');
          return performance.now() - startedAtMs;
        };

        const oldScopeMs = timeStatement(oldDb, OLD_DELETE_SCOPE_EDGES);
        const newScopeMs = timeStatement(newDb, NEW_DELETE_SCOPE_EDGES);
        const oldOrphanMs = timeStatement(oldDb, OLD_DELETE_ORPHAN_EDGES);
        const newOrphanMs = timeStatement(newDb, NEW_DELETE_ORPHAN_EDGES);

        expect(remainingRows(newDb, 'connections_scope_edges')).toEqual(
          remainingRows(oldDb, 'connections_scope_edges'),
        );
        expect(remainingRows(newDb, 'edges')).toEqual(remainingRows(oldDb, 'edges'));

        const scopeSpeedup = oldScopeMs / Math.max(newScopeMs, 0.001);
        const orphanSpeedup = oldOrphanMs / Math.max(newOrphanMs, 0.001);
        // eslint-disable-next-line no-console
        console.info(
          `[measured] deleteScopeEdges: old=${oldScopeMs.toFixed(3)}ms new=${newScopeMs.toFixed(3)}ms speedup=${scopeSpeedup.toFixed(2)}x | ` +
            `deleteOrphanEdges: old=${oldOrphanMs.toFixed(3)}ms new=${newOrphanMs.toFixed(3)}ms speedup=${orphanSpeedup.toFixed(2)}x | ` +
            `fixture: ${String(TOTAL_EDGE_COUNT)} edges, ${String(TOTAL_SCOPE_COUNT)} total scopes, ${String(REPLACED_SCOPE_COUNT)} replaced`,
        );

        // Generous, NOT the literal measured ratio (which varies run to run
        // on a shared/loaded box) -- same convention as
        // snapshot.replaceScopeRows.perf.test.ts's index regression test.
        // Re-deriving this rewrite found the real, reproducible margin on
        // synthetic in-memory/small-file fixtures is modest (roughly
        // 1.2x-4x depending on run/fixture shape) -- NOT the 54x the #402
        // investigation measured against a real, much larger, disk-cache-
        // pressured generation file. The exact number is printed above for
        // the record; this bound only asserts "faster," not "how much."
        expect(newScopeMs).toBeLessThan(oldScopeMs);
        expect(newOrphanMs).toBeLessThan(oldOrphanMs);
      } finally {
        oldStore.close();
        newStore.close();
      }
    },
  );
});

describe('replaceScopeRows rowid rewrite — NOT IN trap regression guard (2026-08-21 F9 follow-up)', () => {
  sqliteIt(
    'deleteOrphanEdges: row-value NOT IN against the large scope table is dramatically slower than NOT EXISTS, never adopt it',
    async () => {
      // Documents and pins the exact trap found while re-deriving this
      // rewrite (see this file's header comment) so nobody "simplifies"
      // deleteOrphanEdges's NOT EXISTS into NOT IN later without re-reading
      // this. IMPORTANT: this trap is SIZE-SENSITIVE -- a small/fully-
      // touched fixture (tried first) shows no difference at all; it only
      // reproduces once (a) the connections_scope_edges-equivalent table is
      // large AND (b) only a MINORITY of edges are touched this drain,
      // matching the same realistic-selectivity shape the measured-speed
      // fixture above needed. Scaled down from the 110k-row fixture above
      // (which reproduces a ~340x ratio but takes 9+ seconds) to a size
      // that still reproduces a clear, fast (<1s) ratio.
      const EDGE_COUNT = 27_500;
      const SCOPE_COUNT = 12_500;
      const REPLACED_SCOPE_COUNT = 1186;
      const edges: EdgeFixtureRow[] = [];
      for (let i = 0; i < EDGE_COUNT; i += 1) {
        edges.push({ src: `n${String(i)}`, dst: `n${String((i + 1) % EDGE_COUNT)}` });
      }
      // Half the edges keep a scope reference -- the other half are already
      // orphan candidates regardless of what this drain touches.
      const scopeEdges: ScopeEdgeFixtureRow[] = edges
        .map((edgeRow, i) => ({ edgeRow, scopeIdx: i % SCOPE_COUNT }))
        .filter(({ scopeIdx }) => scopeIdx % 2 === 0)
        .map(({ edgeRow, scopeIdx }) => ({
          scopeKind: 'url',
          scopeId: `scope-${String(scopeIdx)}`,
          src: edgeRow.src,
          dst: edgeRow.dst,
        }));
      const touchedEdges = edges.filter((_edgeRow, i) => i % SCOPE_COUNT < REPLACED_SCOPE_COUNT);
      const fixture = {
        edges,
        scopeEdges,
        replacedScopes: [],
        touchedEdges,
      };

      const { store: safeStore, db: safeDb } = await buildSeededSchema();
      const { store: dangerousStore, db: dangerousDb } = await buildSeededSchema();
      try {
        seedFixture(safeDb, fixture);
        seedFixture(dangerousDb, fixture);
        safeDb.exec('ANALYZE');
        dangerousDb.exec('ANALYZE');

        const timeStatement = (
          db: InstanceType<typeof import('bun:sqlite').Database>,
          sql: string,
        ): number => {
          const startedAtMs = performance.now();
          db.exec('BEGIN IMMEDIATE');
          db.query(sql).run();
          db.exec('COMMIT');
          return performance.now() - startedAtMs;
        };

        const safeMs = timeStatement(safeDb, NEW_DELETE_ORPHAN_EDGES);
        const dangerousMs = timeStatement(dangerousDb, DANGEROUS_NOT_IN_ORPHAN_EDGES);

        // Same rows either way -- this is about performance, not
        // correctness (both are correct).
        expect(remainingRows(dangerousDb, 'edges')).toEqual(remainingRows(safeDb, 'edges'));

        // eslint-disable-next-line no-console
        console.info(
          `[measured] deleteOrphanEdges NOT-IN trap: NOT EXISTS=${safeMs.toFixed(3)}ms NOT IN=${dangerousMs.toFixed(3)}ms ` +
            `ratio=${(dangerousMs / Math.max(safeMs, 0.001)).toFixed(1)}x slower`,
        );
        // Generous margin (not the literal measured ~340x on the full
        // 110k-row fixture) -- proves the trap is real without making this
        // small-fixture test flaky.
        expect(dangerousMs).toBeGreaterThan(safeMs * 5);
      } finally {
        safeStore.close();
        dangerousStore.close();
      }
    },
  );
});

import { describe, expect, it, vi } from 'vitest';

import { EMPTY_PROGRESS } from '../sync/contract/materializerProgress.js';

import { SqliteConnectionsStore } from './snapshot.js';

// CI query-plan lint — the third guardrail layer for the 2026-08-16
// "connections reconcile child hangs forever" incident (see sqlBudget.ts's
// header and src/connections/snapshot.replaceScopeRows.perf.test.ts for the
// full forensics). Layers 1 (sqlBudget.ts) and 2 (phaseBudget.ts) detect a
// pathological statement/phase AT RUNTIME, in production, after it has
// already started costing wall time. This layer catches the SAME bug class
// in CI, before it ships: it opens a REAL schema instance (the store's own
// DDL — nothing hand-copied here can drift from production), seeds it with
// enough rows that SQLite's cost-based planner behaves the way it would at
// real vault scale, runs EXPLAIN QUERY PLAN over a REGISTRY of statements
// this store actually issues on hot paths, and fails the build on any
// unexpected `SCAN <big-table>` — a full table scan where an index seek
// should be possible.
//
// WHY TRIGGERS ARE INCLUDED: the #378 incident's root cause was NOT in a
// statement snapshot.ts's own code prepares — it was inside
// `trg_edges_index_au` / `trg_edges_index_ad`, SQL bodies the schema DDL
// hands to SQLite and that fire implicitly on every `edges` write/delete.
// A plan-lint that only checked application-authored statements would have
// missed the exact statement that caused a day-long incident. This suite
// extracts trigger bodies live from `sqlite_master` (never hand-copied) and
// EXPLAINs the embedded statements — see `explainTriggerStatements` below
// for the OLD./NEW. substitution technique.
//
// REGISTERING A NEW HOT STATEMENT: add an entry to HOT_STATEMENTS below,
// with an accurate `sourceRef` (file:line — best-effort, drifts as the file
// changes; keep it close, exact line numbers are not asserted) and, if the
// statement's own target table is unavoidably scanned by design (e.g. a
// bulk DELETE with no equality predicate on the table itself), list that
// table in `allowScanTables` — everything else in LARGE_TABLES must resolve
// to a SEARCH, never a SCAN.

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

// ---------------------------------------------------------------------------
// Large-table set. Any `SCAN <table>` for one of these in a hot statement's
// plan (and not explicitly allow-listed for that statement) fails the lint.
// Adapted from the task's "edges, edges_index, nodes, events, resolver
// cache, projection accumulator rows" to this store's ACTUAL schema (there
// is no `events` table in snapshot.ts's own db — the event log lives in a
// separate store) — everything else maps directly.
// ---------------------------------------------------------------------------
const LARGE_TABLES = [
  'nodes',
  'edges',
  'edges_index',
  'connections_scope_nodes',
  'connections_scope_edges',
  'connections_resolver_cache',
  'connections_projection_url_accumulator',
  'connections_projection_tabsession_accumulator',
  'connections_applied_intervals',
] as const;

type LargeTable = (typeof LARGE_TABLES)[number];

interface HotStatementLiteral {
  readonly kind: 'literal';
  readonly id: string;
  readonly sourceRef: string;
  readonly sql: string;
  /** Tables this statement is EXPECTED to scan (its own DELETE/UPDATE
   *  target when there is no equality predicate on that table itself —
   *  scanning the statement's own target is unavoidable and not the
   *  incident's bug shape). Every other LARGE_TABLES entry must be a
   *  SEARCH, never a SCAN. */
  readonly allowScanTables?: readonly LargeTable[];
}

interface HotStatementTrigger {
  readonly kind: 'trigger';
  readonly id: string;
  readonly sourceRef: string;
  readonly triggerName: string;
  readonly allowScanTables?: readonly LargeTable[];
}

type HotStatement = HotStatementLiteral | HotStatementTrigger;

// ---------------------------------------------------------------------------
// THE REGISTRY. ~15 statements: the #378 incident statement + the two
// triggers that actually caused it, replaceScopeRows' other delete-path
// statements (same neighborhood, same bug shape), the resolver-cache
// read/write, the resolver subgraph traversal reads, and the projection
// accumulator upserts. Each `sql` is copied verbatim from its call site —
// keep it in sync when the call site changes (the trigger entries do NOT
// need this: they are re-extracted from the live schema on every run, so
// they can never silently drift from production).
// ---------------------------------------------------------------------------
const HOT_STATEMENTS: readonly HotStatement[] = [
  // --- The #378 incident statement itself -----------------------------
  {
    kind: 'literal',
    id: 'replaceScopeRows.deleteOrphanEdges',
    sourceRef: 'src/connections/snapshot.ts:~7097 (SqliteConnectionsStore#replaceScopeRows)',
    sql: `DELETE FROM edges
         WHERE EXISTS (
           SELECT 1
           FROM temp_replace_edges t
           WHERE t.edge_src = edges.src AND t.edge_dst = edges.dst
         )
           AND NOT EXISTS (
             SELECT 1
             FROM connections_scope_edges c
             WHERE c.edge_src = edges.src AND c.edge_dst = edges.dst
           )`,
    // `edges` itself has no usable equality predicate here (the EXISTS
    // subqueries are correlated on src/dst, not the input to a seek) — a
    // DELETE FROM edges WHERE ... always visits every `edges` row once,
    // O(edges), which is the accepted cost. The regression this guards is
    // the CORRELATED lookups going O(edges * table) instead of O(edges).
    allowScanTables: ['edges'],
  },
  // --- The two triggers that actually caused the incident -------------
  {
    kind: 'trigger',
    id: 'trg_edges_index_au (DELETE half)',
    sourceRef: 'src/connections/snapshot.ts:~5335 (trg_edges_index_au)',
    triggerName: 'trg_edges_index_au',
    // No allowScanTables: this fires once PER ROW touched on `edges` — any
    // scan here is O(edges_touched * edges_index_size), the exact incident.
  },
  {
    kind: 'trigger',
    id: 'trg_edges_index_ad',
    sourceRef: 'src/connections/snapshot.ts:~5341 (trg_edges_index_ad)',
    triggerName: 'trg_edges_index_ad',
  },
  {
    kind: 'trigger',
    id: 'trg_edges_index_ai',
    sourceRef: 'src/connections/snapshot.ts:~5330 (trg_edges_index_ai)',
    triggerName: 'trg_edges_index_ai',
  },
  // --- replaceScopeRows' other delete-path statements (same neighborhood) --
  {
    kind: 'literal',
    id: 'replaceScopeRows.deleteScopeEdges',
    sourceRef: 'src/connections/snapshot.ts:~7072 (SqliteConnectionsStore#replaceScopeRows)',
    sql: `DELETE FROM connections_scope_edges
         WHERE EXISTS (
           SELECT 1
           FROM temp_replace_scopes s
           WHERE s.scope_kind = connections_scope_edges.scope_kind
             AND s.scope_id = connections_scope_edges.scope_id
         )`,
    allowScanTables: ['connections_scope_edges'],
  },
  {
    kind: 'literal',
    id: 'replaceScopeRows.deleteOrphanNodes',
    sourceRef: 'src/connections/snapshot.ts:~7083 (SqliteConnectionsStore#replaceScopeRows)',
    sql: `DELETE FROM nodes
         WHERE id IN (SELECT node_id FROM temp_replace_nodes)
           AND NOT EXISTS (
             SELECT 1
             FROM connections_scope_nodes c
             WHERE c.node_id = nodes.id
           )`,
    allowScanTables: ['nodes'],
  },
  {
    kind: 'literal',
    id: 'replaceScopeRows.deleteScopeNodes',
    sourceRef: 'src/connections/snapshot.ts:~7061 (SqliteConnectionsStore#replaceScopeRows)',
    sql: `DELETE FROM connections_scope_nodes
         WHERE EXISTS (
           SELECT 1
           FROM temp_replace_scopes s
           WHERE s.scope_kind = connections_scope_nodes.scope_kind
             AND s.scope_id = connections_scope_nodes.scope_id
         )`,
    allowScanTables: ['connections_scope_nodes'],
  },
  // --- Resolver-cache read/write (D3, on the served-resolve hot path) -----
  {
    kind: 'literal',
    id: 'cacheResolverResult.upsert',
    sourceRef: 'src/connections/snapshot.ts:~6206 (SqliteConnectionsStore#cacheResolverResult)',
    sql: `INSERT INTO connections_resolver_cache
          (visit_id, snapshot_revision, result_json, computed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(visit_id, snapshot_revision) DO UPDATE SET
           result_json = excluded.result_json,
           computed_at = excluded.computed_at`,
  },
  {
    kind: 'literal',
    id: 'getCachedResolverResult.select',
    sourceRef: 'src/connections/snapshot.ts:~6247 (SqliteConnectionsStore#getCachedResolverResult)',
    sql: `SELECT result_json
           FROM connections_resolver_cache
           WHERE visit_id = ? AND snapshot_revision = ?`,
  },
  // --- Resolver subgraph traversal reads (every BFS hop of every resolve) --
  {
    kind: 'literal',
    id: 'readNodesByIds.select',
    sourceRef: 'src/connections/snapshot.ts:~5717 (SqliteConnectionsStore##readNodesByIds)',
    sql: `SELECT data FROM nodes WHERE id IN (?,?,?,?,?,?,?,?)`,
  },
  {
    kind: 'literal',
    id: 'readIncidentEdgesForNodes.select',
    sourceRef:
      'src/connections/snapshot.ts:~5749 (SqliteConnectionsStore##readIncidentEdgesForNodes)',
    sql: `SELECT data FROM edges WHERE src IN (?,?,?,?,?,?,?,?) OR dst IN (?,?,?,?,?,?,?,?)`,
  },
  {
    kind: 'literal',
    id: 'readIncidentEdgeDegrees.select',
    sourceRef:
      'src/connections/snapshot.ts:~5784 (SqliteConnectionsStore##readIncidentEdgeDegrees)',
    sql: `SELECT node, COUNT(*) AS cnt FROM (
             SELECT src AS node FROM edges WHERE src IN (?,?,?,?,?,?,?,?)
             UNION ALL
             SELECT dst AS node FROM edges WHERE dst IN (?,?,?,?,?,?,?,?)
           ) GROUP BY node`,
  },
  {
    kind: 'literal',
    id: 'readEdgeInner.edgesIndexLookup',
    sourceRef: 'src/connections/snapshot.ts:~8200 (SqliteConnectionsStore##readEdgeInner)',
    sql: `SELECT src, dst FROM edges_index WHERE edge_id = ?`,
  },
  // --- Projection accumulator upserts (F4 blob diet, per-dirty-key, every drain) --
  {
    kind: 'literal',
    id: 'persistProjectionAccumulatorWrite.upsertUrlRow',
    sourceRef:
      'src/connections/snapshot.ts:~7782 (SqliteConnectionsStore##persistProjectionAccumulatorWrite)',
    sql: `INSERT INTO connections_projection_url_accumulator (canonical_url, record_json, cursor_json)
       VALUES (?, ?, ?)
       ON CONFLICT(canonical_url) DO UPDATE SET
         record_json = excluded.record_json, cursor_json = excluded.cursor_json`,
  },
  {
    kind: 'literal',
    id: 'persistProjectionAccumulatorWrite.upsertTabRow',
    sourceRef:
      'src/connections/snapshot.ts:~7803 (SqliteConnectionsStore##persistProjectionAccumulatorWrite)',
    sql: `INSERT INTO connections_projection_tabsession_accumulator (tab_session_id, record_json)
       VALUES (?, ?)
       ON CONFLICT(tab_session_id) DO UPDATE SET record_json = excluded.record_json`,
  },
  // --- Materializer progress read (every drain start) ---------------------
  {
    kind: 'literal',
    id: 'readMaterializerProgress.appliedIntervals',
    sourceRef:
      'src/connections/snapshot.ts:~7867 (SqliteConnectionsStore#readMaterializerProgress)',
    sql: `SELECT replica_id, start_seq, end_seq
         FROM connections_applied_intervals
         WHERE materializer_name = ?
         ORDER BY replica_id, start_seq, end_seq`,
  },
];

// ---------------------------------------------------------------------------
// bun:sqlite handle shape used by the helpers below — same duck-typed
// pattern as sqlBudget.ts / snapshot.ts's own local SqliteDatabase interface.
// ---------------------------------------------------------------------------
interface LintDb {
  readonly exec: (sql: string) => unknown;
  readonly query: (sql: string) => {
    readonly get: (...params: readonly unknown[]) => unknown;
    readonly all: (...params: readonly unknown[]) => readonly unknown[];
    readonly run: (...params: readonly unknown[]) => unknown;
    readonly finalize?: () => void;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Grabs the store's live bun:sqlite handle by intercepting its first
 *  `.query()` call — same technique as
 *  snapshot.replaceScopeRows.perf.test.ts's `captureDb`. Duplicated locally
 *  (not extracted to a shared test-util) so this suite has zero non-test
 *  dependencies beyond the store itself. */
const captureDb = async (run: () => Promise<void>): Promise<LintDb> => {
  const { Database } = (await import('bun:sqlite')) as typeof import('bun:sqlite');
  const originalQuery = Database.prototype.query;
  let captured: InstanceType<typeof Database> | null = null;
  const spy = vi.spyOn(Database.prototype, 'query').mockImplementation(function capture(
    this: InstanceType<typeof Database>,
    sql: string,
  ) {
    // Capturing the spied receiver instance is the whole point of this
    // hook — there is no other way to get at the store's live bun:sqlite
    // handle.
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

const explainRowDetail = (row: unknown): string => {
  if (!isRecord(row)) return String(row);
  const detail = row['detail'];
  return typeof detail === 'string' ? detail : JSON.stringify(row);
};

/** EXPLAIN QUERY PLAN for a literal (already-parameterized) statement.
 *  Unbound `?` placeholders plan as NULL — sufficient for SCAN vs SEARCH
 *  shape (see this PR's spike measurements in the PR description / landing
 *  note; bun:sqlite accepts EXPLAIN QUERY PLAN on a parameterized statement
 *  with no bound values). */
const explainLiteral = (db: LintDb, sql: string): readonly string[] => {
  const stmt = db.query(`EXPLAIN QUERY PLAN ${sql}`);
  const rows = stmt.all();
  // Finalize immediately — an unfinalized prepared statement holds SQLite's
  // "database table is locked" (SQLITE_LOCKED) guard against later schema
  // changes on the same connection (this suite's regression test DROPs an
  // index mid-run), even though the statement already finished executing.
  stmt.finalize?.();
  return rows.map(explainRowDetail);
};

/** Extracts a trigger's body from `sqlite_master` (never hand-copied — this
 *  is what makes the trigger entries self-updating), splits it into its
 *  individual statements, and substitutes every `OLD.<col>` / `NEW.<col>`
 *  reference with a literal placeholder string so each statement can be
 *  EXPLAINed standalone (SQLite's trigger pseudo-tables only exist inside a
 *  live trigger firing, not for a bare EXPLAIN QUERY PLAN). The substituted
 *  literal's actual value is irrelevant to the plan shape — EXPLAIN QUERY
 *  PLAN never evaluates row content, only table/index structure and (post-
 *  ANALYZE) column statistics. Naive `;`-split is safe here because none of
 *  this schema's trigger bodies contain a semicolon inside a string literal
 *  or a nested BEGIN/END. */
const explainTriggerStatements = (db: LintDb, triggerName: string): readonly string[] => {
  const sqliteMasterStmt = db.query('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?');
  const row = sqliteMasterStmt.get('trigger', triggerName);
  sqliteMasterStmt.finalize?.();
  if (!isRecord(row) || typeof row['sql'] !== 'string') {
    throw new Error(`queryPlanLint: trigger not found in sqlite_master: ${triggerName}`);
  }
  const triggerSql = row['sql'];
  const beginIndex = triggerSql.search(/\bBEGIN\b/iu);
  const endIndex = triggerSql.search(/\bEND\s*;?\s*$/iu);
  if (beginIndex === -1 || endIndex === -1 || endIndex <= beginIndex) {
    throw new Error(`queryPlanLint: could not parse trigger body for ${triggerName}`);
  }
  const body = triggerSql.slice(beginIndex + 'BEGIN'.length, endIndex);
  const statements = body
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => statement.replace(/\b(OLD|NEW)\.(\w+)/giu, "'query-plan-lint-literal'"));
  if (statements.length === 0) {
    throw new Error(`queryPlanLint: trigger body for ${triggerName} yielded no statements`);
  }
  return statements.flatMap((statement) => explainLiteral(db, statement));
};

/** Every large-table name that shows up as `SCAN <table>` in `planDetails`
 *  and is not in `allowScanTables`. Word-boundary matched so `edges` never
 *  false-positives against `edges_index` (or vice versa). Empty result =
 *  lint passes for this statement. */
const unexpectedScans = (
  planDetails: readonly string[],
  allowScanTables: readonly LargeTable[],
): readonly LargeTable[] =>
  LARGE_TABLES.filter((table) => {
    if (allowScanTables.includes(table)) return false;
    const scanPattern = new RegExp(`\\bSCAN ${table}\\b`, 'u');
    return planDetails.some((detail) => scanPattern.test(detail));
  });

const explainHotStatement = (db: LintDb, statement: HotStatement): readonly string[] =>
  statement.kind === 'literal'
    ? explainLiteral(db, statement.sql)
    : explainTriggerStatements(db, statement.triggerName);

// ---------------------------------------------------------------------------
// Seeding — "a few thousand rows per big table" so the planner's cost
// estimates (post-ANALYZE) reflect real-vault shape rather than a
// zero-row/one-row toy schema, where SQLite's planner can pick a SCAN
// simply because it's cheap enough not to matter at that size (which is
// EXACTLY how a missing-index regression like #378 could sail through a
// naive lint that seeds one row per table).
// ---------------------------------------------------------------------------
const ROWS_PER_BIG_TABLE = 4000;

const seedForPlanLint = (db: LintDb): void => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const insertNode = db.query('INSERT INTO nodes (id, data) VALUES (?, ?)');
    const insertEdge = db.query('INSERT INTO edges (src, dst, data) VALUES (?, ?, ?)');
    const insertScopeNode = db.query(
      'INSERT INTO connections_scope_nodes (scope_kind, scope_id, node_id) VALUES (?, ?, ?)',
    );
    const insertScopeEdge = db.query(
      'INSERT INTO connections_scope_edges (scope_kind, scope_id, edge_src, edge_dst) VALUES (?, ?, ?, ?)',
    );
    const insertResolverCache = db.query(
      `INSERT INTO connections_resolver_cache (visit_id, snapshot_revision, result_json, computed_at)
       VALUES (?, ?, ?, ?)`,
    );
    const insertUrlAccumulator = db.query(
      'INSERT INTO connections_projection_url_accumulator (canonical_url, record_json, cursor_json) VALUES (?, ?, NULL)',
    );
    const insertTabAccumulator = db.query(
      'INSERT INTO connections_projection_tabsession_accumulator (tab_session_id, record_json) VALUES (?, ?)',
    );
    const insertAppliedInterval = db.query(
      `INSERT INTO connections_applied_intervals (materializer_name, replica_id, start_seq, end_seq)
       VALUES (?, ?, ?, ?)`,
    );

    const nodeIds: string[] = [];
    for (let i = 0; i < ROWS_PER_BIG_TABLE; i += 1) {
      const id = `timeline-visit:https://plan-lint.test/${String(i)}`;
      nodeIds.push(id);
      insertNode.run(id, '{}');
    }
    // Roughly half the nodes are in-scope — gives the deleteOrphanNodes-
    // style NOT EXISTS subqueries real (non-degenerate) selectivity, same
    // as the deleteOrphanEdges perf test's "half deleted" shape.
    for (let i = 0; i < nodeIds.length; i += 1) {
      if (i % 2 === 0) insertScopeNode.run('url', `scope-${String(i)}`, nodeIds[i]);
    }

    for (let i = 0; i < ROWS_PER_BIG_TABLE; i += 1) {
      const src = nodeIds[i]!;
      const dst = nodeIds[(i + 1) % nodeIds.length]!;
      const edgeId = `closest_visit:${src}->${dst}`;
      // Valid JSON array with id/kind so trg_edges_index_a{i,u,d} (which
      // extract $.id / $.kind via json_each) succeed exactly as they would
      // against a real edges bucket.
      insertEdge.run(src, dst, JSON.stringify([{ id: edgeId, kind: 'closest_visit' }]));
      if (i % 2 === 0) insertScopeEdge.run('url', `scope-${String(i)}`, src, dst);
    }

    for (let i = 0; i < ROWS_PER_BIG_TABLE; i += 1) {
      insertResolverCache.run(
        `visit-${String(i)}`,
        `revision-${String(i % 10)}`,
        '{"resolved":true}',
        '2026-08-16T00:00:00.000Z',
      );
      insertUrlAccumulator.run(`https://plan-lint.test/url/${String(i)}`, '{}');
      insertTabAccumulator.run(`tab-session-${String(i)}`, '{}');
    }

    // Applied-interval rows are naturally small in production (one row per
    // replica per contiguous seq range) — a few hundred across several
    // replicas is representative; thousands would misrepresent real shape.
    for (let replica = 0; replica < 20; replica += 1) {
      for (let chunk = 0; chunk < 25; chunk += 1) {
        insertAppliedInterval.run(
          'connections',
          `replica-${String(replica)}`,
          chunk * 100,
          chunk * 100 + 99,
        );
      }
    }

    db.exec('COMMIT');
    // Finalize every seeding statement — see explainLiteral's comment on
    // why an unfinalized prepared statement blocks later DDL (this suite's
    // regression test DROPs an index mid-run) on the same connection.
    for (const stmt of [
      insertNode,
      insertEdge,
      insertScopeNode,
      insertScopeEdge,
      insertResolverCache,
      insertUrlAccumulator,
      insertTabAccumulator,
      insertAppliedInterval,
    ]) {
      stmt.finalize?.();
    }
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  // ANALYZE so the planner's cost estimates reflect the seeded row counts
  // and value distributions, not SQLite's schema-only heuristics — the
  // difference matters for OR/IN-list plans (readIncidentEdgesForNodes)
  // where the planner chooses between an index-merge SEARCH and a SCAN
  // based on estimated selectivity.
  db.exec('ANALYZE');
};

/** Opens a store on `:memory:`, runs its own schema-init DDL + one
 *  `replaceScopeRows({})` no-op (creates the TEMP tables replaceScopeRows'
 *  statements reference — they only exist after that call, never in the
 *  base schema block), seeds bulk rows, and returns the raw handle. */
const buildSeededStore = async (): Promise<{
  readonly store: SqliteConnectionsStore;
  readonly db: LintDb;
}> => {
  const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
  const db = await captureDb(async () => {
    await store.replaceScopeRows({
      scopes: [],
      nodes: [],
      edges: [],
      progress: {
        ...EMPTY_PROGRESS('connections', 'connections@query-plan-lint'),
        snapshotRevisionId: 'seed',
      },
    });
  });
  seedForPlanLint(db);
  return { store, db };
};

describe('queryPlanLint — hot statement registry (2026-08-16 SCAN tripwire)', () => {
  sqliteIt(
    `every registered hot statement resolves to a SEARCH, never a SCAN, of a large table (unless explicitly allow-listed) — ${String(HOT_STATEMENTS.length)} statements checked`,
    async () => {
      const { store, db } = await buildSeededStore();
      try {
        const failures: string[] = [];
        for (const statement of HOT_STATEMENTS) {
          const planDetails = explainHotStatement(db, statement);
          const violations = unexpectedScans(planDetails, statement.allowScanTables ?? []);
          if (violations.length > 0) {
            failures.push(
              `${statement.id} (${statement.sourceRef}): unexpected SCAN of [${violations.join(', ')}]\n  plan: ${planDetails.join(' | ')}`,
            );
          }
        }
        expect(failures.join('\n\n')).toBe('');
      } finally {
        store.close();
      }
    },
  );

  sqliteIt('the registry is non-trivial (guards against an accidentally-emptied suite)', () => {
    expect(HOT_STATEMENTS.length).toBeGreaterThanOrEqual(10);
  });
});

describe('queryPlanLint — proves it catches the #378 bug class', () => {
  sqliteIt(
    'trips when idx_edges_index_src_dst is dropped (the exact #378 regression)',
    async () => {
      const { store, db } = await buildSeededStore();
      try {
        // Sanity: with the index present (production schema, as of this
        // PR), the trigger statements are clean.
        const beforeAu = unexpectedScans(explainTriggerStatements(db, 'trg_edges_index_au'), []);
        const beforeAd = unexpectedScans(explainTriggerStatements(db, 'trg_edges_index_ad'), []);
        expect(beforeAu).toEqual([]);
        expect(beforeAd).toEqual([]);

        // Simulate the pre-#378 schema.
        db.exec('DROP INDEX IF EXISTS idx_edges_index_src_dst');
        db.exec('ANALYZE');

        const afterAu = unexpectedScans(explainTriggerStatements(db, 'trg_edges_index_au'), []);
        const afterAd = unexpectedScans(explainTriggerStatements(db, 'trg_edges_index_ad'), []);
        // THE assertion this whole layer exists for: dropping the fix's
        // index reintroduces a full SCAN of edges_index in the trigger that
        // fires per row touched on `edges` — this is precisely what turned
        // one deleteOrphanEdges call into a 30-minute hang.
        expect(afterAu).toEqual(['edges_index']);
        expect(afterAd).toEqual(['edges_index']);
      } finally {
        store.close();
      }
    },
  );
});

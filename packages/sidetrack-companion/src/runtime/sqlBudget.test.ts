import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  budgetedStatement,
  resetSqlBudgetDiagnostics,
  sqlBudgetDiagnostics,
  sqlBudgeted,
  type SqlBudgetDb,
} from './sqlBudget.js';

// bun:sqlite is only resolvable under the bun runtime — this suite (like the
// rest of the connections-store tests) skips under any other test runner.
const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

const ENV_KEYS = ['SIDETRACK_SQL_BUDGET_MS', 'SIDETRACK_SQL_BUDGET_HARD_MS'] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  resetSqlBudgetDiagnostics();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetSqlBudgetDiagnostics();
  vi.restoreAllMocks();
});

/** A statement that reliably costs tens-to-hundreds of ms regardless of
 *  machine load, without depending on any real table/index — a bounded
 *  RECURSIVE CTE walk. Calibrated (see this PR's spike measurements) at
 *  ~1M steps -> ~140ms on a normal dev machine; generous margin over any
 *  low test budget (5-50ms) even on a loaded CI box. */
const SLOW_STATEMENT_SQL =
  'WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 1000000) SELECT COUNT(*) AS n FROM cnt';

describe('sqlBudget — wrapper overhead', () => {
  sqliteIt('adds well under 2µs/call on the fast (non-slow) path', async () => {
    const { Database } = await import('bun:sqlite');
    const db = new Database(':memory:') as unknown as SqlBudgetDb;
    // Budget set high so the trivial SELECT below never takes the slow path
    // during this measurement — we are measuring the FAST path only.
    process.env['SIDETRACK_SQL_BUDGET_MS'] = '60000';

    const rawStmt = (db as unknown as { query: (sql: string) => { get: () => unknown } }).query(
      'SELECT 1 AS x',
    );
    const wrappedStmt = budgetedStatement(db, 'sqlBudget.test.overhead', 'SELECT 1 AS x');

    const WARMUP = 50_000;
    const ITERATIONS = 300_000;
    for (let i = 0; i < WARMUP; i += 1) rawStmt.get();
    for (let i = 0; i < WARMUP; i += 1) wrappedStmt.get();

    const rawStartedAtMs = performance.now();
    for (let i = 0; i < ITERATIONS; i += 1) rawStmt.get();
    const rawMs = performance.now() - rawStartedAtMs;

    const wrappedStartedAtMs = performance.now();
    for (let i = 0; i < ITERATIONS; i += 1) wrappedStmt.get();
    const wrappedMs = performance.now() - wrappedStartedAtMs;

    const overheadNsPerCall = ((wrappedMs - rawMs) * 1e6) / ITERATIONS;
    // Measured on dev hardware: ~40-70ns/call. 2000ns (2µs) leaves a wide
    // margin for a loaded/slower machine while still catching a real
    // regression (e.g. an accidental allocation or async hop added to the
    // hot path).
    expect(overheadNsPerCall).toBeLessThan(2000);
  });
});

describe('sqlBudget — slow-statement detection', () => {
  sqliteIt('logs [sql.slow] once a statement exceeds SIDETRACK_SQL_BUDGET_MS', async () => {
    const { Database } = await import('bun:sqlite');
    const db = new Database(':memory:') as unknown as SqlBudgetDb;
    process.env['SIDETRACK_SQL_BUDGET_MS'] = '5';
    process.env['SIDETRACK_SQL_BUDGET_HARD_MS'] = '600000'; // effectively disabled

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stmt = budgetedStatement(db, 'sqlBudget.test.slow', SLOW_STATEMENT_SQL);
    stmt.get();

    const slowLines = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith('[sql.slow]'));
    expect(slowLines).toHaveLength(1);
    expect(slowLines[0]).toContain('site=sqlBudget.test.slow');
    expect(slowLines[0]).toMatch(/ms=\d+/u);
    expect(slowLines[0]).toContain(`sql=${SLOW_STATEMENT_SQL.slice(0, 120)}`);

    const diag = sqlBudgetDiagnostics().find((d) => d.site === 'sqlBudget.test.slow');
    expect(diag?.slowCount).toBe(1);
    expect(diag?.hardCount).toBe(0);

    // No EXPLAIN line — the hard budget was never crossed.
    expect(warn.mock.calls.some((call) => String(call[0]).startsWith('[sql.slow.explain]'))).toBe(
      false,
    );
  });

  sqliteIt(
    'logs [sql.slow.explain] with an EXPLAIN QUERY PLAN once SIDETRACK_SQL_BUDGET_HARD_MS is exceeded',
    async () => {
      const { Database } = await import('bun:sqlite');
      const db = new Database(':memory:') as unknown as SqlBudgetDb;
      process.env['SIDETRACK_SQL_BUDGET_MS'] = '1';
      process.env['SIDETRACK_SQL_BUDGET_HARD_MS'] = '10';

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const stmt = budgetedStatement(db, 'sqlBudget.test.hard', SLOW_STATEMENT_SQL);
      stmt.get();

      const explainLines = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith('[sql.slow.explain]'));
      expect(explainLines).toHaveLength(1);
      expect(explainLines[0]).toContain('site=sqlBudget.test.hard');
      expect(explainLines[0]).toContain('plan=');

      const diag = sqlBudgetDiagnostics().find((d) => d.site === 'sqlBudget.test.hard');
      expect(diag?.hardCount).toBe(1);
    },
  );

  sqliteIt('throttles repeated [sql.slow] logs for the same site but keeps counting', async () => {
    const { Database } = await import('bun:sqlite');
    const db = new Database(':memory:') as unknown as SqlBudgetDb;
    process.env['SIDETRACK_SQL_BUDGET_MS'] = '5';
    process.env['SIDETRACK_SQL_BUDGET_HARD_MS'] = '600000';

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stmt = budgetedStatement(db, 'sqlBudget.test.throttle', SLOW_STATEMENT_SQL);
    stmt.get();
    stmt.get();
    stmt.get();

    const slowLines = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith('[sql.slow]') && line.includes('sqlBudget.test.throttle'));
    // Only the first breach is logged within the throttle window — a
    // statement stuck in a tight loop (the incident's own shape: a trigger
    // firing per row) cannot flood the log.
    expect(slowLines).toHaveLength(1);

    // But every breach is still counted — the counter is not throttled.
    const diag = sqlBudgetDiagnostics().find((d) => d.site === 'sqlBudget.test.throttle');
    expect(diag?.slowCount).toBe(3);
  });

  sqliteIt('does not log or count a statement under budget', async () => {
    const { Database } = await import('bun:sqlite');
    const db = new Database(':memory:') as unknown as SqlBudgetDb;
    process.env['SIDETRACK_SQL_BUDGET_MS'] = '60000';

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stmt = budgetedStatement(db, 'sqlBudget.test.fast', 'SELECT 1 AS x');
    stmt.get();

    expect(warn).not.toHaveBeenCalled();
    expect(sqlBudgetDiagnostics().find((d) => d.site === 'sqlBudget.test.fast')).toBeUndefined();
  });

  sqliteIt('sqlBudgeted() times an arbitrary callback the same way', async () => {
    const { Database } = await import('bun:sqlite');
    const db = new Database(':memory:') as unknown as SqlBudgetDb;
    process.env['SIDETRACK_SQL_BUDGET_MS'] = '5';
    process.env['SIDETRACK_SQL_BUDGET_HARD_MS'] = '600000';

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = sqlBudgeted(db, 'sqlBudget.test.callback', SLOW_STATEMENT_SQL, () =>
      db.query(SLOW_STATEMENT_SQL).get(),
    );
    expect(result).toBeDefined();
    expect(warn.mock.calls.some((call) => String(call[0]).startsWith('[sql.slow]'))).toBe(true);
  });
});

// Extension OPFS local recall — SQLite WASM + FTS5 store.
//
// Runs inside the extension's background service worker context. Uses
// the SQLite WASM build's OPFS-SAH-Pool VFS (the only OPFS backend
// that works in SW contexts without a dedicated worker). Lazily
// initialized on first call so SW cold-start stays fast.
//
// The store is intentionally tiny: title + host + URL slug per visit.
// No body extraction, no embeddings — that's the companion's job.
// The product role here is "recall ground floor when companion is
// down": HN items, Google SERPs, brief visits still findable.

import type { LocalCandidate, LocalRecallStore } from './types.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS visits (
    entity_id     TEXT PRIMARY KEY,
    canonical_url TEXT NOT NULL,
    title         TEXT,
    host          TEXT,
    url_tokens    TEXT,
    first_seen_at INTEGER,
    last_seen_at  INTEGER
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS visits_fts USING fts5(
    title, url_tokens, host,
    content='visits', content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER IF NOT EXISTS visits_ai AFTER INSERT ON visits BEGIN
    INSERT INTO visits_fts(rowid, title, url_tokens, host)
    VALUES (new.rowid, new.title, new.url_tokens, new.host);
  END;
  CREATE TRIGGER IF NOT EXISTS visits_au AFTER UPDATE ON visits BEGIN
    INSERT INTO visits_fts(visits_fts, rowid, title, url_tokens, host)
    VALUES('delete', old.rowid, old.title, old.url_tokens, old.host);
    INSERT INTO visits_fts(rowid, title, url_tokens, host)
    VALUES (new.rowid, new.title, new.url_tokens, new.host);
  END;
`;

const slugTokensOf = (url: string): string => {
  try {
    return new URL(url).pathname.replace(/[/_-]+/g, ' ').trim();
  } catch {
    return url;
  }
};
const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};
const entityIdFor = (url: string): string => {
  // 24-char hex prefix is enough collision-resistance for one user.
  // Sync XOR-fold from string char codes — avoids the async crypto API
  // (the SW handler can't always await async work cleanly mid-call).
  let h1 = 0x811c9dc5;
  let h2 = 0xdeadbeef;
  for (let i = 0; i < url.length; i += 1) {
    const c = url.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  return (
    'u:' +
    (h1 >>> 0).toString(16).padStart(8, '0') +
    (h2 >>> 0).toString(16).padStart(8, '0')
  );
};

const escapeFts = (q: string): string => {
  const tokens = q.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
};

interface SqliteDb {
  exec(sql: string): unknown;
  prepare(sql: string): {
    bind(...params: unknown[]): unknown;
    step(): boolean;
    get(): unknown;
    getAsObject(): Record<string, unknown>;
    free(): void;
  };
  // sqlite-wasm exposes ONLY oo1 API: db.exec(...) for one-shot SQL
  // with optional bind + callback. We use it directly below.
}

class OpfsSqliteStore implements LocalRecallStore {
  private dbPromise: Promise<unknown> | null = null;
  private oo1: unknown = null;

  private async getDb(): Promise<unknown> {
    if (this.dbPromise === null) {
      // Capture the in-flight promise so we can clear `dbPromise` on
      // failure — without this, a transient OPFS init error (often
      // happens during SW cold-start when storage handles are slow to
      // arrive) would cache a rejected promise forever and brick the
      // local-recall fallback for the SW's lifetime.
      const inFlight = (async () => {
        // Dynamic import keeps the WASM payload off SW cold start.
        const sqlite3InitModule = (await import(
          '@sqlite.org/sqlite-wasm'
        )) as unknown as { default: () => Promise<unknown> };
        const sqlite3 = (await sqlite3InitModule.default()) as {
          oo1: {
            OpfsDb?: new (path: string) => unknown;
            DB: new (path: string, flags?: string) => unknown;
          };
          installOpfsSAHPoolVfs?: (opts?: Record<string, unknown>) => Promise<unknown>;
        };
        // SAH-Pool is the only OPFS variant that works in SW contexts.
        let db: unknown;
        if (typeof sqlite3.installOpfsSAHPoolVfs === 'function') {
          const pool = (await sqlite3.installOpfsSAHPoolVfs({
            name: 'sidetrack-local-recall',
            initialCapacity: 8,
          })) as { OpfsSAHPoolDb: new (path: string) => unknown };
          db = new pool.OpfsSAHPoolDb('/recall.sqlite');
        } else if (sqlite3.oo1.OpfsDb !== undefined) {
          db = new sqlite3.oo1.OpfsDb('/sidetrack-recall.sqlite');
        } else {
          // No OPFS available → in-memory fallback (lost on SW
          // restart, but better than nothing).
          db = new sqlite3.oo1.DB(':memory:', 'c');
        }
        this.oo1 = db;
        (db as SqliteDb).exec(SCHEMA);
        return db;
      })();
      this.dbPromise = inFlight.catch((err: unknown) => {
        // Reset so the next call retries instead of replaying the
        // rejected promise; rethrow so this awaiter still sees the
        // original failure.
        this.dbPromise = null;
        throw err;
      });
    }
    return this.dbPromise;
  }

  async ready(): Promise<void> {
    await this.getDb();
  }

  async recordVisit(input: {
    readonly canonicalUrl: string;
    readonly title?: string;
    readonly seenAtMs?: number;
  }): Promise<void> {
    const db = (await this.getDb()) as {
      exec: (opts: { sql: string; bind: unknown[] }) => unknown;
    };
    const seen = input.seenAtMs ?? Date.now();
    const id = entityIdFor(input.canonicalUrl);
    const slug = slugTokensOf(input.canonicalUrl);
    const host = hostOf(input.canonicalUrl);
    // Upsert: ON CONFLICT keep first_seen_at, overwrite last_seen_at +
    // title (titles can change after navigation).
    db.exec({
      sql: `
        INSERT INTO visits (entity_id, canonical_url, title, host, url_tokens, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_id) DO UPDATE SET
          title = COALESCE(excluded.title, visits.title),
          last_seen_at = MAX(visits.last_seen_at, excluded.last_seen_at)
      `,
      bind: [id, input.canonicalUrl, input.title ?? null, host, slug, seen, seen],
    });
  }

  async query(input: {
    readonly q: string;
    readonly limit: number;
  }): Promise<readonly LocalCandidate[]> {
    const db = (await this.getDb()) as {
      exec: (opts: {
        sql: string;
        bind: unknown[];
        rowMode: string;
        returnValue: string;
      }) => unknown[];
    };
    const ftsQuery = escapeFts(input.q);
    if (ftsQuery === '""') return [];
    const rows = db.exec({
      sql: `
        SELECT
          visits.entity_id      AS entityId,
          visits.canonical_url  AS canonicalUrl,
          visits.title          AS title,
          visits.host           AS host,
          visits.first_seen_at  AS firstSeenAtMs,
          visits.last_seen_at   AS lastSeenAtMs,
          -bm25(visits_fts, 2.0, 1.0, 0.5) AS bm25
        FROM visits
        JOIN visits_fts ON visits.rowid = visits_fts.rowid
        WHERE visits_fts MATCH ?
        ORDER BY bm25 DESC
        LIMIT ?
      `,
      bind: [ftsQuery, input.limit],
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as readonly Record<string, unknown>[];
    return rows.map(
      (r): LocalCandidate => ({
        entityId: r['entityId'] as string,
        canonicalUrl: r['canonicalUrl'] as string,
        ...(r['title'] === null || r['title'] === undefined ? {} : { title: r['title'] as string }),
        ...(r['host'] === null || r['host'] === undefined ? {} : { host: r['host'] as string }),
        ...(r['firstSeenAtMs'] === null || r['firstSeenAtMs'] === undefined
          ? {}
          : { firstSeenAtMs: r['firstSeenAtMs'] as number }),
        ...(r['lastSeenAtMs'] === null || r['lastSeenAtMs'] === undefined
          ? {}
          : { lastSeenAtMs: r['lastSeenAtMs'] as number }),
        bm25: r['bm25'] as number,
      }),
    );
  }

  async close(): Promise<void> {
    const db = this.oo1 as { close?: () => void } | null;
    if (db !== null && typeof db.close === 'function') {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
    this.dbPromise = null;
    this.oo1 = null;
  }
}

// Singleton — one SW instance, one store. SW idle eviction wipes the
// in-memory handle but the OPFS file persists; `getDb()` reopens on
// next use.
let singleton: OpfsSqliteStore | null = null;

export const localRecallStore = (): LocalRecallStore => {
  if (singleton === null) singleton = new OpfsSqliteStore();
  return singleton;
};

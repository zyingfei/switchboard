import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import { createSearchQueryIndexStore } from './searchQueryIndexStore.js';
import type { AcceptedEvent } from '../sync/causal.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

// dot.seq is scoped PER REPLICA (each replica assigns its own
// sequence numbers independently) — a shared global counter would
// silently misrepresent multi-replica fixtures, so track one counter
// per replicaId.
let seqCounters = new Map<string, number>();
const nextSeq = (replicaId: string): number => {
  const next = (seqCounters.get(replicaId) ?? 0) + 1;
  seqCounters.set(replicaId, next);
  return next;
};

const timelineEvent = (input: {
  readonly replicaId: string;
  readonly eventId: string;
  readonly observedAt: string;
  readonly url: string;
  readonly canonicalUrl?: string;
}): AcceptedEvent => {
  const seq = nextSeq(input.replicaId);
  return {
    clientEventId: `timeline-${input.replicaId}-${String(seq)}`,
    dot: { replicaId: input.replicaId, seq },
    deps: {},
    aggregateId: `browser.timeline.observed:${input.eventId}`,
    type: BROWSER_TIMELINE_OBSERVED,
    payload: {
      eventId: input.eventId,
      observedAt: input.observedAt,
      url: input.url,
      ...(input.canonicalUrl === undefined ? {} : { canonicalUrl: input.canonicalUrl }),
      provider: 'generic',
      transition: 'activated',
      tabSessionId: 'tab-session-1',
      payloadVersion: 1,
    },
    acceptedAtMs: Date.parse(input.observedAt),
  };
};

const irrelevantEvent = (replicaId: string, acceptedAtMs: number): AcceptedEvent => {
  const seq = nextSeq(replicaId);
  return {
    clientEventId: `priv-${replicaId}-${String(seq)}`,
    dot: { replicaId, seq },
    deps: {},
    aggregateId: 'privacy',
    type: 'privacy.gate.flipped',
    payload: { payloadVersion: 1, gate: 'timeline', state: 'open' },
    acceptedAtMs,
  };
};

// Non-search timeline visit — path is neither '/' nor '/search', so
// detectSearchUrl returns null regardless of the `q` param.
const nonSearchEvent = (replicaId: string): AcceptedEvent =>
  timelineEvent({
    replicaId,
    eventId: 'product-1',
    observedAt: '2026-08-16T09:00:00.000Z',
    url: 'https://shop.example.com/products?q=widget',
  });

describe('SearchQueryIndexStore', () => {
  const dirs: string[] = [];
  // Per-replica seq counters are module-level; reset per-test so
  // watermark assertions are test-local.
  beforeEach(() => {
    seqCounters = new Map();
  });
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const tempVault = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), 'search-query-index-'));
    dirs.push(d);
    await mkdir(join(d, '_BAC', 'connections'), { recursive: true });
    return d;
  };

  sqliteIt('extracts a query key from a search-shaped URL and round-trips visitsForQuery', async () => {
    const vault = await tempVault();
    const store = await createSearchQueryIndexStore(vault);
    const events = [
      timelineEvent({
        replicaId: 'replica-a',
        eventId: 'search-1',
        observedAt: '2026-08-16T10:00:00.000Z',
        // Already canonical (scheme+host+path?q=<query>) — production
        // events reach this store post-sanitization
        // (timeline/sanitize.ts strips tracking params like sxsrf
        // before the event is durably appended to the log; this
        // store's visitKey mirrors snapshot.ts Pass 3's
        // `stripFragmentAndTrailingSlash(entry.canonicalUrl ?? entry.url)`,
        // which likewise trusts that upstream normalization rather
        // than re-deriving it).
        url: 'https://www.google.com/search?q=Machine+Learning',
      }),
      nonSearchEvent('replica-a'),
    ];
    const minted = store.ingestMany(events);
    // Only the search event mints a pair.
    expect(minted).toBe(1);
    const rows = store.visitsForQuery('machine learning');
    store.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.visitKey).toBe('https://www.google.com/search?q=Machine+Learning');
    expect(rows[0]?.observedAt).toBe('2026-08-16T10:00:00.000Z');
  });

  sqliteIt('visitsForQuery normalizes the caller-supplied key (whitespace + case)', async () => {
    const vault = await tempVault();
    const store = await createSearchQueryIndexStore(vault);
    store.ingestMany([
      timelineEvent({
        replicaId: 'replica-a',
        eventId: 'search-1',
        observedAt: '2026-08-16T10:00:00.000Z',
        url: 'https://duckduckgo.com/?q=React+Hooks',
      }),
    ]);
    const rows = store.visitsForQuery('  react   hooks  ');
    store.close();
    expect(rows).toHaveLength(1);
  });

  sqliteIt('two search visits sharing a query key join on visitsForQuery', async () => {
    const vault = await tempVault();
    const store = await createSearchQueryIndexStore(vault);
    store.ingestMany([
      timelineEvent({
        replicaId: 'replica-a',
        eventId: 'search-1',
        observedAt: '2026-08-16T10:00:00.000Z',
        url: 'https://www.bing.com/search?q=rust+borrow+checker',
      }),
      timelineEvent({
        replicaId: 'replica-a',
        eventId: 'search-2',
        observedAt: '2026-08-16T11:00:00.000Z',
        url: 'https://www.google.com/search?q=Rust+Borrow+Checker',
      }),
    ]);
    const rows = store.visitsForQuery('rust borrow checker');
    store.close();
    expect(rows.map((r) => r.visitKey).sort()).toEqual([
      'https://www.bing.com/search?q=rust+borrow+checker',
      'https://www.google.com/search?q=Rust+Borrow+Checker',
    ]);
  });

  sqliteIt('ingest is idempotent: re-ingesting the same events does not change stored rows', async () => {
    const vault = await tempVault();
    const store = await createSearchQueryIndexStore(vault);
    const events = [
      timelineEvent({
        replicaId: 'replica-a',
        eventId: 'search-1',
        observedAt: '2026-08-16T10:00:00.000Z',
        url: 'https://www.google.com/search?q=idempotency',
      }),
    ];
    store.ingestMany(events);
    const before = store.visitsForQuery('idempotency');
    const beforeWatermark = store.watermark();
    store.ingestMany(events); // second pass: identical pair, identical observedAt
    store.ingestMany(events); // third pass, for good measure
    const after = store.visitsForQuery('idempotency');
    const afterWatermark = store.watermark();
    store.close();
    expect(after).toEqual(before);
    expect(afterWatermark).toEqual(beforeWatermark);
  });

  sqliteIt('a later re-observation of the same (query, visit) pair advances observedAt monotonically', async () => {
    const vault = await tempVault();
    const store = await createSearchQueryIndexStore(vault);
    store.ingestMany([
      timelineEvent({
        replicaId: 'replica-a',
        eventId: 'search-1',
        observedAt: '2026-08-16T10:00:00.000Z',
        url: 'https://www.google.com/search?q=revisit',
      }),
    ]);
    // Same canonical visit + query, later observation (e.g. transition:updated re-emit).
    store.ingestMany([
      timelineEvent({
        replicaId: 'replica-a',
        eventId: 'search-1',
        observedAt: '2026-08-16T12:00:00.000Z',
        url: 'https://www.google.com/search?q=revisit',
      }),
    ]);
    const rows = store.visitsForQuery('revisit');
    store.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.observedAt).toBe('2026-08-16T12:00:00.000Z');
  });

  sqliteIt('catchUp ingests only events past the watermark', async () => {
    const vault = await tempVault();
    const store = await createSearchQueryIndexStore(vault);
    const events = [
      timelineEvent({
        replicaId: 'replica-a',
        eventId: 'search-1',
        observedAt: '2026-08-16T10:00:00.000Z',
        url: 'https://www.google.com/search?q=alpha',
      }),
      timelineEvent({
        replicaId: 'replica-a',
        eventId: 'search-2',
        observedAt: '2026-08-16T10:05:00.000Z',
        url: 'https://www.google.com/search?q=beta',
      }),
    ];
    store.ingestMany(events.slice(0, 1));
    const added = await store.catchUp(events);
    const rows = store.visitsForQuery('beta');
    store.close();
    expect(added).toBe(1);
    expect(rows).toHaveLength(1);
  });

  sqliteIt('multi-replica watermark independence', async () => {
    const vault = await tempVault();
    const store = await createSearchQueryIndexStore(vault);
    store.ingestMany([
      timelineEvent({
        replicaId: 'replica-a',
        eventId: 'a-1',
        observedAt: '2026-08-16T10:00:00.000Z',
        url: 'https://www.google.com/search?q=a-only',
      }),
      timelineEvent({
        replicaId: 'replica-a',
        eventId: 'a-2',
        observedAt: '2026-08-16T10:01:00.000Z',
        url: 'https://www.google.com/search?q=a-only-2',
      }),
      irrelevantEvent('replica-b', Date.parse('2026-08-16T10:02:00.000Z')),
    ]);
    const wm = store.watermark();
    store.close();
    expect(wm['replica-a']).toBe(2);
    expect(wm['replica-b']).toBe(1);
  });

  sqliteIt('rebuildFromJsonl reproduces the same index from the raw log', async () => {
    const vault = await tempVault();
    const events = [
      timelineEvent({
        replicaId: 'replica-a',
        eventId: 'search-1',
        observedAt: '2026-08-16T10:00:00.000Z',
        url: 'https://www.google.com/search?q=rebuild+target',
      }),
    ];
    const logRoot = join(vault, '_BAC', 'log');
    await mkdir(join(logRoot, 'replica-a'), { recursive: true });
    await writeFile(
      join(logRoot, 'replica-a', '0001.jsonl'),
      `${events.map((e) => JSON.stringify(e)).join('\n')}\nnot-json\n`,
      'utf8',
    );
    const store = await createSearchQueryIndexStore(vault);
    await store.rebuildFromJsonl(logRoot);
    const rows = store.visitsForQuery('rebuild target');
    const wm = store.watermark();
    store.close();
    expect(rows).toHaveLength(1);
    expect(wm['replica-a']).toBe(1);
  });
});

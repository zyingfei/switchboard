// Host-scoped vs family-wide privacy purge against the REAL
// SqliteRecallStore. Reads back document survival (documentCount +
// queryByCanonicalUrl) after each purge — doctrine rule 10: the test
// reads the SERVED artifact, not the layer it changed.
//
// The load-bearing correctness property: deleteDocumentsByHost purges
// ONLY the exact host + its own subdomains, so a meet.google.com purge
// leaves mail.google.com intact. deleteDocumentsByHostFamily purges the
// whole eTLD+1 family (legacy behavior).

import { describe, expect, it } from 'vitest';

import { installCustomSqlite } from './setup-sqlite.js';
import { openInMemoryRecallStore } from './sqlite.js';

import type { StoreDocument } from './types.js';

const doc = (entityId: string, host: string, canonicalUrl: string): StoreDocument => ({
  entityId,
  sourceKind: 'timeline_visit',
  canonicalUrl,
  title: entityId,
  host,
  bodyIndexed: 0,
});

const seed = (): ReturnType<typeof openInMemoryRecallStore> => {
  const store = openInMemoryRecallStore();
  store.upsertDocument(doc('e-meet', 'meet.google.com', 'https://meet.google.com/a'));
  store.upsertDocument(doc('e-meet-sub', 'us.meet.google.com', 'https://us.meet.google.com/b'));
  store.upsertDocument(doc('e-mail', 'mail.google.com', 'https://mail.google.com/c'));
  store.upsertDocument(doc('e-apex', 'google.com', 'https://google.com/d'));
  store.upsertDocument(doc('e-other', 'example.com', 'https://example.com/e'));
  return store;
};

const survivingUrls = (store: ReturnType<typeof openInMemoryRecallStore>): Set<string> => {
  const urls = new Set<string>();
  for (const url of [
    'https://meet.google.com/a',
    'https://us.meet.google.com/b',
    'https://mail.google.com/c',
    'https://google.com/d',
    'https://example.com/e',
  ]) {
    const hits = store.queryByCanonicalUrl({ canonicalUrl: url, limit: 1 });
    if (hits.length > 0) urls.add(url);
  }
  return urls;
};

describe('recall-v2 store — host-scoped vs family purge (read-back)', () => {
  it('deleteDocumentsByHost purges host + own subdomains ONLY; siblings survive', () => {
    installCustomSqlite();
    const store = seed();
    try {
      expect(store.documentCount()).toBe(5);
      const deleted = store.deleteDocumentsByHost?.('meet.google.com') ?? -1;
      // meet.google.com + us.meet.google.com deleted; nothing else.
      expect(deleted).toBe(2);
      const survivors = survivingUrls(store);
      expect(survivors.has('https://meet.google.com/a')).toBe(false);
      expect(survivors.has('https://us.meet.google.com/b')).toBe(false);
      // The whole point: sibling host + apex + unrelated survive.
      expect(survivors.has('https://mail.google.com/c')).toBe(true);
      expect(survivors.has('https://google.com/d')).toBe(true);
      expect(survivors.has('https://example.com/e')).toBe(true);
      expect(store.documentCount()).toBe(3);
    } finally {
      store.close();
    }
  });

  it('deleteDocumentsByHost is label-boundary-safe (no cousin-host over-delete)', () => {
    installCustomSqlite();
    const store = openInMemoryRecallStore();
    try {
      store.upsertDocument(doc('e-meet', 'meet.google.com', 'https://meet.google.com/a'));
      // A deceptively-similar host that must NOT match meet.google.com.
      store.upsertDocument(
        doc('e-evil', 'meetxgoogle.com', 'https://meetxgoogle.com/x'),
      );
      const deleted = store.deleteDocumentsByHost?.('meet.google.com') ?? -1;
      expect(deleted).toBe(1);
      const survivors = survivingUrls(store);
      expect(survivors.has('https://meet.google.com/a')).toBe(false);
      // meetxgoogle.com does not end with ".meet.google.com" → survives.
      const evil = store.queryByCanonicalUrl({
        canonicalUrl: 'https://meetxgoogle.com/x',
        limit: 1,
      });
      expect(evil.length).toBe(1);
    } finally {
      store.close();
    }
  });

  it('deleteDocumentsByHost escapes LIKE metachars — a literal "_" does not over-delete a sibling', () => {
    installCustomSqlite();
    const store = openInMemoryRecallStore();
    try {
      // The purge target contains a literal underscore. Under an unescaped
      // LIKE '%.meet_x.google.com' the '_' is a single-char WILDCARD, so a
      // subdomain of the sibling 'meetYx.google.com' would over-match and
      // be wrongly deleted. With ESCAPE the '_' is a literal.
      store.upsertDocument(doc('e-target', 'a.meet_x.google.com', 'https://a.meet_x.google.com/t'));
      // Sibling that the wildcard would have matched ('_' → 'y').
      store.upsertDocument(doc('e-sibling', 'a.meetyx.google.com', 'https://a.meetyx.google.com/s'));
      const deleted = store.deleteDocumentsByHost?.('meet_x.google.com') ?? -1;
      // ONLY the literal-underscore subdomain is deleted.
      expect(deleted).toBe(1);
      const target = store.queryByCanonicalUrl({
        canonicalUrl: 'https://a.meet_x.google.com/t',
        limit: 1,
      });
      expect(target.length).toBe(0);
      // The sibling the '_' wildcard would have caught survives.
      const sibling = store.queryByCanonicalUrl({
        canonicalUrl: 'https://a.meetyx.google.com/s',
        limit: 1,
      });
      expect(sibling.length).toBe(1);
    } finally {
      store.close();
    }
  });

  it('deleteDocumentsByHostFamily purges the whole eTLD+1 family (legacy)', () => {
    installCustomSqlite();
    const store = seed();
    try {
      const deleted = store.deleteDocumentsByHostFamily?.('google.com') ?? -1;
      // meet + us.meet + mail + apex — all four google.com rows.
      expect(deleted).toBe(4);
      const survivors = survivingUrls(store);
      expect(survivors.has('https://example.com/e')).toBe(true);
      expect(survivors.size).toBe(1);
      expect(store.documentCount()).toBe(1);
    } finally {
      store.close();
    }
  });
});

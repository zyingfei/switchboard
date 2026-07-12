import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  lookupByEntityId,
  lookupByUrl,
  recordImpression,
  recordImpressionFromRecallResults,
  recordImpressionFromServedItems,
  resetImpressionRegistryForTests,
} from './impressionRegistry';

const TTL_MS = 15 * 60_000;

describe('impressionRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetImpressionRegistryForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetImpressionRegistryForTests();
  });

  it('returns the SERVED entityId byte-exact (the trainer joins on exact string match)', () => {
    const served = 'timeline-visit:https://example.com/Path?q=1';
    recordImpression('ctx-1', [{ entityId: served, canonicalUrl: 'https://example.com/Path?q=1' }]);
    expect(lookupByEntityId(served)).toEqual({
      servedContextId: 'ctx-1',
      servedEntityId: served,
    });
    // URL lookup also returns the served entityId, never the URL key.
    expect(lookupByUrl('https://example.com/Path?q=1')).toEqual({
      servedContextId: 'ctx-1',
      servedEntityId: served,
    });
  });

  it('misses on unknown keys', () => {
    recordImpression('ctx-1', [{ entityId: 'entity:a' }]);
    expect(lookupByEntityId('entity:b')).toBeNull();
    expect(lookupByUrl('https://nowhere.example/')).toBeNull();
  });

  it('is most-recent-wins per key when two impressions serve the same entity', () => {
    recordImpression('ctx-old', [{ entityId: 'entity:a', canonicalUrl: 'https://a.example/x' }]);
    recordImpression('ctx-new', [{ entityId: 'entity:a', canonicalUrl: 'https://a.example/x' }]);
    expect(lookupByEntityId('entity:a')?.servedContextId).toBe('ctx-new');
    expect(lookupByUrl('https://a.example/x')?.servedContextId).toBe('ctx-new');
  });

  it('prefers the exact-URL row over a slash variant when one batch shares a urlKey', () => {
    // Real shape: a page_content hit and a chat_turn hit off the same
    // /v2 response sharing a page, drifted by a trailing slash. The
    // row whose canonicalUrl equals the urlKey exactly wins, in
    // EITHER batch order.
    recordImpression('ctx-batch', [
      { entityId: 'id:chat-turn-1', canonicalUrl: 'https://ex.com/page/' },
      { entityId: 'url:page-content', canonicalUrl: 'https://ex.com/page' },
    ]);
    expect(lookupByUrl('https://ex.com/page')?.servedEntityId).toBe('url:page-content');

    resetImpressionRegistryForTests();
    recordImpression('ctx-batch', [
      { entityId: 'url:page-content', canonicalUrl: 'https://ex.com/page' },
      { entityId: 'id:chat-turn-1', canonicalUrl: 'https://ex.com/page/' },
    ]);
    expect(lookupByUrl('https://ex.com/page')?.servedEntityId).toBe('url:page-content');
  });

  it('keeps last-write-wins ACROSS batches even against an older exact-URL row', () => {
    recordImpression('ctx-1', [{ entityId: 'url:page', canonicalUrl: 'https://ex.com/page' }]);
    recordImpression('ctx-2', [{ entityId: 'id:turn', canonicalUrl: 'https://ex.com/page/' }]);
    expect(lookupByUrl('https://ex.com/page')?.servedEntityId).toBe('id:turn');
    expect(lookupByUrl('https://ex.com/page')?.servedContextId).toBe('ctx-2');
  });

  it('drops the stale URL row when an entity is re-served without a canonicalUrl', () => {
    recordImpression('ctx-old', [{ entityId: 'url:e', canonicalUrl: 'https://ex.com/p' }]);
    recordImpression('ctx-new', [{ entityId: 'url:e' }]);
    // The entity itself resolves to the newest serve; the URL index no
    // longer returns the stale older context.
    expect(lookupByEntityId('url:e')?.servedContextId).toBe('ctx-new');
    expect(lookupByUrl('https://ex.com/p')).toBeNull();
  });

  it('stale-URL cleanup leaves the row alone when another entity now owns the key', () => {
    recordImpression('ctx-1', [{ entityId: 'url:a', canonicalUrl: 'https://ex.com/p' }]);
    recordImpression('ctx-2', [{ entityId: 'url:b', canonicalUrl: 'https://ex.com/p' }]);
    recordImpression('ctx-3', [{ entityId: 'url:a' }]);
    expect(lookupByUrl('https://ex.com/p')?.servedEntityId).toBe('url:b');
    expect(lookupByUrl('https://ex.com/p')?.servedContextId).toBe('ctx-2');
  });

  it('tolerates trailing-slash variants in both directions on the URL index', () => {
    recordImpression('ctx-slash', [
      { entityId: 'entity:slash', canonicalUrl: 'https://a.example/page/' },
      { entityId: 'entity:bare', canonicalUrl: 'https://b.example/page' },
    ]);
    expect(lookupByUrl('https://a.example/page')?.servedEntityId).toBe('entity:slash');
    expect(lookupByUrl('https://b.example/page/')?.servedEntityId).toBe('entity:bare');
  });

  it('expires entries after the 15-minute TTL', () => {
    recordImpression('ctx-ttl', [{ entityId: 'entity:t', canonicalUrl: 'https://t.example/p' }]);
    vi.advanceTimersByTime(TTL_MS - 1);
    expect(lookupByEntityId('entity:t')).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(lookupByEntityId('entity:t')).toBeNull();
    expect(lookupByUrl('https://t.example/p')).toBeNull();
  });

  it('caps total entries at 1000, evicting oldest-first', () => {
    recordImpression('ctx-a', [{ entityId: 'entity:first' }]);
    const bulk = Array.from({ length: 1000 }, (_, i) => ({ entityId: `entity:bulk-${String(i)}` }));
    recordImpression('ctx-b', bulk);
    // 1001 total → the oldest ('entity:first') was evicted; the bulk
    // batch survives intact.
    expect(lookupByEntityId('entity:first')).toBeNull();
    expect(lookupByEntityId('entity:bulk-0')).not.toBeNull();
    expect(lookupByEntityId('entity:bulk-999')).not.toBeNull();
  });

  it('re-recording refreshes recency so the refreshed key is not the eviction victim', () => {
    recordImpression('ctx-a', [{ entityId: 'entity:keep' }]);
    recordImpression('ctx-a', [{ entityId: 'entity:drop' }]);
    // Refresh 'keep' → 'drop' is now the oldest.
    recordImpression('ctx-b', [{ entityId: 'entity:keep' }]);
    const bulk = Array.from({ length: 999 }, (_, i) => ({ entityId: `entity:bulk-${String(i)}` }));
    recordImpression('ctx-c', bulk);
    expect(lookupByEntityId('entity:drop')).toBeNull();
    expect(lookupByEntityId('entity:keep')?.servedContextId).toBe('ctx-b');
  });

  it('ignores blank servedContextId and blank entityIds', () => {
    recordImpression('', [{ entityId: 'entity:x' }]);
    recordImpression('ctx-1', [{ entityId: '' }]);
    expect(lookupByEntityId('entity:x')).toBeNull();
    expect(lookupByEntityId('')).toBeNull();
  });

  describe('recordImpressionFromRecallResults', () => {
    it('parses raw /v2 results, skipping rows without a string entityId', () => {
      recordImpressionFromRecallResults('ctx-raw', [
        { entityId: 'entity:ok', canonicalUrl: 'https://ok.example/p' },
        { entityId: 42, canonicalUrl: 'https://bad.example/p' },
        { canonicalUrl: 'https://no-entity.example/p' },
        null,
        'garbage',
      ]);
      expect(lookupByEntityId('entity:ok')?.servedContextId).toBe('ctx-raw');
      expect(lookupByUrl('https://ok.example/p')?.servedEntityId).toBe('entity:ok');
      expect(lookupByUrl('https://bad.example/p')).toBeNull();
      expect(lookupByUrl('https://no-entity.example/p')).toBeNull();
    });

    it('is a no-op when servedContextId is missing or not a string', () => {
      recordImpressionFromRecallResults(undefined, [{ entityId: 'entity:x' }]);
      recordImpressionFromRecallResults(7, [{ entityId: 'entity:x' }]);
      expect(lookupByEntityId('entity:x')).toBeNull();
    });
  });

  describe('recordImpressionFromServedItems', () => {
    it('groups by per-item servedContextId and skips items missing either id', () => {
      recordImpressionFromServedItems([
        { entityId: 'entity:a', servedContextId: 'ctx-1', canonicalUrl: 'https://a.example/' },
        { entityId: 'entity:b', servedContextId: 'ctx-2' },
        { entityId: 'entity:no-ctx' },
        { servedContextId: 'ctx-3', canonicalUrl: 'https://no-entity.example/' },
      ]);
      expect(lookupByEntityId('entity:a')?.servedContextId).toBe('ctx-1');
      expect(lookupByUrl('https://a.example')?.servedEntityId).toBe('entity:a');
      expect(lookupByEntityId('entity:b')?.servedContextId).toBe('ctx-2');
      expect(lookupByEntityId('entity:no-ctx')).toBeNull();
      expect(lookupByUrl('https://no-entity.example/')).toBeNull();
    });
  });
});

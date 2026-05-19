import { describe, expect, it, vi } from 'vitest';

import { resolveFocusedUrlRecord } from '../../../src/sidepanel/inbox/focusedUrlRecord';
import type { UrlProjection, UrlVisitRecord } from '../../../src/sidepanel/tabsession/types';

const rec = (input: Partial<UrlVisitRecord> & { canonicalUrl: string }): UrlVisitRecord => ({
  firstSeenAt: '',
  lastSeenAt: '',
  visitCount: 0,
  tabSessionIds: [],
  attributionHistory: [],
  ...input,
});

const projection = (records: readonly UrlVisitRecord[]): UrlProjection => ({
  schemaVersion: 1,
  byCanonicalUrl: Object.fromEntries(records.map((r) => [r.canonicalUrl, r])),
});

// Test comparable: drop the query so distinct ?id= pages collide,
// exercising the "prefer the decided record" path.
const comparable = (url: string | undefined): string | null =>
  url === undefined ? null : url.split('?')[0] ?? null;

const synth = rec({ canonicalUrl: 'synthetic', latestTitle: 'live tab' });

describe('resolveFocusedUrlRecord', () => {
  it('returns undefined when there is no focused tab', () => {
    expect(
      resolveFocusedUrlRecord({
        focusedTabUrl: null,
        projection: null,
        comparable,
        synthesize: () => synth,
      }),
    ).toBeUndefined();
  });

  it('prefers an exact canonical-key hit (query preserved)', () => {
    const target = rec({
      canonicalUrl: 'https://news.ycombinator.com/item?id=48154865',
      currentAttribution: { workstreamId: 'ws_ai', source: 'user_asserted', observedAt: 't', clientEventId: 'e1' },
    });
    const got = resolveFocusedUrlRecord({
      focusedTabUrl: 'https://news.ycombinator.com/item?id=48154865',
      projection: projection([rec({ canonicalUrl: 'https://other' }), target]),
      comparable,
      synthesize: () => synth,
    });
    expect(got).toBe(target);
  });

  it('prefers a DECIDED record over a decision-less sibling that collides on the comparable form', () => {
    // The bug: many news.ycombinator.com/item?id=* pages normalise to
    // the same comparable URL; resolving must not return an undecided
    // sibling for a page the user already filed.
    const undecided = rec({ canonicalUrl: 'https://news.ycombinator.com/item?id=1' });
    const filed = rec({
      canonicalUrl: 'https://news.ycombinator.com/item?id=2',
      currentAttribution: { workstreamId: 'ws_ai', source: 'user_asserted', observedAt: 't', clientEventId: 'e1' },
    });
    const got = resolveFocusedUrlRecord({
      // comparable strips the query → both collide on this key.
      focusedTabUrl: 'https://news.ycombinator.com/item',
      projection: projection([undecided, filed]),
      comparable,
      synthesize: () => synth,
    });
    expect(got).toBe(filed);
  });

  it('falls back to a single comparable match when none is decided', () => {
    const only = rec({ canonicalUrl: 'https://example.test/a?x=1' });
    const got = resolveFocusedUrlRecord({
      focusedTabUrl: 'https://example.test/a',
      projection: projection([only]),
      comparable,
      synthesize: () => synth,
    });
    expect(got).toBe(only);
  });

  it('synthesizes from the live tab when the URL is unknown', () => {
    const synthesize = vi.fn(() => synth);
    const got = resolveFocusedUrlRecord({
      focusedTabUrl: 'https://unknown.test/page',
      projection: projection([rec({ canonicalUrl: 'https://other' })]),
      comparable,
      synthesize,
    });
    expect(synthesize).toHaveBeenCalledOnce();
    expect(got).toBe(synth);
  });
});

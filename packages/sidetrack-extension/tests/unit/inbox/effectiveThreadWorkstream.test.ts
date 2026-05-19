import { describe, expect, it } from 'vitest';

import {
  effectiveThreadWorkstreamId,
  withEffectiveThreadWorkstream,
  type UrlProjectionLike,
} from '../../../src/sidepanel/inbox/effectiveThreadWorkstream';

// Test canonicalize: chat URLs drop query/hash (mirrors
// canonicalThreadUrl for provider thread URLs).
const canon = (url: string): string => url.split('#')[0]?.split('?')[0] ?? url;

const proj = (entries: Record<string, string | null>): UrlProjectionLike => ({
  byCanonicalUrl: Object.fromEntries(
    Object.entries(entries).map(([u, ws]) => [u, { currentAttribution: { workstreamId: ws } }]),
  ),
});

describe('effectiveThreadWorkstreamId', () => {
  it("keeps the thread's own workstream when set", () => {
    expect(
      effectiveThreadWorkstreamId(
        { primaryWorkstreamId: 'WS_OWN', threadUrl: 'https://gemini.google.com/app/x' },
        proj({ 'https://gemini.google.com/app/x': 'WS_URL' }),
        canon,
      ),
    ).toBe('WS_OWN');
  });

  it('derives from the URL attribution when the thread has none (the Gemini case)', () => {
    expect(
      effectiveThreadWorkstreamId(
        { threadUrl: 'https://gemini.google.com/app/dfb947?usp=x#frag' },
        proj({ 'https://gemini.google.com/app/dfb947': '0K230YS0SZ8F1MZD' }),
        canon,
      ),
    ).toBe('0K230YS0SZ8F1MZD');
  });

  it('is undefined when neither the thread nor its URL is filed', () => {
    expect(
      effectiveThreadWorkstreamId(
        { threadUrl: 'https://gemini.google.com/app/unfiled' },
        proj({ 'https://other': 'WS' }),
        canon,
      ),
    ).toBeUndefined();
  });

  it('treats a null URL workstream ("not in any stream") as ungrouped, not a bogus id', () => {
    expect(
      effectiveThreadWorkstreamId(
        { threadUrl: 'https://gemini.google.com/app/declined' },
        proj({ 'https://gemini.google.com/app/declined': null }),
        canon,
      ),
    ).toBeUndefined();
  });
});

describe('withEffectiveThreadWorkstream', () => {
  it('returns the SAME object when the thread already has a workstream (no re-render churn)', () => {
    const t = { primaryWorkstreamId: 'WS', threadUrl: 'https://x', extra: 1 };
    expect(withEffectiveThreadWorkstream(t, proj({ 'https://x': 'OTHER' }), canon)).toBe(t);
  });

  it('returns the same object when nothing can be derived', () => {
    const t = { threadUrl: 'https://gemini.google.com/app/unfiled' };
    expect(withEffectiveThreadWorkstream(t, proj({}), canon)).toBe(t);
  });

  it('fills primaryWorkstreamId from the URL attribution otherwise', () => {
    const t: { threadUrl: string; title: string; primaryWorkstreamId?: string } = {
      threadUrl: 'https://gemini.google.com/app/y',
      title: 'CUDA',
    };
    const out = withEffectiveThreadWorkstream(
      t,
      proj({ 'https://gemini.google.com/app/y': 'WS_AI' }),
      canon,
    );
    expect(out).not.toBe(t);
    expect(out.primaryWorkstreamId).toBe('WS_AI');
    expect(out.title).toBe('CUDA');
  });
});

import { describe, expect, it } from 'vitest';

import { detectSearchUrl, sanitizeTimelinePayload, sanitizeTimelineUrl } from './sanitize.js';

// Reviewer-flagged: defense-in-depth at the import boundary. Even
// though the plugin observer sanitizes outgoing URLs, the route
// accepts events from any caller with the bridge key — older plugin
// builds, archive imports, and (worst case) malicious callers with a
// stolen key. The event log is immutable, so sanitization must
// happen BEFORE importEdgeEvent.

describe('companion sanitizeTimelineUrl', () => {
  it('strips fragments and sensitive query params', () => {
    expect(sanitizeTimelineUrl('https://x.com/a?code=abc#frag')).toBe('https://x.com/a');
    expect(sanitizeTimelineUrl('https://x.com/?token=t&q=stay')).toBe('https://x.com/?q=stay');
  });

  it('drops auth-shaped suffixes', () => {
    expect(sanitizeTimelineUrl('https://x.com/?my_token=abc')).toBe('https://x.com/');
    expect(sanitizeTimelineUrl('https://x.com/?reset_code=abc')).toBe('https://x.com/');
    expect(sanitizeTimelineUrl('https://x.com/?CLIENT_SECRET=abc')).toBe('https://x.com/');
  });

  it('on parse failure, still strips fragment', () => {
    expect(sanitizeTimelineUrl('not a url#frag')).toBe('not a url');
  });
});

describe('sanitizeTimelinePayload', () => {
  it('sanitizes both url and canonicalUrl', () => {
    const out = sanitizeTimelinePayload({
      url: 'https://x.com/?token=t#frag',
      canonicalUrl: 'https://x.com/?session_id=z',
      observedAt: '2026-05-07T10:00:00.000Z',
    });
    expect(out.url).toBe('https://x.com/');
    expect(out.canonicalUrl).toBe('https://x.com/');
  });

  it('returns the same object when nothing changed (no allocation cost)', () => {
    const input = { url: 'https://x.com/clean?q=ok', observedAt: '2026-05-07T10:00:00.000Z' };
    const out = sanitizeTimelinePayload(input);
    expect(out).toBe(input);
  });

  it('preserves other fields', () => {
    const out = sanitizeTimelinePayload({
      url: 'https://x.com/?code=abc',
      canonicalUrl: 'https://x.com/',
      observedAt: '2026-05-07T10:00:00.000Z',
      title: 'Hi',
      provider: 'chatgpt',
      transition: 'activated',
    });
    expect(out.title).toBe('Hi');
    expect(out.provider).toBe('chatgpt');
    expect(out.url).toBe('https://x.com/');
  });
});

describe('companion detectSearchUrl + search-URL canonicalization', () => {
  it('detects /search?q on any host (host-agnostic)', () => {
    for (const host of [
      'https://www.google.com',
      'https://www.bing.com',
      'https://duckduckgo.com',
      'https://search.brave.com',
      'https://kagi.com',
    ]) {
      const info = detectSearchUrl(`${host}/search?q=foo+bar`);
      expect(info, `host=${host}`).not.toBeNull();
      expect(info!.query).toBe('foo bar');
      expect(info!.canonicalUrl).toBe(`${host}/search?q=foo+bar`);
    }
  });

  it('detects root-path /?q (DuckDuckGo / Startpage shape)', () => {
    const info = detectSearchUrl('https://duckduckgo.com/?q=alpha');
    expect(info).not.toBeNull();
    expect(info!.query).toBe('alpha');
    expect(info!.canonicalUrl).toBe('https://duckduckgo.com/?q=alpha');
  });

  it('strips every query param except q (Google session params drop)', () => {
    const info = detectSearchUrl(
      'https://www.google.com/search?q=Linux+crypto+subsystem&newwindow=1&sca_esv=9700858d11d87a5f&sxsrf=ANbL-n7otDb8AtUZOxbzZ4JQi1ezOpsbrw',
    );
    expect(info).not.toBeNull();
    expect(info!.canonicalUrl).toBe(
      'https://www.google.com/search?q=Linux+crypto+subsystem',
    );
    expect(info!.query).toBe('Linux crypto subsystem');
  });

  it('rejects URLs whose path is not / or /search even with a q param (e.g. product pages)', () => {
    expect(detectSearchUrl('https://shop.example.com/products?q=hat')).toBeNull();
    expect(detectSearchUrl('https://example.com/items/foo?q=42')).toBeNull();
  });

  it('rejects URLs without a q param', () => {
    expect(detectSearchUrl('https://www.google.com/search?other=42')).toBeNull();
    expect(detectSearchUrl('https://www.google.com/search')).toBeNull();
    expect(detectSearchUrl('https://duckduckgo.com/')).toBeNull();
  });

  it('rejects empty / blank q values', () => {
    expect(detectSearchUrl('https://www.google.com/search?q=')).toBeNull();
    expect(detectSearchUrl('https://www.google.com/search?q=%20%20')).toBeNull();
  });

  it('returns null for malformed URLs', () => {
    expect(detectSearchUrl('not a url')).toBeNull();
    expect(detectSearchUrl('')).toBeNull();
  });

  it('the same search across sessions canonicalizes to the same URL', () => {
    const a = sanitizeTimelineUrl(
      'https://www.google.com/search?q=Linux+crypto+subsystem&sca_esv=A&ei=A1',
    );
    const b = sanitizeTimelineUrl(
      'https://www.google.com/search?q=Linux+crypto+subsystem&sca_esv=B&ei=B2&iflsig=blah',
    );
    expect(a).toBe(b);
    expect(a).toBe('https://www.google.com/search?q=Linux+crypto+subsystem');
  });
});

import { describe, expect, it } from 'vitest';

import { sanitizeTimelinePayload, sanitizeTimelineUrl } from './sanitize.js';

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

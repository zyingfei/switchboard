import { describe, expect, it } from 'vitest';

import { sanitizeTimelineUrl, urlHasSensitiveData } from '../../../src/timeline/sanitize';

// Reviewer-flagged privacy fix. The observer was emitting `input.url`
// directly; URLs containing OAuth/SSO/reset tokens would have shipped
// to the companion as-is. sanitizeTimelineUrl strips fragments AND
// auth-shaped query params so the timeline payload is honestly
// privacy-careful.

describe('sanitizeTimelineUrl', () => {
  it('strips fragments', () => {
    expect(sanitizeTimelineUrl('https://x.com/a#section-2')).toBe('https://x.com/a');
    expect(sanitizeTimelineUrl('https://x.com/a?q=1#anchor')).toBe('https://x.com/a?q=1');
  });

  it('drops common OAuth / token / code params', () => {
    expect(
      sanitizeTimelineUrl('https://example.com/callback?code=abc&state=xyz'),
    ).toBe('https://example.com/callback');
    expect(
      sanitizeTimelineUrl('https://app.com/?access_token=secret&id_token=more'),
    ).toBe('https://app.com/');
    expect(
      sanitizeTimelineUrl('https://x.com/?refresh_token=z&q=stay'),
    ).toBe('https://x.com/?q=stay');
  });

  it('drops session / key / secret / password / auth params', () => {
    expect(sanitizeTimelineUrl('https://x.com/?session=abc')).toBe('https://x.com/');
    expect(sanitizeTimelineUrl('https://x.com/?session_id=abc')).toBe('https://x.com/');
    expect(sanitizeTimelineUrl('https://x.com/?api_key=abc')).toBe('https://x.com/');
    expect(sanitizeTimelineUrl('https://x.com/?secret=abc')).toBe('https://x.com/');
    expect(sanitizeTimelineUrl('https://x.com/?password=abc')).toBe('https://x.com/');
    expect(sanitizeTimelineUrl('https://x.com/?auth=abc')).toBe('https://x.com/');
    expect(sanitizeTimelineUrl('https://x.com/?sig=abc')).toBe('https://x.com/');
    expect(sanitizeTimelineUrl('https://x.com/?signature=abc')).toBe('https://x.com/');
  });

  it('drops auth-shaped suffixes (_token, _key, _secret, _password, _auth, _session, _code)', () => {
    expect(sanitizeTimelineUrl('https://x.com/?my_token=abc&q=1')).toBe('https://x.com/?q=1');
    expect(sanitizeTimelineUrl('https://x.com/?primary_key=abc')).toBe('https://x.com/');
    expect(sanitizeTimelineUrl('https://x.com/?client_secret=abc')).toBe('https://x.com/');
    expect(sanitizeTimelineUrl('https://x.com/?old_password=abc')).toBe('https://x.com/');
    expect(sanitizeTimelineUrl('https://x.com/?bearer_auth=abc')).toBe('https://x.com/');
    expect(sanitizeTimelineUrl('https://x.com/?invite_code=abc')).toBe('https://x.com/');
  });

  it('preserves non-sensitive query params', () => {
    expect(
      sanitizeTimelineUrl('https://x.com/search?q=hello&page=2'),
    ).toBe('https://x.com/search?q=hello&page=2');
    expect(
      sanitizeTimelineUrl('https://x.com/?utm_source=email&model=gpt-4'),
    ).toBe('https://x.com/?utm_source=email&model=gpt-4');
  });

  it('parameter name match is case-insensitive', () => {
    expect(sanitizeTimelineUrl('https://x.com/?TOKEN=abc')).toBe('https://x.com/');
    expect(sanitizeTimelineUrl('https://x.com/?Code=abc')).toBe('https://x.com/');
    expect(sanitizeTimelineUrl('https://x.com/?Access_Token=abc')).toBe('https://x.com/');
  });

  it('SAML / SSO style params are dropped', () => {
    expect(sanitizeTimelineUrl('https://sso.com/?SAMLResponse=abc')).toBe('https://sso.com/');
    expect(sanitizeTimelineUrl('https://sso.com/?SAMLRequest=abc')).toBe('https://sso.com/');
  });

  it('on parse failure, still strips fragment', () => {
    expect(sanitizeTimelineUrl('not a url#secret')).toBe('not a url');
    expect(sanitizeTimelineUrl('not a url')).toBe('not a url');
  });

  it('empty string is unchanged', () => {
    expect(sanitizeTimelineUrl('')).toBe('');
  });

  it('urlHasSensitiveData reports correctly', () => {
    expect(urlHasSensitiveData('https://x.com/?code=abc')).toBe(true);
    expect(urlHasSensitiveData('https://x.com/a#frag')).toBe(true);
    expect(urlHasSensitiveData('https://x.com/?my_token=abc')).toBe(true);
    expect(urlHasSensitiveData('https://x.com/?q=hello')).toBe(false);
    expect(urlHasSensitiveData('https://x.com/')).toBe(false);
  });
});

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

  it('preserves non-sensitive, non-marketing query params', () => {
    expect(
      sanitizeTimelineUrl('https://x.com/search?q=hello&page=2'),
    ).toBe('https://x.com/search?q=hello&page=2');
    // utm_source is now stripped by default (Stage 5 follow-up). The
    // content-bearing `model` param stays.
    expect(
      sanitizeTimelineUrl('https://x.com/?utm_source=email&model=gpt-4'),
    ).toBe('https://x.com/?model=gpt-4');
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

  // Stage 5 follow-up — marketing/ad-tracking param strip
  describe('marketing param strip', () => {
    it('strips utm_*, gclid, gbraid, fbclid, msclkid by default', () => {
      const out = sanitizeTimelineUrl(
        'https://example.test/p?utm_source=adwords&utm_campaign=foo&gclid=abc&fbclid=xyz&msclkid=123&keep=me',
      );
      expect(out).toBe('https://example.test/p?keep=me');
    });

    it('strips hsa_* and gad_* prefix families', () => {
      const out = sanitizeTimelineUrl(
        'https://example.test/p?hsa_acc=1&hsa_cam=2&hsa_grp=3&gad_source=1&gad_campaignid=99&content=keep',
      );
      expect(out).toBe('https://example.test/p?content=keep');
    });

    it('preserves content-bearing params alongside stripping marketing', () => {
      const out = sanitizeTimelineUrl(
        'https://www.google.com/search?q=cqrs&utm_source=newsletter&hl=en&gclid=zzz',
      );
      // q and hl stay; utm + gclid go.
      const parsed = new URL(out);
      expect(parsed.searchParams.get('q')).toBe('cqrs');
      expect(parsed.searchParams.get('hl')).toBe('en');
      expect(parsed.searchParams.has('utm_source')).toBe(false);
      expect(parsed.searchParams.has('gclid')).toBe(false);
    });

    it('collapses the user-reported tdengine URL to its bare canonical form', () => {
      // The exact URL from the user's bug report — 14 marketing params.
      const out = sanitizeTimelineUrl(
        'https://tdengine.com/pi-system/?utm_term=pi%20system&utm_campaign=Traffic+-+IDMP&utm_source=adwords&utm_medium=ppc&hsa_acc=7448569197&hsa_cam=22870789433&hsa_grp=183627849316&hsa_ad=768257356010&hsa_src=g&hsa_tgt=kwd-299415867315&hsa_kw=pi%20system&hsa_mt=b&hsa_net=adwords&hsa_ver=3&gad_source=1&gad_campaignid=22870789433&gbraid=0AAAAApJbxHufivHxgqX2A4QAqXfCXwuFe&gclid=Cj0KCQjw_IXQBhCkARIsADqELbIsXrHfkRN1ZtwdY4TBiSUEFy50WNB7k20mIWxmj_uwCuRTy-_i1bwaAvu7EALw_wcB',
      );
      expect(out).toBe('https://tdengine.com/pi-system/');
    });

    it('honors SIDETRACK_TIMELINE_STRIP_MARKETING_PARAMS=0 to disable the strip', () => {
      const previous = process.env['SIDETRACK_TIMELINE_STRIP_MARKETING_PARAMS'];
      process.env['SIDETRACK_TIMELINE_STRIP_MARKETING_PARAMS'] = '0';
      try {
        const out = sanitizeTimelineUrl(
          'https://example.test/p?utm_source=adwords&keep=me',
        );
        // utm_source preserved when strip is disabled.
        expect(out).toBe('https://example.test/p?utm_source=adwords&keep=me');
      } finally {
        /* eslint-disable @typescript-eslint/no-dynamic-delete */
        if (previous === undefined) delete process.env['SIDETRACK_TIMELINE_STRIP_MARKETING_PARAMS'];
        else process.env['SIDETRACK_TIMELINE_STRIP_MARKETING_PARAMS'] = previous;
        /* eslint-enable @typescript-eslint/no-dynamic-delete */
      }
    });
  });
});

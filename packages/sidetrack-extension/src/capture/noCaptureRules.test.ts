import { describe, expect, it } from 'vitest';

import {
  detectCategoryTokens,
  matchesNoCaptureRules,
  registrableDomain,
  registrableDomainFromUrl,
  type NoCaptureCategoryToken,
  type NoCaptureRule,
} from './noCaptureRules';

const domainRule = (domain: string): NoCaptureRule => ({
  id: `r_${domain}`,
  kind: 'domain',
  domain,
  label: domain,
  createdAt: '2026-07-11T00:00:00.000Z',
});

const similarRule = (
  domain: string,
  categoryTokens: readonly NoCaptureCategoryToken[],
): NoCaptureRule => ({
  id: `s_${domain}`,
  kind: 'similar',
  domain,
  label: domain,
  createdAt: '2026-07-11T00:00:00.000Z',
  categoryTokens,
});

describe('registrableDomain', () => {
  it('collapses subdomains to the eTLD+1', () => {
    expect(registrableDomain('www.pge.com')).toBe('pge.com');
    expect(registrableDomain('secure.login.pge.com')).toBe('pge.com');
    expect(registrableDomain('pge.com')).toBe('pge.com');
  });

  it('handles common multi-part TLDs', () => {
    expect(registrableDomain('www.hsbc.co.uk')).toBe('hsbc.co.uk');
    expect(registrableDomain('shop.example.com.au')).toBe('example.com.au');
  });

  it('returns IP literals unchanged', () => {
    expect(registrableDomain('127.0.0.1')).toBe('127.0.0.1');
  });

  it('extracts from a full URL', () => {
    expect(registrableDomainFromUrl('https://www.pge.com/en/account/billing.page')).toBe('pge.com');
    expect(registrableDomainFromUrl('chrome://settings')).toBe('');
    expect(registrableDomainFromUrl('not a url')).toBe('');
  });
});

describe('detectCategoryTokens', () => {
  it('detects tokens in the URL path', () => {
    expect(detectCategoryTokens({ url: 'https://x.com/account/billing' })).toEqual(
      expect.arrayContaining(['account', 'billing']),
    );
  });

  it('detects tokens in the page title', () => {
    expect(detectCategoryTokens({ url: 'https://x.com/', title: 'Your Bank Statement' })).toEqual([
      'statement',
    ]);
  });

  it('does NOT trip on a bare host — path/title only (conservative)', () => {
    expect(detectCategoryTokens({ url: 'https://myaccount.example.com/home' })).toEqual([]);
  });

  it('is word-boundary matched (no substring false-friends)', () => {
    // "taxonomy" must not match 'tax'.
    expect(detectCategoryTokens({ url: 'https://x.com/taxonomy/list' })).toEqual([]);
  });
});

describe('matchesNoCaptureRules', () => {
  it('matches a domain rule for the same eTLD+1 family (incl subdomains)', () => {
    const rules = [domainRule('pge.com')];
    expect(matchesNoCaptureRules({ url: 'https://www.pge.com/x' }, rules)).toBe(true);
    expect(matchesNoCaptureRules({ url: 'https://secure.pge.com/pay' }, rules)).toBe(true);
    expect(matchesNoCaptureRules({ url: 'https://example.com/x' }, rules)).toBe(false);
  });

  it('does not match a different domain for a domain rule', () => {
    expect(matchesNoCaptureRules({ url: 'https://notpge.com/x' }, [domainRule('pge.com')])).toBe(
      false,
    );
  });

  it('similar rule matches its own family', () => {
    const rules = [similarRule('pge.com', ['account', 'billing'])];
    expect(matchesNoCaptureRules({ url: 'https://www.pge.com/anything' }, rules)).toBe(true);
  });

  it('similar rule matches cross-domain when a category token hits the path', () => {
    const rules = [similarRule('pge.com', ['account', 'billing'])];
    expect(
      matchesNoCaptureRules({ url: 'https://other-utility.com/account/settings' }, rules),
    ).toBe(true);
  });

  it('similar rule matches cross-domain via the page title', () => {
    const rules = [similarRule('pge.com', ['statement'])];
    expect(
      matchesNoCaptureRules(
        { url: 'https://other.com/home', title: 'Monthly Statement — Login' },
        rules,
      ),
    ).toBe(true);
  });

  it('similar rule does NOT match cross-domain without a token hit', () => {
    const rules = [similarRule('pge.com', ['account', 'billing'])];
    expect(matchesNoCaptureRules({ url: 'https://news.com/story' }, rules)).toBe(false);
  });

  it('similar rule with a bare-domain-only token page does NOT match (conservative)', () => {
    const rules = [similarRule('pge.com', ['account'])];
    // 'account' appears only in the host, not the path/title — no match.
    expect(matchesNoCaptureRules({ url: 'https://myaccount.other.com/home' }, rules)).toBe(false);
  });

  it('empty rule list never matches', () => {
    expect(matchesNoCaptureRules({ url: 'https://pge.com/x' }, [])).toBe(false);
  });

  it('non-http URLs never match', () => {
    expect(matchesNoCaptureRules({ url: 'chrome://settings' }, [domainRule('settings')])).toBe(
      false,
    );
  });
});

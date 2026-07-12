import { describe, expect, it } from 'vitest';

import {
  detectCategoryTokens,
  firstMatchingNoCaptureRule,
  matchesNoCaptureRules,
  noCaptureRuleDisplayLabel,
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

  it('title-only token hit diverges from URL-only matching (gate-alignment guard)', () => {
    // The authoritative capture gate (background.ts isCaptureAllowedForUrl)
    // matches on URL ONLY — no title. A 'similar' rule whose token appears
    // only in the TITLE (not the path/query/hash) therefore MUST NOT match
    // URL-only, or the panel badge / open-tabs preview would say "blocked"
    // while the background actually captures. This pins that divergence so
    // the UI + preview callers keep passing URL-only.
    const rules = [similarRule('pge.com', ['statement'])];
    const page = { url: 'https://other.com/home', title: 'Monthly Statement' };
    // With the title, the matcher DOES trip (title token hit)…
    expect(matchesNoCaptureRules(page, rules)).toBe(true);
    // …but URL-only — exactly what the gate/UI/preview pass — does NOT.
    expect(matchesNoCaptureRules({ url: page.url }, rules)).toBe(false);
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

describe('firstMatchingNoCaptureRule', () => {
  it('returns the matched rule (not just a boolean) so the UI can name it', () => {
    const rule = domainRule('pge.com');
    const matched = firstMatchingNoCaptureRule({ url: 'https://www.pge.com/pay' }, [rule]);
    expect(matched).toBe(rule);
  });

  it('returns the FIRST matching rule when several match', () => {
    const first = domainRule('pge.com');
    const second = similarRule('pge.com', ['account']);
    const matched = firstMatchingNoCaptureRule({ url: 'https://www.pge.com/x' }, [first, second]);
    expect(matched).toBe(first);
  });

  it('returns null when nothing matches', () => {
    expect(firstMatchingNoCaptureRule({ url: 'https://example.com/x' }, [domainRule('pge.com')])).toBe(
      null,
    );
    expect(firstMatchingNoCaptureRule({ url: 'https://pge.com/x' }, [])).toBe(null);
  });

  it('agrees with matchesNoCaptureRules (the boolean wrapper)', () => {
    const rules = [domainRule('pge.com')];
    for (const url of ['https://www.pge.com/x', 'https://example.com/x', 'chrome://settings']) {
      expect(firstMatchingNoCaptureRule({ url }, rules) !== null).toBe(
        matchesNoCaptureRules({ url }, rules),
      );
    }
  });
});

describe('noCaptureRuleDisplayLabel', () => {
  it('reads a domain rule as its label', () => {
    expect(noCaptureRuleDisplayLabel(domainRule('pge.com'))).toBe('pge.com');
  });

  it('prefixes a similar rule with "similar:"', () => {
    expect(noCaptureRuleDisplayLabel(similarRule('pge.com', ['account']))).toBe('similar:pge.com');
  });

  it('falls back to the domain when the label is empty', () => {
    const rule: NoCaptureRule = { ...domainRule('pge.com'), label: '' };
    expect(noCaptureRuleDisplayLabel(rule)).toBe('pge.com');
  });
});

import { describe, expect, it } from 'vitest';

import {
  detectCategoryTokens,
  firstMatchingNoCaptureRule,
  hostFromUrl,
  hostMatchesRuleHost,
  matchesNoCaptureRules,
  noCaptureRuleDisplayLabel,
  noCaptureRuleScopeKey,
  registrableDomain,
  registrableDomainFromUrl,
  type NoCaptureCategoryToken,
  type NoCaptureRule,
} from './noCaptureRules';

// Legacy (pre-host-scoping) family-wide rule: `domain` only, no `host`.
const domainRule = (domain: string): NoCaptureRule => ({
  id: `r_${domain}`,
  kind: 'domain',
  domain,
  label: domain,
  createdAt: '2026-07-11T00:00:00.000Z',
});

// Host-scoped 'domain' rule — the shape the "Don't capture <site>" action
// now produces. `domain` is the eTLD+1 (for the label / legacy fallback);
// `host` is the exact host the rule was created from and drives matching.
const hostRule = (host: string): NoCaptureRule => ({
  id: `h_${host}`,
  kind: 'domain',
  domain: registrableDomain(host),
  host,
  label: host,
  createdAt: '2026-07-24T00:00:00.000Z',
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

// Host-scoped 'similar' rule (host + tokens).
const similarHostRule = (
  host: string,
  categoryTokens: readonly NoCaptureCategoryToken[],
): NoCaptureRule => ({
  id: `sh_${host}`,
  kind: 'similar',
  domain: registrableDomain(host),
  host,
  label: host,
  createdAt: '2026-07-24T00:00:00.000Z',
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

describe('hostFromUrl', () => {
  it('extracts the bare lowercased host', () => {
    expect(hostFromUrl('https://Meet.Google.com/abc')).toBe('meet.google.com');
    expect(hostFromUrl('https://mail.google.com/')).toBe('mail.google.com');
  });

  it('strips a trailing dot and ignores the port', () => {
    expect(hostFromUrl('https://meet.google.com.:8443/x')).toBe('meet.google.com');
  });

  it('returns "" for non-http(s) or unparseable input', () => {
    expect(hostFromUrl('chrome://settings')).toBe('');
    expect(hostFromUrl('not a url')).toBe('');
  });
});

describe('hostMatchesRuleHost (label-boundary safety)', () => {
  it('matches the exact host and its own subdomains', () => {
    expect(hostMatchesRuleHost('meet.google.com', 'meet.google.com')).toBe(true);
    expect(hostMatchesRuleHost('sub.meet.google.com', 'meet.google.com')).toBe(true);
  });

  it('does NOT match the parent domain or sibling hosts', () => {
    expect(hostMatchesRuleHost('google.com', 'meet.google.com')).toBe(false);
    expect(hostMatchesRuleHost('mail.google.com', 'meet.google.com')).toBe(false);
  });

  it('is label-boundary-safe — no suffix false-friends', () => {
    // "meetxgoogle.com" ends with "google.com" as a substring but NOT on a
    // label boundary, so a meet.google.com rule must not match it…
    expect(hostMatchesRuleHost('meetxgoogle.com', 'meet.google.com')).toBe(false);
    // …and "evilgoogle.com" must not match a google.com host rule.
    expect(hostMatchesRuleHost('evilgoogle.com', 'google.com')).toBe(false);
  });

  it('never matches on empty inputs', () => {
    expect(hostMatchesRuleHost('', 'google.com')).toBe(false);
    expect(hostMatchesRuleHost('google.com', '')).toBe(false);
  });
});

describe('noCaptureRuleScopeKey', () => {
  it('is the host for a host-scoped rule', () => {
    expect(noCaptureRuleScopeKey(hostRule('meet.google.com'))).toBe('meet.google.com');
  });

  it('is the eTLD+1 domain for a legacy family-wide rule', () => {
    expect(noCaptureRuleScopeKey(domainRule('google.com'))).toBe('google.com');
  });
});

// The user-reported bug: choosing "Don't capture" on meet.google.com must
// block ONLY meet.google.com (+ its subdomains), never the rest of the
// google.com family. This is the intent-preserving truth table.
describe('host-scoped rule matching (meet.google.com bug)', () => {
  const rule = hostRule('meet.google.com');
  const rules = [rule];

  it('BLOCKS the exact host', () => {
    expect(matchesNoCaptureRules({ url: 'https://meet.google.com/abc-defg-hij' }, rules)).toBe(true);
  });

  it('BLOCKS its own subdomains', () => {
    expect(matchesNoCaptureRules({ url: 'https://sub.meet.google.com/x' }, rules)).toBe(true);
  });

  it('ALLOWS the parent registrable domain (google.com)', () => {
    expect(matchesNoCaptureRules({ url: 'https://google.com/search?q=x' }, rules)).toBe(false);
    expect(matchesNoCaptureRules({ url: 'https://www.google.com/search?q=x' }, rules)).toBe(false);
  });

  it('ALLOWS sibling hosts (mail.google.com, docs.google.com)', () => {
    expect(matchesNoCaptureRules({ url: 'https://mail.google.com/mail/u/0' }, rules)).toBe(false);
    expect(matchesNoCaptureRules({ url: 'https://docs.google.com/document/d/1' }, rules)).toBe(
      false,
    );
  });

  it('ALLOWS a label-boundary false-friend host (meetxgoogle.com)', () => {
    expect(matchesNoCaptureRules({ url: 'https://meetxgoogle.com/abc' }, rules)).toBe(false);
  });

  it('returns the matched host rule so the UI can name the site', () => {
    expect(firstMatchingNoCaptureRule({ url: 'https://meet.google.com/x' }, rules)).toBe(rule);
    expect(noCaptureRuleDisplayLabel(rule)).toBe('meet.google.com');
  });
});

describe('legacy family-wide rule still honored (back-compat)', () => {
  it('a domain rule with NO host keeps eTLD+1-family semantics', () => {
    const rules = [domainRule('google.com')];
    // Family-wide: every google.com host matches (the pre-fix behavior,
    // preserved so no stored rule silently loosens on load).
    expect(matchesNoCaptureRules({ url: 'https://meet.google.com/x' }, rules)).toBe(true);
    expect(matchesNoCaptureRules({ url: 'https://mail.google.com/x' }, rules)).toBe(true);
    expect(matchesNoCaptureRules({ url: 'https://www.google.com/x' }, rules)).toBe(true);
    // …but a label-boundary false-friend eTLD+1 does NOT match.
    expect(matchesNoCaptureRules({ url: 'https://notgoogle.com/x' }, rules)).toBe(false);
  });
});

describe('host-scoped similar rule', () => {
  it('same-site arm is host-scoped (does not swallow the family)', () => {
    const rules = [similarHostRule('meet.google.com', ['account'])];
    expect(matchesNoCaptureRules({ url: 'https://meet.google.com/room' }, rules)).toBe(true);
    // The bare parent/sibling with no category-token hit is NOT blocked.
    expect(matchesNoCaptureRules({ url: 'https://mail.google.com/inbox' }, rules)).toBe(false);
    expect(matchesNoCaptureRules({ url: 'https://google.com/search' }, rules)).toBe(false);
  });

  it('cross-domain category-token matching is unchanged (intentional broadening)', () => {
    const rules = [similarHostRule('meet.google.com', ['account', 'billing'])];
    // A totally different site still matches when a token hits the path —
    // that is the whole point of a 'similar' rule and is opt-in.
    expect(matchesNoCaptureRules({ url: 'https://other-utility.com/account/pay' }, rules)).toBe(
      true,
    );
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

  it('reads a host-scoped rule as its host', () => {
    expect(noCaptureRuleDisplayLabel(hostRule('meet.google.com'))).toBe('meet.google.com');
  });

  it('falls back to the HOST (not the eTLD+1) when a host-scoped label is empty', () => {
    const rule: NoCaptureRule = { ...hostRule('meet.google.com'), label: '' };
    expect(noCaptureRuleDisplayLabel(rule)).toBe('meet.google.com');
  });
});

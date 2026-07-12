import { describe, expect, it } from 'vitest';

import {
  buildDomainTombstoneSet,
  isDomainTombstonePayload,
  registrableDomain,
  registrableDomainFromUrl,
  type DomainTombstonePayload,
} from './domainTombstone.js';

const domainTombstone = (domain: string): DomainTombstonePayload => ({
  payloadVersion: 1,
  kind: 'domain',
  domain,
  tombstonedAt: '2026-07-11T00:00:00.000Z',
});

const similarTombstone = (
  domain: string,
  categoryTokens: DomainTombstonePayload['categoryTokens'],
): DomainTombstonePayload => ({
  payloadVersion: 1,
  kind: 'similar',
  domain,
  ...(categoryTokens === undefined ? {} : { categoryTokens }),
  tombstonedAt: '2026-07-11T00:00:00.000Z',
});

describe('registrableDomain (companion)', () => {
  it('collapses subdomains and handles multi-part TLDs', () => {
    expect(registrableDomain('secure.login.pge.com')).toBe('pge.com');
    expect(registrableDomain('www.hsbc.co.uk')).toBe('hsbc.co.uk');
    expect(registrableDomainFromUrl('https://www.pge.com/account')).toBe('pge.com');
  });
});

describe('isDomainTombstonePayload', () => {
  it('accepts a valid domain payload', () => {
    expect(isDomainTombstonePayload(domainTombstone('pge.com'))).toBe(true);
  });
  it('accepts a valid similar payload with tokens', () => {
    expect(isDomainTombstonePayload(similarTombstone('pge.com', ['account', 'billing']))).toBe(true);
  });
  it('rejects bad kind / missing domain / bad tokens', () => {
    expect(isDomainTombstonePayload({ payloadVersion: 1, kind: 'nope', domain: 'x', tombstonedAt: 't' })).toBe(false);
    expect(isDomainTombstonePayload({ payloadVersion: 1, kind: 'domain', domain: '', tombstonedAt: 't' })).toBe(false);
    expect(
      isDomainTombstonePayload({
        payloadVersion: 1,
        kind: 'similar',
        domain: 'x',
        categoryTokens: ['bogus'],
        tombstonedAt: 't',
      }),
    ).toBe(false);
  });
});

describe('buildDomainTombstoneSet.matchesPage', () => {
  it('empty set matches nothing', () => {
    const set = buildDomainTombstoneSet([]);
    expect(set.isEmpty).toBe(true);
    expect(set.matchesPage({ url: 'https://pge.com/x' })).toBe(false);
  });

  it('domain tombstone matches the eTLD+1 family', () => {
    const set = buildDomainTombstoneSet([domainTombstone('pge.com')]);
    expect(set.matchesPage({ url: 'https://www.pge.com/en/account' })).toBe(true);
    expect(set.matchesPage({ url: 'https://other.com/x' })).toBe(false);
  });

  it('matchesDomain works on a bare domain', () => {
    const set = buildDomainTombstoneSet([domainTombstone('pge.com')]);
    expect(set.matchesDomain('pge.com')).toBe(true);
    expect(set.matchesDomain('other.com')).toBe(false);
  });

  it('similar tombstone matches cross-domain on a path token', () => {
    const set = buildDomainTombstoneSet([similarTombstone('pge.com', ['account', 'billing'])]);
    expect(set.matchesPage({ url: 'https://other-utility.com/account/pay' })).toBe(true);
    expect(set.matchesPage({ url: 'https://news.com/story' })).toBe(false);
  });

  it('similar tombstone does not match a bare-domain-only token page', () => {
    const set = buildDomainTombstoneSet([similarTombstone('pge.com', ['account'])]);
    expect(set.matchesPage({ url: 'https://myaccount.other.com/home' })).toBe(false);
  });

  it('page with no URL never matches', () => {
    const set = buildDomainTombstoneSet([domainTombstone('pge.com')]);
    expect(set.matchesPage({ title: 'pge.com' })).toBe(false);
  });
});

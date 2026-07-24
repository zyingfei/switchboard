import { describe, expect, it } from 'vitest';

import { buildDomainTombstonePurgeBody } from './purgePayload';
import type { NoCaptureRule } from './noCaptureRules';

// Truth table for the "Purge captured data" call-site payload. The
// load-bearing correctness property: a host-scoped rule sends `host`
// (companion purges host + subdomains only — mail.google.com survives a
// meet.google.com purge); a legacy host-less rule sends only `domain`
// (companion keeps eTLD+1-family behavior). See purgePayload.ts.

const domainRule = (over: Partial<NoCaptureRule> = {}): NoCaptureRule =>
  ({
    id: 'ncr_1',
    kind: 'domain',
    domain: 'google.com',
    host: 'meet.google.com',
    label: 'meet.google.com',
    createdAt: '2026-07-24T00:00:00.000Z',
    ...over,
  }) as NoCaptureRule;

describe('buildDomainTombstonePurgeBody — payload truth table', () => {
  it('host-scoped domain rule → sends host + domain (no tokens)', () => {
    const body = buildDomainTombstonePurgeBody(domainRule());
    expect(body).toEqual({
      kind: 'domain',
      domain: 'google.com',
      host: 'meet.google.com',
    });
    // Explicitly: a sibling-host rule sends its OWN host, not the family.
    expect(body.host).toBe('meet.google.com');
    expect('categoryTokens' in body).toBe(false);
  });

  it('sibling host under same eTLD+1 → sends its own distinct host', () => {
    const body = buildDomainTombstonePurgeBody(
      domainRule({ id: 'ncr_2', host: 'mail.google.com', label: 'mail.google.com' }),
    );
    expect(body).toEqual({
      kind: 'domain',
      domain: 'google.com',
      host: 'mail.google.com',
    });
  });

  it('legacy host-less rule → sends only domain (eTLD+1 family, back-compat)', () => {
    const legacy = {
      id: 'ncr_legacy',
      kind: 'domain' as const,
      domain: 'google.com',
      label: 'google.com',
      createdAt: '2026-07-24T00:00:00.000Z',
    } as NoCaptureRule;
    const body = buildDomainTombstonePurgeBody(legacy);
    expect(body).toEqual({ kind: 'domain', domain: 'google.com' });
    expect('host' in body).toBe(false);
  });

  it('empty-string host is treated as absent (family scope)', () => {
    const body = buildDomainTombstonePurgeBody(domainRule({ host: '' }));
    expect('host' in body).toBe(false);
    expect(body.domain).toBe('google.com');
  });

  it('host-scoped similar rule → sends host + domain + categoryTokens', () => {
    const similar = {
      id: 'ncr_sim',
      kind: 'similar' as const,
      domain: 'chase.com',
      host: 'secure.chase.com',
      label: 'secure.chase.com',
      categoryTokens: ['banking', 'login'] as const,
      createdAt: '2026-07-24T00:00:00.000Z',
    } as NoCaptureRule;
    const body = buildDomainTombstonePurgeBody(similar);
    expect(body).toEqual({
      kind: 'similar',
      domain: 'chase.com',
      host: 'secure.chase.com',
      categoryTokens: ['banking', 'login'],
    });
  });

  it('legacy host-less similar rule → domain + categoryTokens, no host', () => {
    const similar = {
      id: 'ncr_sim2',
      kind: 'similar' as const,
      domain: 'chase.com',
      label: 'chase.com',
      categoryTokens: ['banking'] as const,
      createdAt: '2026-07-24T00:00:00.000Z',
    } as NoCaptureRule;
    const body = buildDomainTombstonePurgeBody(similar);
    expect(body).toEqual({
      kind: 'similar',
      domain: 'chase.com',
      categoryTokens: ['banking'],
    });
    expect('host' in body).toBe(false);
  });
});

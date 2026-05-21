import { describe, expect, it } from 'vitest';

import {
  compareCompanionIdentity,
  describeCompanionIdentity,
  identityWarningFor,
  parseCompanionIdentity,
  type CompanionIdentity,
} from './identity';

describe('parseCompanionIdentity', () => {
  it('parses a full /v1/version payload', () => {
    const id = parseCompanionIdentity({
      data: {
        companionVersion: '0.0.0',
        vaultRoot: '/Users/x/.sidetrack-vault',
        codePath: '/Users/x/checkout/dist/cli.js',
        pid: 4242,
        instanceLabel: 'daily',
        startedAt: '2026-05-20T10:00:00.000Z',
        requestId: 'req_1',
      },
    });
    expect(id).toEqual({
      companionVersion: '0.0.0',
      vaultRoot: '/Users/x/.sidetrack-vault',
      codePath: '/Users/x/checkout/dist/cli.js',
      pid: 4242,
      instanceLabel: 'daily',
      startedAt: '2026-05-20T10:00:00.000Z',
    });
  });

  it('parses a minimal payload (only companionVersion)', () => {
    expect(parseCompanionIdentity({ data: { companionVersion: '0.0.0' } })).toEqual({
      companionVersion: '0.0.0',
    });
  });

  it('returns null for unrecognizable payloads', () => {
    expect(parseCompanionIdentity(null)).toBeNull();
    expect(parseCompanionIdentity({})).toBeNull();
    expect(parseCompanionIdentity({ data: {} })).toBeNull();
    expect(parseCompanionIdentity({ data: { companionVersion: 42 } })).toBeNull();
  });
});

describe('compareCompanionIdentity', () => {
  const daily: CompanionIdentity = {
    companionVersion: '0.0.0',
    vaultRoot: '/Users/x/.sidetrack-vault',
    codePath: '/Users/x/daily/dist/cli.js',
    pid: 100,
  };

  it('first-attach when nothing is pinned', () => {
    expect(compareCompanionIdentity(null, daily)).toEqual({ kind: 'first-attach' });
  });

  it('match when vault + code path are identical (pid change ignored — a restart is normal)', () => {
    expect(compareCompanionIdentity(daily, { ...daily, pid: 999 })).toEqual({ kind: 'match' });
  });

  it('vault-mismatch when the vault differs (the core foot-gun)', () => {
    const testInstance: CompanionIdentity = {
      ...daily,
      vaultRoot: '/Users/x/.sidetrack-vault-test',
    };
    expect(compareCompanionIdentity(daily, testInstance)).toEqual({
      kind: 'vault-mismatch',
      pinnedVault: '/Users/x/.sidetrack-vault',
      currentVault: '/Users/x/.sidetrack-vault-test',
    });
  });

  it('vault mismatch dominates even when code path also changed', () => {
    const other: CompanionIdentity = {
      companionVersion: '0.0.0',
      vaultRoot: '/Users/x/.sidetrack-vault-test',
      codePath: '/Users/x/other-checkout/dist/cli.js',
    };
    expect(compareCompanionIdentity(daily, other).kind).toBe('vault-mismatch');
  });

  it('code-changed when vault matches but code path differs', () => {
    expect(
      compareCompanionIdentity(daily, { ...daily, codePath: '/Users/x/playground/dist/cli.js' }),
    ).toEqual({
      kind: 'code-changed',
      pinnedCode: '/Users/x/daily/dist/cli.js',
      currentCode: '/Users/x/playground/dist/cli.js',
    });
  });
});

describe('identityWarningFor', () => {
  it('blocking warning for a vault mismatch, naming both vaults', () => {
    const w = identityWarningFor({
      kind: 'vault-mismatch',
      pinnedVault: '/a',
      currentVault: '/b',
    });
    expect(w?.severity).toBe('blocking');
    expect(w?.message).toContain('/a');
    expect(w?.message).toContain('/b');
  });

  it('notice warning for a code change', () => {
    const w = identityWarningFor({
      kind: 'code-changed',
      pinnedCode: '/a/cli.js',
      currentCode: '/b/cli.js',
    });
    expect(w?.severity).toBe('notice');
    expect(w?.message).toContain('/b/cli.js');
  });

  it('no warning for match / first-attach', () => {
    expect(identityWarningFor({ kind: 'match' })).toBeNull();
    expect(identityWarningFor({ kind: 'first-attach' })).toBeNull();
  });
});

describe('describeCompanionIdentity', () => {
  it('summarizes the identity for the Health panel', () => {
    const s = describeCompanionIdentity({
      companionVersion: '0.0.0',
      vaultRoot: '/v',
      codePath: '/c/cli.js',
      pid: 7,
      instanceLabel: 'test',
    });
    expect(s).toContain('v0.0.0');
    expect(s).toContain('label=test');
    expect(s).toContain('pid=7');
    expect(s).toContain('vault=/v');
    expect(s).toContain('code=/c/cli.js');
  });
});

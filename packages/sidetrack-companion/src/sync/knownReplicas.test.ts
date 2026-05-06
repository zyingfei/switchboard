import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createKnownReplicasStore } from './knownReplicas.js';

describe('known-replicas store (TOFU)', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-known-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('first sight records the public key and accepts (fresh: true)', async () => {
    const store = createKnownReplicasStore(vaultRoot);
    const decision = await store.admit('peer-A', 'pubkey-A');
    expect(decision).toMatchObject({ kind: 'accept', fresh: true });
  });

  it('replays of the same key accept (fresh: false)', async () => {
    const store = createKnownReplicasStore(vaultRoot);
    await store.admit('peer-A', 'pubkey-A');
    const decision = await store.admit('peer-A', 'pubkey-A');
    expect(decision).toMatchObject({ kind: 'accept', fresh: false });
  });

  it('different key for a known replica id is rejected (no silent key swap)', async () => {
    const store = createKnownReplicasStore(vaultRoot);
    await store.admit('peer-A', 'pubkey-A');
    const decision = await store.admit('peer-A', 'pubkey-A-prime');
    expect(decision.kind).toBe('reject-key-mismatch');
    if (decision.kind === 'reject-key-mismatch') {
      expect(decision.storedPublicKey).toBe('pubkey-A');
    }
  });

  it('revoked replicas are rejected with the revocation timestamp', async () => {
    const store = createKnownReplicasStore(vaultRoot);
    await store.admit('peer-A', 'pubkey-A');
    await store.revoke('peer-A');
    const decision = await store.admit('peer-A', 'pubkey-A');
    expect(decision.kind).toBe('reject-revoked');
  });

  it('store survives reload (records persist to _BAC/.config/known-replicas.json)', async () => {
    const a = createKnownReplicasStore(vaultRoot);
    await a.admit('peer-A', 'pubkey-A');
    const b = createKnownReplicasStore(vaultRoot);
    const decision = await b.admit('peer-A', 'pubkey-A');
    expect(decision).toMatchObject({ kind: 'accept', fresh: false });
  });
});

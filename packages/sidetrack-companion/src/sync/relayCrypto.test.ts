import { describe, expect, it } from 'vitest';

import {
  deriveRendezvous,
  generateRendezvousSecret,
  generateReplicaKeyPair,
  openFrame,
  ReplayCache,
  sealFrame,
  signFrame,
  verifyFrame,
} from './relayCrypto.js';

describe('rendezvous derivation', () => {
  it('produces deterministic id + key for the same secret', () => {
    const secret = generateRendezvousSecret();
    const a = deriveRendezvous(secret);
    const b = deriveRendezvous(secret);
    expect(a.rendezvousId.equals(b.rendezvousId)).toBe(true);
    expect(a.rendezvousKey.equals(b.rendezvousKey)).toBe(true);
    expect(a.rendezvousId.length).toBe(16);
    expect(a.rendezvousKey.length).toBe(32);
  });

  it('produces different material for different secrets', () => {
    const a = deriveRendezvous(generateRendezvousSecret());
    const b = deriveRendezvous(generateRendezvousSecret());
    expect(a.rendezvousId.equals(b.rendezvousId)).toBe(false);
    expect(a.rendezvousKey.equals(b.rendezvousKey)).toBe(false);
  });

  it('rejects secrets shorter than 16 bytes', () => {
    expect(() => deriveRendezvous(Buffer.alloc(8))).toThrow();
  });
});

describe('seal / open round trip', () => {
  it('decrypts a sealed frame back to the original plaintext', () => {
    const { rendezvousId, rendezvousKey } = deriveRendezvous(generateRendezvousSecret());
    const sealed = sealFrame(rendezvousKey, rendezvousId, 'replica-A', Buffer.from('hello world'));
    const plaintext = openFrame(rendezvousKey, rendezvousId, 'replica-A', sealed);
    expect(plaintext.toString('utf8')).toBe('hello world');
  });

  it('fails to open if the AAD differs (different rendezvous or replica id)', () => {
    const { rendezvousId, rendezvousKey } = deriveRendezvous(generateRendezvousSecret());
    const sealed = sealFrame(rendezvousKey, rendezvousId, 'replica-A', Buffer.from('secret'));
    const otherId = Buffer.from('different16bytes');
    expect(() => openFrame(rendezvousKey, otherId, 'replica-A', sealed)).toThrow();
    expect(() => openFrame(rendezvousKey, rendezvousId, 'replica-B', sealed)).toThrow();
  });

  it('fails to open with a different rendezvous key', () => {
    const a = deriveRendezvous(generateRendezvousSecret());
    const b = deriveRendezvous(generateRendezvousSecret());
    const sealed = sealFrame(a.rendezvousKey, a.rendezvousId, 'replica-A', Buffer.from('x'));
    expect(() => openFrame(b.rendezvousKey, a.rendezvousId, 'replica-A', sealed)).toThrow();
  });
});

describe('Ed25519 sign / verify', () => {
  it('signs and verifies the canonical (replicaId, lamport, payload) tuple', () => {
    const keys = generateReplicaKeyPair();
    const sig = signFrame(keys.privateKey, 'replica-A', 42, Buffer.from('payload'));
    expect(verifyFrame(keys.publicKey, 'replica-A', 42, Buffer.from('payload'), sig)).toBe(true);
  });

  it('rejects a forged signature when any field is tampered', () => {
    const keys = generateReplicaKeyPair();
    const sig = signFrame(keys.privateKey, 'replica-A', 42, Buffer.from('payload'));
    expect(verifyFrame(keys.publicKey, 'replica-A', 42, Buffer.from('TAMPERED'), sig)).toBe(false);
    expect(verifyFrame(keys.publicKey, 'replica-A', 99, Buffer.from('payload'), sig)).toBe(false);
    expect(verifyFrame(keys.publicKey, 'replica-B', 42, Buffer.from('payload'), sig)).toBe(false);
  });

  it('rejects a signature made with a different private key', () => {
    const keysA = generateReplicaKeyPair();
    const keysB = generateReplicaKeyPair();
    const sig = signFrame(keysA.privateKey, 'r', 1, Buffer.from('p'));
    expect(verifyFrame(keysB.publicKey, 'r', 1, Buffer.from('p'), sig)).toBe(false);
  });
});

describe('replay cache', () => {
  it('accepts a fresh nonce once and rejects duplicates', () => {
    const cache = new ReplayCache();
    const nonce = Buffer.from('abcdef0123456789', 'hex');
    expect(cache.observe('A', nonce)).toBe(true);
    expect(cache.observe('A', nonce)).toBe(false);
  });

  it('treats nonces under different sender ids as independent', () => {
    const cache = new ReplayCache();
    const nonce = Buffer.from('abcdef0123456789', 'hex');
    expect(cache.observe('A', nonce)).toBe(true);
    expect(cache.observe('B', nonce)).toBe(true);
  });
});

import { createCipheriv, createDecipheriv, generateKeyPairSync, hkdfSync, randomBytes, sign as nodeSign, verify as nodeVerify, createPrivateKey, createPublicKey, } from 'node:crypto';
// End-to-end encryption primitives for the relay transport.
//
// Two-layer envelope:
//   1. Ed25519 signature over (replicaId || lamport || payload) using
//      the sender's per-replica private key. Receivers verify against
//      a known-replicas map, so a leaked rendezvous secret cannot
//      forge events from a specific replica without that replica's
//      private key.
//   2. AES-256-GCM AEAD with a key derived from the shared rendezvous
//      secret. The relay sees only `{rendezvous_id, sender_replica_id,
//      ciphertext, nonce}` — never plaintext, never the secret.
//
// HKDF-SHA256 splits the secret into:
//   - rendezvous_id (16 bytes) — opaque routing tag the relay sees.
//   - rendezvous_key (32 bytes) — symmetric AEAD key. Never leaves a
//     replica.
//
// AAD = rendezvous_id || sender_replica_id binds the ciphertext to
// its routing tags, so a rogue relay cannot replay a frame onto a
// different rendezvous and get a valid decrypt elsewhere.
const HKDF_SALT = Buffer.from('sidetrack-relay-v1', 'utf8');
const HKDF_INFO_ID = Buffer.from('rendezvous-id', 'utf8');
const HKDF_INFO_KEY = Buffer.from('rendezvous-key', 'utf8');
const RENDEZVOUS_ID_LEN = 16;
const RENDEZVOUS_KEY_LEN = 32;
const AES_NONCE_LEN = 12;
const AES_TAG_LEN = 16;
const REPLAY_CACHE_SIZE = 1024;
const hkdfBuffer = (secret, info, length) => {
    // hkdfSync returns ArrayBuffer in node 22; wrap.
    const out = hkdfSync('sha256', secret, HKDF_SALT, info, length);
    return Buffer.from(out);
};
export const deriveRendezvous = (rendezvousSecret) => {
    if (rendezvousSecret.length < 16) {
        throw new Error('rendezvous secret must be at least 16 bytes');
    }
    return {
        rendezvousId: hkdfBuffer(rendezvousSecret, HKDF_INFO_ID, RENDEZVOUS_ID_LEN),
        rendezvousKey: hkdfBuffer(rendezvousSecret, HKDF_INFO_KEY, RENDEZVOUS_KEY_LEN),
    };
};
export const generateRendezvousSecret = () => randomBytes(32);
export const generateReplicaKeyPair = () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    return {
        publicKey: extractRawEd25519Public(publicKey),
        privateKey: extractRawEd25519Private(privateKey),
    };
};
// Ed25519 SPKI DER prefix is 12 bytes; the last 32 bytes are the raw
// public key. PKCS#8 DER prefix is 16 bytes; the last 32 bytes are
// the raw private seed. Both are constants for Ed25519.
const SPKI_PREFIX_LEN = 12;
const PKCS8_PREFIX_LEN = 16;
const ED25519_KEY_LEN = 32;
export const extractRawEd25519Public = (spkiDer) => {
    if (spkiDer.length !== SPKI_PREFIX_LEN + ED25519_KEY_LEN) {
        throw new Error('unexpected Ed25519 SPKI length');
    }
    return spkiDer.subarray(SPKI_PREFIX_LEN);
};
export const extractRawEd25519Private = (pkcs8Der) => {
    if (pkcs8Der.length !== PKCS8_PREFIX_LEN + ED25519_KEY_LEN) {
        throw new Error('unexpected Ed25519 PKCS#8 length');
    }
    return pkcs8Der.subarray(PKCS8_PREFIX_LEN);
};
const SPKI_ED25519_HEADER = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_ED25519_HEADER = Buffer.from('302e020100300506032b657004220420', 'hex');
const wrapPublicKey = (raw) => {
    if (raw.length !== ED25519_KEY_LEN)
        throw new Error('bad Ed25519 public length');
    return createPublicKey({ key: Buffer.concat([SPKI_ED25519_HEADER, raw]), format: 'der', type: 'spki' });
};
const wrapPrivateKey = (raw) => {
    if (raw.length !== ED25519_KEY_LEN)
        throw new Error('bad Ed25519 private length');
    return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_HEADER, raw]), format: 'der', type: 'pkcs8' });
};
// Sign / verify the canonical event bytes. The canonical form (see
// `causal.ts`) covers every field that affects causal correctness —
// clientEventId, dot, deps, aggregateId, target, type, payload,
// acceptedAtMs — so a peer that knows the rendezvous secret cannot
// re-encrypt a tampered event while reusing a captured signature
// over a narrower scope. Receivers reconstruct the canonical bytes
// from the decrypted frame and verify against the trusted public
// key (NOT the key embedded in the frame; see runtime
// known-replicas wiring).
export const signCanonicalEvent = (privateKey, canonicalBytes) => nodeSign(null, canonicalBytes, wrapPrivateKey(privateKey));
export const verifyCanonicalEvent = (publicKey, canonicalBytes, signature) => nodeVerify(null, canonicalBytes, wrapPublicKey(publicKey), signature);
// Legacy narrow-scope sign/verify retained ONLY for the existing
// crypto-unit tests that exercise raw payloads. New callers must
// use `signCanonicalEvent` / `verifyCanonicalEvent`.
const signingPayload = (replicaId, lamport, payloadBytes) => {
    const idBytes = Buffer.from(replicaId, 'utf8');
    const lamportBytes = Buffer.alloc(8);
    lamportBytes.writeBigUInt64BE(BigInt(lamport), 0);
    return Buffer.concat([idBytes, lamportBytes, payloadBytes]);
};
export const signFrame = (privateKey, replicaId, lamport, payloadBytes) => {
    const message = signingPayload(replicaId, lamport, payloadBytes);
    return nodeSign(null, message, wrapPrivateKey(privateKey));
};
export const verifyFrame = (publicKey, replicaId, lamport, payloadBytes, signature) => {
    const message = signingPayload(replicaId, lamport, payloadBytes);
    return nodeVerify(null, message, wrapPublicKey(publicKey), signature);
};
const aad = (rendezvousId, senderReplicaId) => Buffer.concat([rendezvousId, Buffer.from(senderReplicaId, 'utf8')]);
export const sealFrame = (rendezvousKey, rendezvousId, senderReplicaId, plaintext) => {
    if (rendezvousKey.length !== RENDEZVOUS_KEY_LEN) {
        throw new Error('rendezvous key must be 32 bytes');
    }
    const nonce = randomBytes(AES_NONCE_LEN);
    const cipher = createCipheriv('aes-256-gcm', rendezvousKey, nonce, {
        authTagLength: AES_TAG_LEN,
    });
    cipher.setAAD(aad(rendezvousId, senderReplicaId));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return { nonce, ciphertext };
};
export const openFrame = (rendezvousKey, rendezvousId, senderReplicaId, sealed) => {
    if (rendezvousKey.length !== RENDEZVOUS_KEY_LEN) {
        throw new Error('rendezvous key must be 32 bytes');
    }
    if (sealed.nonce.length !== AES_NONCE_LEN) {
        throw new Error('nonce must be 12 bytes');
    }
    if (sealed.ciphertext.length < AES_TAG_LEN) {
        throw new Error('ciphertext too short for auth tag');
    }
    const tagOffset = sealed.ciphertext.length - AES_TAG_LEN;
    const body = sealed.ciphertext.subarray(0, tagOffset);
    const tag = sealed.ciphertext.subarray(tagOffset);
    const decipher = createDecipheriv('aes-256-gcm', rendezvousKey, sealed.nonce, {
        authTagLength: AES_TAG_LEN,
    });
    decipher.setAAD(aad(rendezvousId, senderReplicaId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
};
// Bounded LRU-ish replay cache keyed on (senderReplicaId, nonceHex).
// AES-GCM with a fresh random nonce is replay-safe in principle, but
// a defensive cache catches a mis-implemented sender or a buggy
// relay re-fanout. Eviction is a simple ring buffer.
export class ReplayCache {
    seen = new Map();
    order = [];
    observe(senderReplicaId, nonce) {
        const key = nonce.toString('hex');
        let set = this.seen.get(senderReplicaId);
        if (set === undefined) {
            set = new Set();
            this.seen.set(senderReplicaId, set);
        }
        if (set.has(key))
            return false;
        set.add(key);
        this.order.push({ sender: senderReplicaId, nonce: key });
        if (this.order.length > REPLAY_CACHE_SIZE) {
            const dropped = this.order.shift();
            if (dropped !== undefined) {
                const droppedSet = this.seen.get(dropped.sender);
                droppedSet?.delete(dropped.nonce);
                if (droppedSet?.size === 0)
                    this.seen.delete(dropped.sender);
            }
        }
        return true;
    }
}
//# sourceMappingURL=relayCrypto.js.map
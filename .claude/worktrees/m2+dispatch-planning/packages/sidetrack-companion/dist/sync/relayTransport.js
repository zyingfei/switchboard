import { WebSocket as WsWebSocket } from 'ws';
import { canonicalEventBytes, } from './causal.js';
import { decodeBytes, decodeFrame, encodeBytes, encodeFrame, PROTOCOL_VERSION, } from './relayProtocol.js';
import { deriveRendezvous, openFrame, ReplayCache, sealFrame, signCanonicalEvent, verifyCanonicalEvent, } from './relayCrypto.js';
// End-to-end encrypted relay transport.
//
// Publish path:
//   1. JSON-encode the AcceptedEvent.
//   2. Sign(replica_priv_key, replica_id || lamport || payload_bytes).
//   3. AEAD-seal payload with the rendezvous key. AAD =
//      rendezvous_id || replica_id binds the ciphertext to its
//      routing tags.
//   4. Send PUBLISH { rendezvous_id, replica_id, ciphertext, nonce,
//      signature, sender_public_key }.
//
// Subscribe path:
//   1. On EVENT, replay-cache check (sender_replica_id, nonce).
//   2. AEAD-open with the rendezvous key + AAD = (rendezvous_id ||
//      sender_replica_id).
//   3. Verify signature against the embedded sender_public_key.
//   4. Validate that the decrypted payload's replicaId matches
//      sender_replica_id.
//   5. JSON-parse and emit to subscribers.
//
// The relay never sees plaintext, never sees the rendezvous key,
// never sees a private key.
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
export const createRelayTransport = (options) => {
    const { rendezvousId, rendezvousKey } = deriveRendezvous(options.rendezvousSecret);
    const rendezvousIdBase64 = encodeBytes(rendezvousId);
    const senderPublicKeyBase64 = encodeBytes(options.localKeyPair.publicKey);
    const replayCache = new ReplayCache();
    const random = options.random ?? Math.random;
    const log = options.logger ?? (() => undefined);
    const subscribers = new Set();
    const pendingPublishes = [];
    let socket = null;
    let connecting = false;
    let consecutiveFailures = 0;
    let stopped = false;
    let subscribed = false;
    // Health surface: track when we last had an OPEN socket so the
    // companion's /v1/system/health can distinguish "connected
    // recently" from "never connected" without reaching into ws
    // internals. Updated on the on('open') hook below.
    let lastConnectedAtMs = null;
    let lastDisconnectedAtMs = null;
    const ws = () => {
        if (options.fetchWebSocket !== undefined)
            return options.fetchWebSocket(options.relayUrl);
        return new WsWebSocket(options.relayUrl);
    };
    const sleep = (ms) => new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
    const computeBackoff = () => {
        const exponential = RECONNECT_MIN_MS * 2 ** Math.max(0, consecutiveFailures - 1);
        const capped = Math.min(exponential, RECONNECT_MAX_MS);
        const jitter = 1 + (random() * 2 - 1) * 0.25;
        return Math.round(capped * jitter);
    };
    const flushPending = () => {
        const open = socket;
        if (open?.readyState !== WsWebSocket.OPEN)
            return;
        while (pendingPublishes.length > 0) {
            const next = pendingPublishes.shift();
            if (next === undefined)
                return;
            try {
                open.send(next.frame);
            }
            catch {
                // Socket dying — push back and let the reconnect path retry.
                pendingPublishes.unshift(next);
                return;
            }
            next.resolve();
        }
    };
    const handleEvent = (frame) => {
        const nonce = decodeBytes(frame.nonce);
        if (!replayCache.observe(frame.sender_replica_id, nonce))
            return;
        let plaintext;
        try {
            plaintext = openFrame(rendezvousKey, rendezvousId, frame.sender_replica_id, {
                nonce,
                ciphertext: decodeBytes(frame.ciphertext),
            });
        }
        catch {
            log('warn', 'failed to decrypt relay frame; ignoring');
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(plaintext.toString('utf8'));
        }
        catch {
            log('warn', 'relay frame plaintext was not valid AcceptedEvent JSON');
            return;
        }
        if (parsed.dot.replicaId !== frame.sender_replica_id) {
            log('warn', 'relay frame replica_id mismatch with payload dot.replicaId');
            return;
        }
        const signature = decodeBytes(frame.signature);
        void (async () => {
            // Trust check: the frame's `sender_public_key` is advisory.
            // The store decides which key we actually trust for this
            // replica id (TOFU on first sight; reject on key mismatch
            // afterwards).
            const decision = await options.knownReplicas.admit(parsed.dot.replicaId, frame.sender_public_key);
            if (decision.kind === 'reject-key-mismatch') {
                log('warn', `relay frame from ${parsed.dot.replicaId} carries a public key that does not match the stored one; dropping`);
                return;
            }
            if (decision.kind === 'reject-revoked') {
                log('warn', `relay frame from revoked replica ${parsed.dot.replicaId}; dropping`);
                return;
            }
            // Verify against the TRUSTED key (= what the store has on
            // record), not the embedded frame key. The two are equal in
            // the accept branch but the assignment makes the trust source
            // explicit. The signature scope is the canonical event bytes
            // — clientEventId, dot, deps, aggregateId, target, type,
            // payload, acceptedAtMs — so a peer that knows the
            // rendezvous secret cannot tamper with any of those fields
            // while keeping the captured signature valid.
            const trustedPublicKey = decodeBytes(decision.record.publicKey);
            const ok = verifyCanonicalEvent(trustedPublicKey, canonicalEventBytes(parsed), signature);
            if (!ok) {
                log('warn', 'relay frame signature did not verify against the trusted public key');
                return;
            }
            for (const sub of subscribers) {
                if (sub.knownReplicas.size === 0 || sub.knownReplicas.has(parsed.dot.replicaId)) {
                    sub.onEvent(parsed.dot.replicaId, parsed);
                }
            }
        })().catch(() => undefined);
    };
    const handleFrame = (data) => {
        const buffer = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.isBuffer(data)
                ? data
                : Buffer.from(data);
        const frame = decodeFrame(buffer);
        if (frame === null)
            return;
        if (frame.kind === 'WELCOME' && !subscribed) {
            socket?.send(encodeFrame({
                kind: 'SUBSCRIBE',
                rendezvous_id: rendezvousIdBase64,
                replica_id: options.localReplicaId,
                sender_public_key: senderPublicKeyBase64,
            }));
            subscribed = true;
            flushPending();
            return;
        }
        if (frame.kind === 'EVENT') {
            handleEvent(frame);
            return;
        }
        if (frame.kind === 'ERROR') {
            log('warn', `relay returned ERROR: ${frame.code} ${frame.message}`);
            return;
        }
    };
    const connect = () => {
        if (stopped || connecting || socket?.readyState === WsWebSocket.OPEN)
            return;
        connecting = true;
        subscribed = false;
        try {
            const next = ws();
            socket = next;
            next.on('open', () => {
                consecutiveFailures = 0;
                lastConnectedAtMs = Date.now();
                try {
                    next.send(encodeFrame({ kind: 'HELLO', protocol_version: PROTOCOL_VERSION }));
                }
                catch {
                    // Surface via close.
                }
            });
            next.on('message', handleFrame);
            next.on('close', () => {
                if (stopped)
                    return;
                consecutiveFailures += 1;
                lastDisconnectedAtMs = Date.now();
                socket = null;
                subscribed = false;
                connecting = false;
                void sleep(computeBackoff()).then(() => {
                    connect();
                });
            });
            next.on('error', () => {
                // Close handler will run shortly; nothing to do here.
            });
        }
        finally {
            connecting = false;
        }
    };
    connect();
    const publishEvent = async (replicaId, event) => {
        if (replicaId !== event.dot.replicaId) {
            throw new Error('publishEvent replicaId must match event.dot.replicaId');
        }
        // Sign over the canonical event bytes (clientEventId, dot, deps,
        // aggregateId, target, type, payload, acceptedAtMs) so a peer
        // who knows the rendezvous secret cannot reuse a captured
        // signature against a tampered event.
        const canonical = canonicalEventBytes(event);
        const signature = signCanonicalEvent(options.localKeyPair.privateKey, canonical);
        const sealed = sealFrame(rendezvousKey, rendezvousId, event.dot.replicaId, Buffer.from(JSON.stringify(event), 'utf8'));
        const frame = encodeFrame({
            kind: 'PUBLISH',
            rendezvous_id: rendezvousIdBase64,
            replica_id: event.dot.replicaId,
            ciphertext: encodeBytes(sealed.ciphertext),
            nonce: encodeBytes(sealed.nonce),
            signature: encodeBytes(signature),
            sender_public_key: senderPublicKeyBase64,
        });
        await new Promise((resolve) => {
            pendingPublishes.push({ frame, resolve });
            flushPending();
        });
    };
    const subscribePeers = (knownReplicas, onEvent) => {
        const entry = { knownReplicas, onEvent };
        subscribers.add(entry);
        if (socket === null) {
            connect();
        }
        return () => {
            subscribers.delete(entry);
        };
    };
    const stop = () => {
        stopped = true;
        socket?.close();
        socket = null;
    };
    // Expose stop for runtime shutdown wiring.
    Object.defineProperty(publishEvent, 'stop', { value: stop });
    // Health surface for /v1/system/health.sync. The runtime reads
    // this each request, so it's a snapshot — `connected` is "the
    // socket is currently OPEN," not "we've ever connected." Use
    // lastConnectedAtMs for the "we WERE connected" affordance.
    const getStatus = () => ({
        connected: socket?.readyState === WsWebSocket.OPEN,
        consecutiveFailures,
        pendingPublishes: pendingPublishes.length,
        ...(lastConnectedAtMs === null ? {} : { lastConnectedAtMs }),
        ...(lastDisconnectedAtMs === null ? {} : { lastDisconnectedAtMs }),
    });
    Object.defineProperty(publishEvent, 'getStatus', { value: getStatus });
    return { publishEvent, subscribePeers };
};
export const getRelayTransportStatus = (transport) => {
    const get = transport.publishEvent
        .getStatus;
    return typeof get === 'function' ? get() : null;
};
export const stopRelayTransport = (transport) => {
    const stop = transport.publishEvent.stop;
    if (typeof stop === 'function')
        stop();
};
//# sourceMappingURL=relayTransport.js.map
import { WebSocket as WsWebSocket } from 'ws';

import {
  type AcceptedEvent,
  canonicalEventBytes,
} from './causal.js';
import type { KnownReplicasStore } from './knownReplicas.js';
import {
  decodeBytes,
  decodeFrame,
  encodeBytes,
  encodeFrame,
  PROTOCOL_VERSION,
  type EventFrame,
} from './relayProtocol.js';
import {
  deriveRendezvous,
  openFrame,
  ReplayCache,
  sealFrame,
  signCanonicalEvent,
  verifyCanonicalEvent,
  type ReplicaKeyPair,
} from './relayCrypto.js';
import type { LogTransport } from './transport.js';

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

export interface RelayTransportOptions {
  readonly relayUrl: string;
  readonly rendezvousSecret: Buffer;
  readonly localReplicaId: string;
  readonly localKeyPair: ReplicaKeyPair;
  // Required: the trust store decides which peer replicas may
  // contribute events. Without it the receive path would have to
  // accept whatever public key the frame carries, which makes
  // signatures meaningless against a peer who knows the rendezvous
  // secret. The store implements TOFU + revocation; pass an in-
  // memory stub for unit tests.
  readonly knownReplicas: KnownReplicasStore;
  readonly fetchWebSocket?: (url: string) => WsWebSocket;
  readonly random?: () => number;
  readonly logger?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export const createRelayTransport = (options: RelayTransportOptions): LogTransport => {
  const { rendezvousId, rendezvousKey } = deriveRendezvous(options.rendezvousSecret);
  const rendezvousIdBase64 = encodeBytes(rendezvousId);
  const senderPublicKeyBase64 = encodeBytes(options.localKeyPair.publicKey);
  const replayCache = new ReplayCache();
  const random = options.random ?? Math.random;
  const log = options.logger ?? (() => undefined);

  const subscribers = new Set<{
    readonly knownReplicas: ReadonlySet<string>;
    readonly onEvent: (replicaId: string, event: AcceptedEvent) => void;
  }>();

  const pendingPublishes: { frame: ReturnType<typeof encodeFrame>; resolve: () => void }[] = [];

  let socket: WsWebSocket | null = null;
  let connecting = false;
  let consecutiveFailures = 0;
  let stopped = false;
  let subscribed = false;

  const ws = (): WsWebSocket => {
    if (options.fetchWebSocket !== undefined) return options.fetchWebSocket(options.relayUrl);
    return new WsWebSocket(options.relayUrl);
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

  const computeBackoff = (): number => {
    const exponential = RECONNECT_MIN_MS * 2 ** Math.max(0, consecutiveFailures - 1);
    const capped = Math.min(exponential, RECONNECT_MAX_MS);
    const jitter = 1 + (random() * 2 - 1) * 0.25;
    return Math.round(capped * jitter);
  };

  const flushPending = (): void => {
    const open = socket;
    if (open?.readyState !== WsWebSocket.OPEN) return;
    while (pendingPublishes.length > 0) {
      const next = pendingPublishes.shift();
      if (next === undefined) return;
      try {
        open.send(next.frame);
      } catch {
        // Socket dying — push back and let the reconnect path retry.
        pendingPublishes.unshift(next);
        return;
      }
      next.resolve();
    }
  };

  const handleEvent = (frame: EventFrame): void => {
    const nonce = decodeBytes(frame.nonce);
    if (!replayCache.observe(frame.sender_replica_id, nonce)) return;
    let plaintext: Buffer;
    try {
      plaintext = openFrame(rendezvousKey, rendezvousId, frame.sender_replica_id, {
        nonce,
        ciphertext: decodeBytes(frame.ciphertext),
      });
    } catch {
      log('warn', 'failed to decrypt relay frame; ignoring');
      return;
    }
    let parsed: AcceptedEvent;
    try {
      parsed = JSON.parse(plaintext.toString('utf8')) as AcceptedEvent;
    } catch {
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
      const decision = await options.knownReplicas.admit(
        parsed.dot.replicaId,
        frame.sender_public_key,
      );
      if (decision.kind === 'reject-key-mismatch') {
        log(
          'warn',
          `relay frame from ${parsed.dot.replicaId} carries a public key that does not match the stored one; dropping`,
        );
        return;
      }
      if (decision.kind === 'reject-revoked') {
        log(
          'warn',
          `relay frame from revoked replica ${parsed.dot.replicaId}; dropping`,
        );
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

  const handleFrame = (data: WsWebSocket.RawData): void => {
    const buffer = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data);
    const frame = decodeFrame(buffer);
    if (frame === null) return;
    if (frame.kind === 'WELCOME' && !subscribed) {
      socket?.send(
        encodeFrame({
          kind: 'SUBSCRIBE',
          rendezvous_id: rendezvousIdBase64,
          replica_id: options.localReplicaId,
          sender_public_key: senderPublicKeyBase64,
        }),
      );
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

  const connect = (): void => {
    if (stopped || connecting || socket?.readyState === WsWebSocket.OPEN) return;
    connecting = true;
    subscribed = false;
    try {
      const next = ws();
      socket = next;
      next.on('open', () => {
        consecutiveFailures = 0;
        try {
          next.send(encodeFrame({ kind: 'HELLO', protocol_version: PROTOCOL_VERSION }));
        } catch {
          // Surface via close.
        }
      });
      next.on('message', handleFrame);
      next.on('close', () => {
        if (stopped) return;
        consecutiveFailures += 1;
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
    } finally {
      connecting = false;
    }
  };

  connect();

  const publishEvent = async (replicaId: string, event: AcceptedEvent): Promise<void> => {
    if (replicaId !== event.dot.replicaId) {
      throw new Error('publishEvent replicaId must match event.dot.replicaId');
    }
    // Sign over the canonical event bytes (clientEventId, dot, deps,
    // aggregateId, target, type, payload, acceptedAtMs) so a peer
    // who knows the rendezvous secret cannot reuse a captured
    // signature against a tampered event.
    const canonical = canonicalEventBytes(event);
    const signature = signCanonicalEvent(options.localKeyPair.privateKey, canonical);
    const sealed = sealFrame(
      rendezvousKey,
      rendezvousId,
      event.dot.replicaId,
      Buffer.from(JSON.stringify(event), 'utf8'),
    );
    const frame = encodeFrame({
      kind: 'PUBLISH',
      rendezvous_id: rendezvousIdBase64,
      replica_id: event.dot.replicaId,
      ciphertext: encodeBytes(sealed.ciphertext),
      nonce: encodeBytes(sealed.nonce),
      signature: encodeBytes(signature),
      sender_public_key: senderPublicKeyBase64,
    });
    await new Promise<void>((resolve) => {
      pendingPublishes.push({ frame, resolve });
      flushPending();
    });
  };

  const subscribePeers = (
    knownReplicas: ReadonlySet<string>,
    onEvent: (replicaId: string, event: AcceptedEvent) => void,
  ): (() => void) => {
    const entry = { knownReplicas, onEvent };
    subscribers.add(entry);
    if (socket === null) {
      connect();
    }
    return () => {
      subscribers.delete(entry);
    };
  };

  const stop = (): void => {
    stopped = true;
    socket?.close();
    socket = null;
  };
  // Expose stop for runtime shutdown wiring.
  Object.defineProperty(publishEvent, 'stop', { value: stop });

  return { publishEvent, subscribePeers };
};

export const stopRelayTransport = (transport: LogTransport): void => {
  const stop = (transport.publishEvent as unknown as { stop?: () => void }).stop;
  if (typeof stop === 'function') stop();
};

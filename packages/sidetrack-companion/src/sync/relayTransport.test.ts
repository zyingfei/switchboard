import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcceptedEvent } from './causal.js';
import { generateRendezvousSecret, generateReplicaKeyPair } from './relayCrypto.js';
import { createRelayTransport, stopRelayTransport } from './relayTransport.js';
import { startRelayServer, type StartedRelayServer } from './relayServer.js';

describe('relay transport (integration)', () => {
  let server: StartedRelayServer;

  beforeEach(async () => {
    server = await startRelayServer({ port: 0 });
  });

  afterEach(async () => {
    await server.close();
  });

  const eventFor = (
    replicaId: string,
    seq: number,
    text: string,
  ): AcceptedEvent => ({
    clientEventId: `${replicaId}.${String(seq)}`,
    dot: { replicaId, seq },
    deps: {},
    aggregateId: 'agg',
    type: 'review-draft.span.added',
    payload: { spanId: 's1', text },
    acceptedAtMs: Date.now(),
  });

  it('replica B receives the event A published, with signature verification', async () => {
    const secret = generateRendezvousSecret();
    const keysA = generateReplicaKeyPair();
    const keysB = generateReplicaKeyPair();
    const url = `ws://${server.host}:${String(server.port)}/`;
    const a = createRelayTransport({
      relayUrl: url,
      rendezvousSecret: secret,
      localReplicaId: 'A',
      localKeyPair: keysA,
    });
    const b = createRelayTransport({
      relayUrl: url,
      rendezvousSecret: secret,
      localReplicaId: 'B',
      localKeyPair: keysB,
    });
    const received: AcceptedEvent[] = [];
    b.subscribePeers(new Set(), (_replicaId, event) => {
      received.push(event);
    });
    // Allow B's HELLO/SUBSCRIBE handshake to complete.
    await new Promise((resolve) => setTimeout(resolve, 100));

    await a.publishEvent('A', eventFor('A', 1, 'first from A'));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(received).toHaveLength(1);
    expect(received[0]?.dot).toEqual({ replicaId: 'A', seq: 1 });
    expect(received[0]?.payload).toEqual({ spanId: 's1', text: 'first from A' });

    stopRelayTransport(a);
    stopRelayTransport(b);
  });

  it('a transport with the wrong rendezvous secret cannot decrypt peer events', async () => {
    const secretA = generateRendezvousSecret();
    const secretB = generateRendezvousSecret();
    const keysA = generateReplicaKeyPair();
    const keysB = generateReplicaKeyPair();
    const url = `ws://${server.host}:${String(server.port)}/`;
    const a = createRelayTransport({
      relayUrl: url,
      rendezvousSecret: secretA,
      localReplicaId: 'A',
      localKeyPair: keysA,
    });
    const b = createRelayTransport({
      relayUrl: url,
      rendezvousSecret: secretB, // mismatch — different rendezvous id
      localReplicaId: 'B',
      localKeyPair: keysB,
    });
    const received: AcceptedEvent[] = [];
    b.subscribePeers(new Set(), (_replicaId, event) => {
      received.push(event);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await a.publishEvent('A', eventFor('A', 1, 'no-decrypt'));
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Different rendezvous_id means the relay routes to a different
    // bucket; B is subscribed to its own (empty) bucket.
    expect(received).toEqual([]);

    stopRelayTransport(a);
    stopRelayTransport(b);
  });
});

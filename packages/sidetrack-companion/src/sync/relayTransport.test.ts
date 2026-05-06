import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcceptedEvent } from './causal.js';
import { createKnownReplicasStore } from './knownReplicas.js';
import { generateRendezvousSecret, generateReplicaKeyPair } from './relayCrypto.js';
import { createRelayTransport, stopRelayTransport } from './relayTransport.js';
import { startRelayServer, type StartedRelayServer } from './relayServer.js';

describe('relay transport (integration)', () => {
  let server: StartedRelayServer;
  let vaultA: string;
  let vaultB: string;

  beforeEach(async () => {
    server = await startRelayServer({ port: 0 });
    vaultA = await mkdtemp(join(tmpdir(), 'sidetrack-relay-a-'));
    vaultB = await mkdtemp(join(tmpdir(), 'sidetrack-relay-b-'));
  });

  afterEach(async () => {
    await server.close();
    await rm(vaultA, { recursive: true, force: true });
    await rm(vaultB, { recursive: true, force: true });
  });

  const eventFor = (replicaId: string, seq: number, text: string): AcceptedEvent => ({
    clientEventId: `${replicaId}.${String(seq)}`,
    dot: { replicaId, seq },
    deps: {},
    aggregateId: 'agg',
    type: 'review-draft.span.added',
    payload: { spanId: 's1', text },
    acceptedAtMs: 1_700_000_000_000,
  });

  it('replica B receives the event A published; signature verifies against the known-replicas store (TOFU)', async () => {
    const secret = generateRendezvousSecret();
    const keysA = generateReplicaKeyPair();
    const keysB = generateReplicaKeyPair();
    const url = `ws://${server.host}:${String(server.port)}/`;
    const a = createRelayTransport({
      relayUrl: url,
      rendezvousSecret: secret,
      localReplicaId: 'A',
      localKeyPair: keysA,
      knownReplicas: createKnownReplicasStore(vaultA),
    });
    const b = createRelayTransport({
      relayUrl: url,
      rendezvousSecret: secret,
      localReplicaId: 'B',
      localKeyPair: keysB,
      knownReplicas: createKnownReplicasStore(vaultB),
    });
    const received: AcceptedEvent[] = [];
    b.subscribePeers(new Set(), (_replicaId, event) => {
      received.push(event);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    await a.publishEvent('A', eventFor('A', 1, 'first from A'));
    await new Promise((resolve) => setTimeout(resolve, 100));

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
      knownReplicas: createKnownReplicasStore(vaultA),
    });
    const b = createRelayTransport({
      relayUrl: url,
      rendezvousSecret: secretB,
      localReplicaId: 'B',
      localKeyPair: keysB,
      knownReplicas: createKnownReplicasStore(vaultB),
    });
    const received: AcceptedEvent[] = [];
    b.subscribePeers(new Set(), (_replicaId, event) => {
      received.push(event);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await a.publishEvent('A', eventFor('A', 1, 'no-decrypt'));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(received).toEqual([]);

    stopRelayTransport(a);
    stopRelayTransport(b);
  });

  it("rejects events from a known replica that suddenly publishes a different public key (no silent key swap)", async () => {
    const secret = generateRendezvousSecret();
    const keysA1 = generateReplicaKeyPair();
    const keysA2 = generateReplicaKeyPair(); // attacker
    const keysB = generateReplicaKeyPair();
    const storeB = createKnownReplicasStore(vaultB);
    const url = `ws://${server.host}:${String(server.port)}/`;
    const honest = createRelayTransport({
      relayUrl: url,
      rendezvousSecret: secret,
      localReplicaId: 'A',
      localKeyPair: keysA1,
      knownReplicas: createKnownReplicasStore(vaultA),
    });
    const b = createRelayTransport({
      relayUrl: url,
      rendezvousSecret: secret,
      localReplicaId: 'B',
      localKeyPair: keysB,
      knownReplicas: storeB,
    });
    const received: AcceptedEvent[] = [];
    b.subscribePeers(new Set(), (_replicaId, event) => {
      received.push(event);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // First event: B's store records the honest key for A.
    await honest.publishEvent('A', eventFor('A', 1, 'first'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toHaveLength(1);

    // Attacker reuses replica id A but signs with a different key.
    const attacker = createRelayTransport({
      relayUrl: url,
      rendezvousSecret: secret,
      localReplicaId: 'A',
      localKeyPair: keysA2,
      knownReplicas: createKnownReplicasStore(vaultA),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await attacker.publishEvent('A', eventFor('A', 2, 'forged'));
    await new Promise((resolve) => setTimeout(resolve, 120));
    // The attacker's frame must NOT be delivered to B — its public
    // key doesn't match the one the store learned via TOFU.
    expect(received).toHaveLength(1);

    stopRelayTransport(honest);
    stopRelayTransport(attacker);
    stopRelayTransport(b);
  });
});

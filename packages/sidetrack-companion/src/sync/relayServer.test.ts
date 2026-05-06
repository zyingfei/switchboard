import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket as WsWebSocket } from 'ws';

import {
  decodeFrame,
  encodeFrame,
  type EventFrame,
  PROTOCOL_VERSION,
  type RelayFrame,
} from './relayProtocol.js';
import { startRelayServer, type StartedRelayServer } from './relayServer.js';

interface TestClient {
  readonly socket: WsWebSocket;
  readonly received: RelayFrame[];
  readonly waitFor: (predicate: (frame: RelayFrame) => boolean) => Promise<RelayFrame>;
  readonly close: () => Promise<void>;
}

const connectClient = async (host: string, port: number): Promise<TestClient> => {
  const socket = new WsWebSocket(`ws://${host}:${String(port)}/`);
  const received: RelayFrame[] = [];
  const waiters: {
    predicate: (frame: RelayFrame) => boolean;
    resolve: (frame: RelayFrame) => void;
  }[] = [];
  socket.on('message', (data, isBinary) => {
    const buffer = isBinary
      ? Buffer.from(data as ArrayBufferLike)
      : Buffer.from(data as ArrayBufferLike);
    const frame = decodeFrame(buffer);
    if (frame === null) return;
    received.push(frame);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      resolve();
    });
    socket.once('error', reject);
  });
  return {
    socket,
    received,
    waitFor: (predicate) =>
      new Promise<RelayFrame>((resolve) => {
        const existing = received.find(predicate);
        if (existing !== undefined) {
          resolve(existing);
          return;
        }
        waiters.push({ predicate, resolve });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        if (socket.readyState === WsWebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.once('close', () => {
          resolve();
        });
        socket.close();
      }),
  };
};

describe('relay server', () => {
  let server: StartedRelayServer;

  beforeEach(async () => {
    server = await startRelayServer({ port: 0 });
  });

  afterEach(async () => {
    await server.close();
  });

  it('replies to HELLO with WELCOME', async () => {
    const client = await connectClient(server.host, server.port);
    client.socket.send(encodeFrame({ kind: 'HELLO', protocol_version: PROTOCOL_VERSION }));
    const welcome = await client.waitFor((frame) => frame.kind === 'WELCOME');
    expect(welcome.kind).toBe('WELCOME');
    await client.close();
  });

  it('fans out PUBLISH events to all other subscribers on the same rendezvous', async () => {
    const a = await connectClient(server.host, server.port);
    const b = await connectClient(server.host, server.port);
    for (const c of [a, b]) {
      c.socket.send(encodeFrame({ kind: 'HELLO', protocol_version: PROTOCOL_VERSION }));
    }
    a.socket.send(
      encodeFrame({
        kind: 'SUBSCRIBE',
        rendezvous_id: 'rzv-shared',
        replica_id: 'A',
        sender_public_key: 'pkA',
      }),
    );
    b.socket.send(
      encodeFrame({
        kind: 'SUBSCRIBE',
        rendezvous_id: 'rzv-shared',
        replica_id: 'B',
        sender_public_key: 'pkB',
      }),
    );
    // Allow the SUBSCRIBE bookkeeping to settle.
    await new Promise((resolve) => setTimeout(resolve, 30));

    a.socket.send(
      encodeFrame({
        kind: 'PUBLISH',
        rendezvous_id: 'rzv-shared',
        replica_id: 'A',
        ciphertext: 'cc-payload',
        nonce: 'nonce',
        signature: 'sig',
        sender_public_key: 'pkA',
      }),
    );

    const event = (await b.waitFor((frame) => frame.kind === 'EVENT')) as EventFrame;
    expect(event.sender_replica_id).toBe('A');
    expect(event.ciphertext).toBe('cc-payload');
    // Sender should NOT receive its own publish back.
    expect(a.received.find((frame) => frame.kind === 'EVENT')).toBeUndefined();

    await Promise.all([a.close(), b.close()]);
  });

  it('replays buffered events to a late subscriber', async () => {
    const a = await connectClient(server.host, server.port);
    a.socket.send(encodeFrame({ kind: 'HELLO', protocol_version: PROTOCOL_VERSION }));
    a.socket.send(
      encodeFrame({
        kind: 'SUBSCRIBE',
        rendezvous_id: 'rzv-late',
        replica_id: 'A',
        sender_public_key: 'pkA',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    a.socket.send(
      encodeFrame({
        kind: 'PUBLISH',
        rendezvous_id: 'rzv-late',
        replica_id: 'A',
        ciphertext: 'first',
        nonce: 'nonce-1',
        signature: 'sig',
        sender_public_key: 'pkA',
      }),
    );
    a.socket.send(
      encodeFrame({
        kind: 'PUBLISH',
        rendezvous_id: 'rzv-late',
        replica_id: 'A',
        ciphertext: 'second',
        nonce: 'nonce-2',
        signature: 'sig',
        sender_public_key: 'pkA',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    const b = await connectClient(server.host, server.port);
    b.socket.send(encodeFrame({ kind: 'HELLO', protocol_version: PROTOCOL_VERSION }));
    b.socket.send(
      encodeFrame({
        kind: 'SUBSCRIBE',
        rendezvous_id: 'rzv-late',
        replica_id: 'B',
        sender_public_key: 'pkB',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const events = b.received.filter((frame): frame is EventFrame => frame.kind === 'EVENT');
    expect(events.map((event) => event.ciphertext)).toEqual(['first', 'second']);

    await Promise.all([a.close(), b.close()]);
  });

  it('rejects PUBLISH that exceeds rate limit', async () => {
    const tinyServer = await startRelayServer({ port: 0, ratePerHour: 2 });
    try {
      const a = await connectClient(tinyServer.host, tinyServer.port);
      a.socket.send(encodeFrame({ kind: 'HELLO', protocol_version: PROTOCOL_VERSION }));
      a.socket.send(
        encodeFrame({
          kind: 'SUBSCRIBE',
          rendezvous_id: 'rzv-rate',
          replica_id: 'A',
          sender_public_key: 'pkA',
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      const send = (idx: number) =>
        { a.socket.send(
          encodeFrame({
            kind: 'PUBLISH',
            rendezvous_id: 'rzv-rate',
            replica_id: 'A',
            ciphertext: `c${String(idx)}`,
            nonce: `n${String(idx)}`,
            signature: 'sig',
            sender_public_key: 'pkA',
          }),
        ); };
      send(0);
      send(1);
      send(2);
      const error = await a.waitFor((frame) => frame.kind === 'ERROR');
      expect(error.kind).toBe('ERROR');
      if (error.kind === 'ERROR') expect(error.code).toBe('RATE_LIMITED');
      await a.close();
    } finally {
      await tinyServer.close();
    }
  });
});

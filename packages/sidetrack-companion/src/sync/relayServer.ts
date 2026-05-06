import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  decodeFrame,
  encodeFrame,
  type EventFrame,
  PROTOCOL_VERSION,
  type PublishFrame,
  type SubscribeFrame,
} from './relayProtocol.js';

// Stateless event-fanout relay.
//
// What it knows: opaque routing tags (`rendezvous_id`), opaque
// `sender_replica_id`s, opaque ciphertexts, opaque signatures. What
// it does NOT know: rendezvous secrets, rendezvous keys, plaintext
// events, replica private keys, end-user identity.
//
// Per-rendezvous state is a bounded ring buffer (events) + a set of
// connected subscribers. Restart wipes both — peers reconcile via
// their local logs + the on-reconnect replay window.

const HEARTBEAT_INTERVAL_MS = 25_000;

export interface RelayServerOptions {
  readonly port?: number;
  readonly host?: string;
  readonly maxBufferEvents?: number;
  readonly maxBufferBytes?: number;
  readonly maxBufferAgeMs?: number;
  readonly maxEventBytes?: number;
  readonly ratePerHour?: number;
  readonly serverVersion?: string;
  readonly now?: () => number;
}

export interface StartedRelayServer {
  readonly port: number;
  readonly host: string;
  readonly close: () => Promise<void>;
}

interface BufferedEvent {
  readonly frame: EventFrame;
  readonly bytes: number;
  readonly storedAtMs: number;
}

interface RendezvousState {
  readonly buffer: BufferedEvent[];
  bytes: number;
  readonly subscribers: Set<RelaySocket>;
  // Rolling rate-limit window (one bucket per rendezvous, sized to
  // the configured ratePerHour). We track timestamps of the last
  // ratePerHour publishes; when we'd exceed the cap, we reject.
  readonly recentPublishesMs: number[];
}

interface RelaySocket {
  readonly socket: WebSocket;
  rendezvousId?: string;
  replicaId?: string;
  publicKey?: string;
  alive: boolean;
}

const sendError = (socket: WebSocket, code: string, message: string): void => {
  try {
    socket.send(encodeFrame({ kind: 'ERROR', code, message }));
  } catch {
    // Socket may already be torn down — drop on the floor.
  }
};

export const startRelayServer = async (
  options: RelayServerOptions = {},
): Promise<StartedRelayServer> => {
  const port = options.port ?? 0;
  const host = options.host ?? '127.0.0.1';
  const maxBufferEvents = options.maxBufferEvents ?? 1_000;
  const maxBufferBytes = options.maxBufferBytes ?? 100 * 1024 * 1024;
  const maxBufferAgeMs = options.maxBufferAgeMs ?? 24 * 60 * 60 * 1000;
  const maxEventBytes = options.maxEventBytes ?? 256 * 1024;
  const ratePerHour = options.ratePerHour ?? 1_000;
  const serverVersion = options.serverVersion ?? '0.0.0';
  const now = options.now ?? Date.now;

  const httpServer: HttpServer = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`relay ok\n`);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server: httpServer });

  const rendezvouses = new Map<string, RendezvousState>();

  const ensureRendezvous = (id: string): RendezvousState => {
    let state = rendezvouses.get(id);
    if (state === undefined) {
      state = {
        buffer: [],
        bytes: 0,
        subscribers: new Set(),
        recentPublishesMs: [],
      };
      rendezvouses.set(id, state);
    }
    return state;
  };

  const dropOldest = (state: RendezvousState): void => {
    const dropped = state.buffer.shift();
    if (dropped !== undefined) state.bytes -= dropped.bytes;
  };

  const trimBuffer = (state: RendezvousState): void => {
    const cutoff = now() - maxBufferAgeMs;
    while (state.buffer.length > 0) {
      const head = state.buffer[0];
      if (head === undefined || head.storedAtMs >= cutoff) break;
      dropOldest(state);
    }
    while (state.buffer.length > maxBufferEvents) {
      dropOldest(state);
    }
    while (state.bytes > maxBufferBytes && state.buffer.length > 0) {
      dropOldest(state);
    }
  };

  const enforceRate = (state: RendezvousState): boolean => {
    const cutoff = now() - 60 * 60 * 1000;
    while (state.recentPublishesMs.length > 0) {
      const head = state.recentPublishesMs[0];
      if (head === undefined || head >= cutoff) break;
      state.recentPublishesMs.shift();
    }
    if (state.recentPublishesMs.length >= ratePerHour) return false;
    state.recentPublishesMs.push(now());
    return true;
  };

  const bufferEvent = (state: RendezvousState, frame: EventFrame): void => {
    const bytes = encodeFrame(frame).length;
    state.buffer.push({ frame, bytes, storedAtMs: now() });
    state.bytes += bytes;
    trimBuffer(state);
  };

  const fanOut = (state: RendezvousState, frame: EventFrame, originator: RelaySocket): void => {
    const encoded = encodeFrame(frame);
    for (const sub of state.subscribers) {
      if (sub === originator) continue;
      try {
        sub.socket.send(encoded);
      } catch {
        // Subscriber's socket is broken; the disconnect handler will
        // tidy up.
      }
    }
  };

  const replayBuffer = (state: RendezvousState, target: RelaySocket): void => {
    trimBuffer(state);
    for (const buffered of state.buffer) {
      try {
        target.socket.send(encodeFrame(buffered.frame));
      } catch {
        // Target is gone — the close handler will clean up.
        return;
      }
    }
  };

  const handleSubscribe = (relay: RelaySocket, frame: SubscribeFrame): void => {
    relay.rendezvousId = frame.rendezvous_id;
    relay.replicaId = frame.replica_id;
    relay.publicKey = frame.sender_public_key;
    const state = ensureRendezvous(frame.rendezvous_id);
    state.subscribers.add(relay);
    replayBuffer(state, relay);
  };

  const handlePublish = (relay: RelaySocket, frame: PublishFrame): void => {
    if (relay.rendezvousId === undefined || relay.replicaId === undefined) {
      sendError(relay.socket, 'NOT_SUBSCRIBED', 'subscribe before publish');
      return;
    }
    if (frame.rendezvous_id !== relay.rendezvousId || frame.replica_id !== relay.replicaId) {
      sendError(relay.socket, 'IDENTITY_MISMATCH', 'publish must match subscribed identity');
      return;
    }
    const state = ensureRendezvous(frame.rendezvous_id);
    const candidateBytes =
      frame.ciphertext.length + frame.nonce.length + frame.signature.length + 256;
    if (candidateBytes > maxEventBytes) {
      sendError(relay.socket, 'EVENT_TOO_LARGE', `events must be ≤${String(maxEventBytes)} bytes`);
      return;
    }
    if (!enforceRate(state)) {
      sendError(relay.socket, 'RATE_LIMITED', `rendezvous over ${String(ratePerHour)} events/hour`);
      return;
    }
    const event: EventFrame = {
      kind: 'EVENT',
      rendezvous_id: frame.rendezvous_id,
      sender_replica_id: frame.replica_id,
      ciphertext: frame.ciphertext,
      nonce: frame.nonce,
      signature: frame.signature,
      sender_public_key: frame.sender_public_key,
      received_at: now(),
    };
    bufferEvent(state, event);
    fanOut(state, event, relay);
  };

  wss.on('connection', (socket) => {
    const relay: RelaySocket = { socket, alive: true };
    const heartbeat = setInterval(() => {
      if (!relay.alive) {
        socket.terminate();
        return;
      }
      relay.alive = false;
      try {
        socket.ping();
      } catch {
        // Socket dying — terminate handler will clean up.
      }
    }, HEARTBEAT_INTERVAL_MS);

    socket.on('pong', () => {
      relay.alive = true;
    });

    socket.on('message', (data, isBinary) => {
      const buffer = isBinary
        ? Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data as ArrayBufferLike)
        : Buffer.from(data as ArrayBufferLike);
      const frame = decodeFrame(buffer);
      if (frame === null) {
        sendError(socket, 'BAD_FRAME', 'malformed frame');
        return;
      }
      // The frames the server accepts from clients. Other kinds
      // (WELCOME / EVENT / PONG / ERROR) are server-to-client only;
      // a client sending one is rejected with UNEXPECTED_FRAME.
      if (frame.kind === 'HELLO') {
        if (frame.protocol_version !== PROTOCOL_VERSION) {
          sendError(socket, 'PROTOCOL_VERSION', `expected v${String(PROTOCOL_VERSION)}`);
          return;
        }
        socket.send(
          encodeFrame({
            kind: 'WELCOME',
            server_version: serverVersion,
            max_event_size: maxEventBytes,
            max_buffer_seconds: Math.floor(maxBufferAgeMs / 1000),
          }),
        );
        return;
      }
      if (frame.kind === 'SUBSCRIBE') {
        handleSubscribe(relay, frame);
        return;
      }
      if (frame.kind === 'PUBLISH') {
        handlePublish(relay, frame);
        return;
      }
      if (frame.kind === 'PING') {
        socket.send(encodeFrame({ kind: 'PONG' }));
        return;
      }
      sendError(socket, 'UNEXPECTED_FRAME', `relay does not accept ${frame.kind} from clients`);
    });

    const cleanup = (): void => {
      clearInterval(heartbeat);
      if (relay.rendezvousId !== undefined) {
        const state = rendezvouses.get(relay.rendezvousId);
        state?.subscribers.delete(relay);
      }
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const resolvedPort =
    typeof address === 'object' && address !== null ? address.port : port;

  return {
    port: resolvedPort,
    host,
    close: async () => {
      await new Promise<void>((resolve) => {
        wss.close(() => {
          httpServer.close(() => {
            resolve();
          });
        });
      });
    },
  };
};

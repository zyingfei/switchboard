import { describe, expect, it, vi } from 'vitest';

import type { AcceptedEvent } from './causal.js';
import { createInMemoryTransport, createLocalFsTransport } from './transport.js';

interface MakeEventOpts {
  readonly clientEventId?: string;
  readonly replicaId?: string;
  readonly seq?: number;
  readonly aggregateId?: string;
}

const makeEvent = (overrides: MakeEventOpts = {}): AcceptedEvent => ({
  clientEventId: overrides.clientEventId ?? 'evt-1',
  dot: { replicaId: overrides.replicaId ?? 'peer-1', seq: overrides.seq ?? 1 },
  deps: {},
  aggregateId: overrides.aggregateId ?? 'thread-1',
  type: 'review-draft.span.added',
  payload: { spanId: 's-1' },
  acceptedAtMs: 1_700_000_000_000,
});

describe('in-memory transport', () => {
  it('delivers published events to all subscribers when knownReplicas is empty', async () => {
    const transport = createInMemoryTransport();
    const a = vi.fn();
    const b = vi.fn();
    transport.subscribePeers(new Set(), a);
    transport.subscribePeers(new Set(), b);

    const event = makeEvent();
    await transport.publishEvent('peer-1', event);
    expect(a).toHaveBeenCalledWith('peer-1', event);
    expect(b).toHaveBeenCalledWith('peer-1', event);
  });

  it('filters by knownReplicas when the set is non-empty', async () => {
    const transport = createInMemoryTransport();
    const subscriber = vi.fn();
    transport.subscribePeers(new Set(['peer-2']), subscriber);

    await transport.publishEvent('peer-1', makeEvent({ replicaId: 'peer-1' }));
    expect(subscriber).not.toHaveBeenCalled();

    await transport.publishEvent(
      'peer-2',
      makeEvent({ clientEventId: 'evt-2', replicaId: 'peer-2' }),
    );
    expect(subscriber).toHaveBeenCalledOnce();
  });

  it('unsubscribe stops further delivery', async () => {
    const transport = createInMemoryTransport();
    const subscriber = vi.fn();
    const unsubscribe = transport.subscribePeers(new Set(), subscriber);
    unsubscribe();

    await transport.publishEvent('peer-1', makeEvent());
    expect(subscriber).not.toHaveBeenCalled();
  });
});

describe('local-fs transport', () => {
  it('publishEvent is a no-op (peers observe the file directly)', async () => {
    const transport = createLocalFsTransport({
      localReplicaId: 'self',
      subscribePaths: () => () => undefined,
      readReplica: () => Promise.resolve([]),
      listReplicaIds: () => Promise.resolve([]),
    });
    await expect(transport.publishEvent('self', makeEvent({ replicaId: 'self' }))).resolves.toBeUndefined();
  });

  it('replays existing peer events on subscribe and dedupes by clientEventId', async () => {
    const peerEvents: AcceptedEvent[] = [
      makeEvent({ clientEventId: 'evt-1', replicaId: 'peer-1', seq: 1 }),
      makeEvent({ clientEventId: 'evt-2', replicaId: 'peer-1', seq: 2 }),
    ];

    let watcherListener: ((relPath: string) => void) | undefined;
    const transport = createLocalFsTransport({
      localReplicaId: 'self',
      subscribePaths: (listener) => {
        watcherListener = listener;
        return () => {
          watcherListener = undefined;
        };
      },
      readReplica: (replicaId) => Promise.resolve(replicaId === 'peer-1' ? peerEvents : []),
      listReplicaIds: () => Promise.resolve(['peer-1']),
    });

    const subscriber = vi.fn();
    transport.subscribePeers(new Set(), subscriber);
    // Allow the async startup drain to settle.
    await new Promise((resolve) => setImmediate(resolve));
    expect(subscriber).toHaveBeenCalledTimes(2);

    // A subsequent change-event re-runs the read but should not
    // re-emit already-seen events.
    watcherListener?.('_BAC/log/peer-1/2026-05-05.jsonl');
    await new Promise((resolve) => setImmediate(resolve));
    expect(subscriber).toHaveBeenCalledTimes(2);

    peerEvents.push(makeEvent({ clientEventId: 'evt-3', replicaId: 'peer-1', seq: 3 }));
    watcherListener?.('_BAC/log/peer-1/2026-05-05.jsonl');
    await new Promise((resolve) => setImmediate(resolve));
    expect(subscriber).toHaveBeenCalledTimes(3);
    const deliveredIds = subscriber.mock.calls.map(
      (args) => (args[1] as AcceptedEvent).clientEventId,
    );
    expect(deliveredIds).toEqual(['evt-1', 'evt-2', 'evt-3']);
  });

  it('skips events from the local replica and from unrelated paths', async () => {
    let watcherListener: ((relPath: string) => void) | undefined;
    const peerEvents: AcceptedEvent[] = [];
    const transport = createLocalFsTransport({
      localReplicaId: 'self',
      subscribePaths: (listener) => {
        watcherListener = listener;
        return () => undefined;
      },
      readReplica: (replicaId) => {
        if (replicaId === 'self') {
          return Promise.resolve([makeEvent({ replicaId: 'self' })]);
        }
        return Promise.resolve(peerEvents);
      },
      listReplicaIds: () => Promise.resolve(['self']),
    });

    const subscriber = vi.fn();
    transport.subscribePeers(new Set(), subscriber);
    await new Promise((resolve) => setImmediate(resolve));
    expect(subscriber).not.toHaveBeenCalled();

    // An update outside _BAC/log/ should be ignored.
    watcherListener?.('_BAC/threads/abc.json');
    await new Promise((resolve) => setImmediate(resolve));
    expect(subscriber).not.toHaveBeenCalled();
  });

  it('respects knownReplicas filter', async () => {
    const peerEvents: AcceptedEvent[] = [
      makeEvent({ clientEventId: 'evt-x', replicaId: 'peer-x' }),
    ];
    const transport = createLocalFsTransport({
      localReplicaId: 'self',
      subscribePaths: () => () => undefined,
      readReplica: () => Promise.resolve(peerEvents),
      listReplicaIds: () => Promise.resolve(['peer-x']),
    });

    const subscriber = vi.fn();
    transport.subscribePeers(new Set(['peer-y']), subscriber);
    await new Promise((resolve) => setImmediate(resolve));
    expect(subscriber).not.toHaveBeenCalled();
  });
});

// Relay transport tests live in `relayTransport.test.ts` — they
// boot a real WebSocket server via startRelayServer() and exercise
// the encrypt/sign/verify path end-to-end.

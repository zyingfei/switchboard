import { describe, expect, it, vi } from 'vitest';

import type { AcceptedEvent } from '../causal.js';
import type { EventLog } from '../eventLog.js';
import type { Materializer, MaterializerHealth } from './materializer.js';
import { createSyncContractRunner } from './runner.js';

// Unit tests for the runner. We don't exercise materializer
// internals (those have their own tests); we verify that the runner:
//   1. Dispatches events to handling materializers, with origin.
//   2. Skips materializers whose `handles` doesn't include the type.
//   3. AWAITS catchUp on every materializer in catchUpAll.
//   4. Aggregates health.
//   5. Swallows materializer throws so one bad materializer doesn't
//      stall the others.
//   6. Refuses duplicate registration.

const stubEvent = (type: string): AcceptedEvent => ({
  clientEventId: `evt-${type}`,
  dot: { replicaId: 'r', seq: 1 },
  deps: {},
  aggregateId: 'agg',
  type,
  payload: {},
  acceptedAtMs: 1,
});

const stubLog = (): EventLog => ({
  appendClient: vi.fn(),
  appendClientObserved: vi.fn(),
  appendServerObserved: vi.fn(),
  readMerged: vi.fn(async () => []),
  readReplica: vi.fn(async () => []),
  readByAggregate: vi.fn(async () => []),
  findByClientEventId: vi.fn(async () => null),
  findByDot: vi.fn(async () => null),
  listReplicaIds: vi.fn(async () => []),
  importPeerEvent: vi.fn(async () => ({ imported: false })),
});

interface StubMaterializerOpts {
  readonly name: string;
  readonly handles: readonly string[];
  readonly throwOnAccepted?: boolean;
  readonly throwInCatchUp?: boolean;
  readonly catchUpDelayMs?: number;
}

const makeStub = (
  opts: StubMaterializerOpts,
): Materializer & {
  readonly seen: { event: AcceptedEvent; origin: 'local' | 'peer' }[];
  readonly catchUpCalls: number;
} => {
  const seen: { event: AcceptedEvent; origin: 'local' | 'peer' }[] = [];
  let catchUpCalls = 0;
  let lastSuccessAt: string | null = null;
  let lastError: string | null = null;
  let pending = false;

  return {
    name: opts.name,
    handles: new Set(opts.handles),
    onAccepted: (event, ctx) => {
      if (opts.throwOnAccepted === true) {
        throw new Error('accepted-throw');
      }
      seen.push({ event, origin: ctx.origin });
    },
    catchUp: async () => {
      catchUpCalls += 1;
      pending = true;
      if (opts.catchUpDelayMs !== undefined) {
        await new Promise((r) => setTimeout(r, opts.catchUpDelayMs));
      }
      pending = false;
      if (opts.throwInCatchUp === true) {
        lastError = 'catchUp-throw';
        throw new Error('catchUp-throw');
      }
      lastSuccessAt = new Date().toISOString();
    },
    awaitIdle: async () => {
      while (pending) {
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    health: (): MaterializerHealth => ({
      status: lastError !== null ? 'failed' : 'healthy',
      lastSuccessAt,
      lastError,
      pending,
    }),
    seen,
    get catchUpCalls() {
      return catchUpCalls;
    },
  };
};

describe('SyncContractRunner', () => {
  it('dispatches events to the materializers whose handles include the type', () => {
    const runner = createSyncContractRunner();
    const a = makeStub({ name: 'a', handles: ['thread.upserted'] });
    const b = makeStub({ name: 'b', handles: ['workstream.upserted'] });
    runner.register(a);
    runner.register(b);

    runner.onAcceptedEvent(stubEvent('thread.upserted'), { origin: 'peer' });

    expect(a.seen).toHaveLength(1);
    expect(a.seen[0]?.origin).toBe('peer');
    expect(b.seen).toHaveLength(0);
  });

  it('passes origin through unchanged for local and peer paths', () => {
    const runner = createSyncContractRunner();
    const m = makeStub({ name: 'm', handles: ['thread.upserted'] });
    runner.register(m);

    runner.onAcceptedEvent(stubEvent('thread.upserted'), { origin: 'local' });
    runner.onAcceptedEvent(stubEvent('thread.upserted'), { origin: 'peer' });

    expect(m.seen.map((s) => s.origin)).toEqual(['local', 'peer']);
  });

  it('AWAITS every materializer’s catchUp in catchUpAll (resolves only after drain)', async () => {
    const runner = createSyncContractRunner();
    const fast = makeStub({ name: 'fast', handles: [], catchUpDelayMs: 10 });
    const slow = makeStub({ name: 'slow', handles: [], catchUpDelayMs: 100 });
    runner.register(fast);
    runner.register(slow);

    const start = Date.now();
    await runner.catchUpAll(stubLog());
    const elapsed = Date.now() - start;

    expect(fast.catchUpCalls).toBe(1);
    expect(slow.catchUpCalls).toBe(1);
    // Both ran; total elapsed >= slow delay (sequential awaiting).
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });

  it('onRelayReconnected behaves like catchUpAll', async () => {
    const runner = createSyncContractRunner();
    const m = makeStub({ name: 'm', handles: [], catchUpDelayMs: 5 });
    runner.register(m);
    await runner.onRelayReconnected(stubLog());
    expect(m.catchUpCalls).toBe(1);
  });

  it('aggregates health across registered materializers', () => {
    const runner = createSyncContractRunner();
    runner.register(makeStub({ name: 'a', handles: [] }));
    runner.register(makeStub({ name: 'b', handles: [] }));
    const h = runner.health();
    expect(Object.keys(h).sort()).toEqual(['a', 'b']);
    expect(h['a']?.status).toBe('healthy');
    expect(h['b']?.status).toBe('healthy');
  });

  it('swallows onAccepted throws so one bad materializer does not stall the others', () => {
    const runner = createSyncContractRunner();
    const bad = makeStub({ name: 'bad', handles: ['thread.upserted'], throwOnAccepted: true });
    const good = makeStub({ name: 'good', handles: ['thread.upserted'] });
    runner.register(bad);
    runner.register(good);

    runner.onAcceptedEvent(stubEvent('thread.upserted'), { origin: 'peer' });
    expect(good.seen).toHaveLength(1);
  });

  it('continues catchUpAll past a materializer that throws', async () => {
    const runner = createSyncContractRunner();
    const bad = makeStub({ name: 'bad', handles: [], throwInCatchUp: true });
    const good = makeStub({ name: 'good', handles: [] });
    runner.register(bad);
    runner.register(good);
    await runner.catchUpAll(stubLog());
    expect(good.catchUpCalls).toBe(1);
    expect(runner.health()['bad']?.status).toBe('failed');
    expect(runner.health()['good']?.status).toBe('healthy');
  });

  it('refuses duplicate registration of the same materializer name', () => {
    const runner = createSyncContractRunner();
    runner.register(makeStub({ name: 'm', handles: [] }));
    expect(() => {
      runner.register(makeStub({ name: 'm', handles: [] }));
    }).toThrow(/already registered/);
  });

  it('awaitIdle resolves when every materializer is idle', async () => {
    const runner = createSyncContractRunner();
    const m = makeStub({ name: 'm', handles: [], catchUpDelayMs: 30 });
    runner.register(m);
    void runner.catchUpAll(stubLog());
    await runner.awaitIdle();
    expect(m.health().pending).toBe(false);
  });
});

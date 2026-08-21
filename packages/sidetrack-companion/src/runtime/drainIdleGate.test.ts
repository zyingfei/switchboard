import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { advanceTimersByTimeAsync } from '../test-helpers/bunTestTimers.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { AcceptedEventContext, Materializer } from '../sync/contract/materializer.js';

import {
  DEFAULT_DRAIN_IDLE_INTERVAL_MS,
  DRAIN_IDLE_GATE_ENV,
  DRAIN_IDLE_INTERVAL_MS_ENV,
  createDrainIdleGate,
  drainIdleGateEnabled,
  resolveDrainIdleIntervalMs,
} from './drainIdleGate.js';

const TRICKLE_TYPE = 'browser.timeline.observed';
const OTHER_TRICKLE_TYPE = 'engagement.interval.observed';
const CONTENT_TYPE = 'navigation.committed';

const acceptedEvent = (type: string, seq: number): AcceptedEvent => ({
  clientEventId: `evt-${String(seq)}`,
  dot: { replicaId: 'r1', seq },
  deps: {},
  aggregateId: `agg-${String(seq)}`,
  type,
  payload: {},
  acceptedAtMs: seq,
});

const ctx: AcceptedEventContext = { origin: 'local' };

const createFakeMaterializer = (): Materializer & { readonly seen: AcceptedEvent[] } => {
  const seen: AcceptedEvent[] = [];
  return {
    name: 'fake',
    handles: new Set([TRICKLE_TYPE, OTHER_TRICKLE_TYPE, CONTENT_TYPE]),
    onAccepted: (event) => {
      seen.push(event);
    },
    catchUp: async () => undefined,
    awaitIdle: async () => undefined,
    health: () => ({ status: 'healthy', lastSuccessAt: null, lastError: null, pending: false }),
    seen,
  };
};

const TRICKLE_TYPES = new Set([TRICKLE_TYPE, OTHER_TRICKLE_TYPE]);

describe('drainIdleGateEnabled / resolveDrainIdleIntervalMs', () => {
  it('defaults ON (absent env)', () => {
    expect(drainIdleGateEnabled({})).toBe(true);
  });

  it('disabled only by literal "0"', () => {
    expect(drainIdleGateEnabled({ [DRAIN_IDLE_GATE_ENV]: '0' })).toBe(false);
    expect(drainIdleGateEnabled({ [DRAIN_IDLE_GATE_ENV]: 'false' })).toBe(true);
  });

  it('resolves the default interval when unset or invalid', () => {
    expect(resolveDrainIdleIntervalMs({})).toBe(DEFAULT_DRAIN_IDLE_INTERVAL_MS);
    expect(resolveDrainIdleIntervalMs({ [DRAIN_IDLE_INTERVAL_MS_ENV]: 'nope' })).toBe(
      DEFAULT_DRAIN_IDLE_INTERVAL_MS,
    );
  });

  it('honors a valid override', () => {
    expect(resolveDrainIdleIntervalMs({ [DRAIN_IDLE_INTERVAL_MS_ENV]: '5000' })).toBe(5000);
  });
});

describe('createDrainIdleGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('withholds a trickle event from the inner materializer until the idle interval elapses', async () => {
    const inner = createFakeMaterializer();
    const gate = createDrainIdleGate(inner, { trickleTypes: TRICKLE_TYPES, env: {} });
    gate.materializer.onAccepted(acceptedEvent(TRICKLE_TYPE, 1), ctx);
    expect(inner.seen).toHaveLength(0);
    expect(gate.pendingCount()).toBe(1);
    await advanceTimersByTimeAsync(DEFAULT_DRAIN_IDLE_INTERVAL_MS - 1);
    expect(inner.seen).toHaveLength(0);
    await advanceTimersByTimeAsync(1);
    expect(inner.seen).toHaveLength(1);
    expect(gate.pendingCount()).toBe(0);
    gate.teardown();
  });

  it('flushes immediately (in order) when a content-bearing event arrives', async () => {
    const inner = createFakeMaterializer();
    const gate = createDrainIdleGate(inner, { trickleTypes: TRICKLE_TYPES, env: {} });
    gate.materializer.onAccepted(acceptedEvent(TRICKLE_TYPE, 1), ctx);
    gate.materializer.onAccepted(acceptedEvent(OTHER_TRICKLE_TYPE, 2), ctx);
    expect(inner.seen).toHaveLength(0);
    gate.materializer.onAccepted(acceptedEvent(CONTENT_TYPE, 3), ctx);
    expect(inner.seen.map((e) => e.dot.seq)).toEqual([1, 2, 3]);
    expect(gate.pendingCount()).toBe(0);
    gate.teardown();
  });

  it('coalesces 10 trickle events over simulated idle time into at most one flush', async () => {
    const inner = createFakeMaterializer();
    const gate = createDrainIdleGate(inner, { trickleTypes: TRICKLE_TYPES, env: {} });
    for (let i = 0; i < 10; i += 1) {
      gate.materializer.onAccepted(acceptedEvent(TRICKLE_TYPE, i), ctx);
      await advanceTimersByTimeAsync(1000);
    }
    expect(inner.seen).toHaveLength(0);
    await advanceTimersByTimeAsync(DEFAULT_DRAIN_IDLE_INTERVAL_MS);
    expect(inner.seen).toHaveLength(10);
    gate.teardown();
  });

  it('respects a custom idle interval from env', async () => {
    const inner = createFakeMaterializer();
    const gate = createDrainIdleGate(inner, {
      trickleTypes: TRICKLE_TYPES,
      env: { [DRAIN_IDLE_INTERVAL_MS_ENV]: '2000' },
    });
    gate.materializer.onAccepted(acceptedEvent(TRICKLE_TYPE, 1), ctx);
    await advanceTimersByTimeAsync(1999);
    expect(inner.seen).toHaveLength(0);
    await advanceTimersByTimeAsync(1);
    expect(inner.seen).toHaveLength(1);
    gate.teardown();
  });

  it('passes every event through immediately when disabled via env', () => {
    const inner = createFakeMaterializer();
    const gate = createDrainIdleGate(inner, {
      trickleTypes: TRICKLE_TYPES,
      env: { [DRAIN_IDLE_GATE_ENV]: '0' },
    });
    gate.materializer.onAccepted(acceptedEvent(TRICKLE_TYPE, 1), ctx);
    expect(inner.seen).toHaveLength(1);
    gate.teardown();
  });

  it('passes through name/handles/catchUp/awaitIdle/health unchanged', async () => {
    const inner = createFakeMaterializer();
    const gate = createDrainIdleGate(inner, { trickleTypes: TRICKLE_TYPES, env: {} });
    expect(gate.materializer.name).toBe(inner.name);
    expect(gate.materializer.handles).toBe(inner.handles);
    expect(gate.materializer.handles.has(TRICKLE_TYPE)).toBe(true);
    await expect(gate.materializer.catchUp(undefined as never)).resolves.toBeUndefined();
    await expect(gate.materializer.awaitIdle()).resolves.toBeUndefined();
    expect(gate.materializer.health().status).toBe('healthy');
    gate.teardown();
  });

  it('teardown cancels the flush timer without forwarding buffered events', async () => {
    const inner = createFakeMaterializer();
    const gate = createDrainIdleGate(inner, { trickleTypes: TRICKLE_TYPES, env: {} });
    gate.materializer.onAccepted(acceptedEvent(TRICKLE_TYPE, 1), ctx);
    gate.teardown();
    await advanceTimersByTimeAsync(DEFAULT_DRAIN_IDLE_INTERVAL_MS + 1000);
    expect(inner.seen).toHaveLength(0);
  });

  it('forwards the FIRST trickle event for a novelty key immediately, then defers repeats of the same key', async () => {
    const inner = createFakeMaterializer();
    const gate = createDrainIdleGate(inner, {
      trickleTypes: TRICKLE_TYPES,
      env: {},
      noveltyKeyForEvent: (event) =>
        event.type === TRICKLE_TYPE ? (event.payload as { url?: string }).url : undefined,
    });
    const first = { ...acceptedEvent(TRICKLE_TYPE, 1), payload: { url: 'https://example.com/a' } };
    gate.materializer.onAccepted(first, ctx);
    expect(inner.seen).toHaveLength(1);
    expect(gate.pendingCount()).toBe(0);

    const repeat = { ...acceptedEvent(TRICKLE_TYPE, 2), payload: { url: 'https://example.com/a' } };
    gate.materializer.onAccepted(repeat, ctx);
    expect(inner.seen).toHaveLength(1);
    expect(gate.pendingCount()).toBe(1);

    const secondNew = {
      ...acceptedEvent(TRICKLE_TYPE, 3),
      payload: { url: 'https://example.com/b' },
    };
    gate.materializer.onAccepted(secondNew, ctx);
    // Flushing the novel event also flushes the previously-buffered repeat
    // (order preserved: repeat before the new event that triggered flush).
    expect(inner.seen.map((e) => e.dot.seq)).toEqual([1, 2, 3]);
    expect(gate.pendingCount()).toBe(0);
    gate.teardown();
  });

  it('a type with no novelty extractor result defers unconditionally', async () => {
    const inner = createFakeMaterializer();
    const gate = createDrainIdleGate(inner, {
      trickleTypes: TRICKLE_TYPES,
      env: {},
      noveltyKeyForEvent: () => undefined,
    });
    gate.materializer.onAccepted(acceptedEvent(OTHER_TRICKLE_TYPE, 1), ctx);
    expect(inner.seen).toHaveLength(0);
    expect(gate.pendingCount()).toBe(1);
    gate.teardown();
  });

  it('non-trickle events not in trickleTypes forward immediately even without any buffered backlog', () => {
    const inner = createFakeMaterializer();
    const gate = createDrainIdleGate(inner, { trickleTypes: TRICKLE_TYPES, env: {} });
    gate.materializer.onAccepted(acceptedEvent(CONTENT_TYPE, 1), ctx);
    expect(inner.seen).toHaveLength(1);
    gate.teardown();
  });
});

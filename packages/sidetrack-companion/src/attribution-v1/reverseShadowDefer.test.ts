import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetInflightRegistry } from '../runtime/inflightRegistry.js';
import type { ConnectionsSnapshot } from '../connections/types.js';
import type { ResolveUrlAttributionInput } from '../tabsession/resolver.js';
import { armShadowSnapshot, resetArmShadowForTest } from './armShadow.js';
import {
  __resetReverseShadowDeferQueue,
  flushReverseShadows,
  pendingReverseShadowCount,
  queueReverseShadow,
  reverseShadowDeferStats,
  scheduleReverseShadowFlush,
} from './reverseShadowDefer.js';

// NOTE: this file deliberately does NOT vi.mock('../tabsession/resolver.js').
// A prior vi.mock('../recall/embedder.js') in runtime/companion.test.ts
// leaked process-globally under `bun test` and poisoned the real module for
// every other suite in the run (see that file's history) — module mocking is
// unreliable in this package's bun:test setup. Every test below drives the
// REAL resolveUrlAttribution with a minimal, edgeless snapshot (mirrors
// armedResolve.test.ts's fixture), which deterministically abstains
// (inbox/null) and is cheap enough to run dozens of times per test.

const minimalSnapshot = (probeUrl: string): ConnectionsSnapshot => ({
  scope: {},
  nodes: [
    {
      id: `timeline-visit:${probeUrl}`,
      kind: 'timeline-visit',
      label: 'probe',
      originReplicaIds: [],
      metadata: { canonicalUrl: probeUrl },
    },
  ],
  edges: [],
  updatedAt: '2026-08-16T00:00:00.000Z',
  nodeCount: 1,
  edgeCount: 0,
});

const resolverInput = (probeUrl: string): ResolveUrlAttributionInput => ({
  canonicalUrl: probeUrl,
  snapshot: minimalSnapshot(probeUrl),
  events: [],
});

// The queue is module-level (process-global) state; reset between tests.
beforeEach(() => {
  __resetReverseShadowDeferQueue();
  __resetInflightRegistry();
  resetArmShadowForTest();
});
afterEach(() => {
  __resetReverseShadowDeferQueue();
  __resetInflightRegistry();
  resetArmShadowForTest();
});

/** One macrotask turn — enough for a `setImmediate`-scheduled flush to start. */
const tick = async (): Promise<void> =>
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

describe('queueReverseShadow', () => {
  it('records NOTHING until a flush is asked for — the response never waits on it', async () => {
    queueReverseShadow(resolverInput('https://a.test/1'), null);
    queueReverseShadow(resolverInput('https://a.test/2'), null);
    // Several macrotask turns pass — long enough that a self-scheduling queue
    // would already have fired.
    await tick();
    await tick();
    await tick();
    expect(armShadowSnapshot().requests).toBe(0);
    expect(pendingReverseShadowCount()).toBe(2);
  });

  it('drains everything queued once flushed, recording one sample per entry', async () => {
    queueReverseShadow(resolverInput('https://a.test/1'), null);
    queueReverseShadow(resolverInput('https://a.test/2'), null);
    await flushReverseShadows();
    expect(armShadowSnapshot().requests).toBe(2);
    expect(pendingReverseShadowCount()).toBe(0);
  });

  it('yields between samples so N deferred computes are not one uninterruptible tick', async () => {
    for (let index = 0; index < 5; index += 1) {
      queueReverseShadow(resolverInput(`https://a.test/${String(index)}`), null);
    }
    let interleaved = 0;
    let running = true;
    const beat = (): void => {
      if (!running) return;
      interleaved += 1;
      setImmediate(beat);
    };
    setImmediate(beat);
    await flushReverseShadows();
    running = false;
    expect(armShadowSnapshot().requests).toBe(5);
    // 5 samples ⇒ 4 inter-sample yields.
    expect(interleaved).toBeGreaterThanOrEqual(4);
  });
});

describe('flush failure handling', () => {
  it('swallows + logs a compute failure and keeps draining the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // A malformed input (snapshot missing entirely) throws inside
    // resolveUrlAttribution — the deferred drain must contain that, not
    // propagate it, and must still process the well-formed entries either
    // side of it.
    const broken = { canonicalUrl: 'https://a.test/broken', events: [] } as unknown as
      ResolveUrlAttributionInput;
    queueReverseShadow(resolverInput('https://a.test/1'), null);
    queueReverseShadow(broken, null);
    queueReverseShadow(resolverInput('https://a.test/3'), null);
    await expect(flushReverseShadows()).resolves.toBeUndefined();
    expect(armShadowSnapshot().requests).toBe(2); // the 2 well-formed samples
    expect(reverseShadowDeferStats().computeFailures).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[reverse-shadow] deferred compute failed'),
    );
    expect(pendingReverseShadowCount()).toBe(0);
    warn.mockRestore();
  });
});

describe('scheduleReverseShadowFlush (the dispatch-finally trigger)', () => {
  it('drains on the next macrotask after being asked', async () => {
    queueReverseShadow(resolverInput('https://a.test/1'), null);
    scheduleReverseShadowFlush();
    expect(armShadowSnapshot().requests).toBe(0);
    await tick();
    await tick();
    expect(armShadowSnapshot().requests).toBe(1);
  });

  it('is a cheap no-op with an empty queue (every request with the shadow off)', () => {
    expect(pendingReverseShadowCount()).toBe(0);
    expect(() => {
      scheduleReverseShadowFlush();
    }).not.toThrow();
  });

  it('is single-flight — a second flush joins the running drain, never double-records', async () => {
    for (let index = 0; index < 4; index += 1) {
      queueReverseShadow(resolverInput(`https://a.test/${String(index)}`), null);
    }
    await Promise.all([flushReverseShadows(), flushReverseShadows(), flushReverseShadows()]);
    expect(armShadowSnapshot().requests).toBe(4);
    expect(pendingReverseShadowCount()).toBe(0);
  });
});

describe('overflow', () => {
  it('drops new samples past the cap instead of growing without bound', () => {
    for (let index = 0; index < 1100; index += 1) {
      queueReverseShadow(resolverInput(`https://a.test/${String(index)}`), null);
    }
    expect(pendingReverseShadowCount()).toBe(1024);
    expect(reverseShadowDeferStats().droppedOverflow).toBe(76);
  });
});

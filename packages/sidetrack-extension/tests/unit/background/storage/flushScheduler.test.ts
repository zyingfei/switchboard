import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFlushScheduler, FLUSH_ALARM, MAX_BATCH_SIZE } from '../../../../src/background/storage/flush-scheduler';
import { InMemoryEventBuffer, type BufferedEvent } from '../../../../src/background/storage/in-memory-event-buffer';

const e = (n: number): BufferedEvent => ({
  streamName: 'navigation.committed',
  lamport: n,
  replicaId: 'r1',
  payload: { n },
  observedAt: '2026-05-08T00:00:00.000Z',
});

describe('flush scheduler', () => {
  beforeEach(() => vi.useFakeTimers());

  it('flushes at batch size threshold', async () => {
    const buffer = new InMemoryEventBuffer();
    const scheduler = createFlushScheduler(buffer);
    for (let i = 0; i < MAX_BATCH_SIZE; i += 1) await scheduler.append(e(i));
    expect(await buffer.count()).toBe(MAX_BATCH_SIZE);
  });

  it('flushes after latency window', async () => {
    const buffer = new InMemoryEventBuffer();
    const scheduler = createFlushScheduler(buffer);
    await scheduler.append(e(1));
    expect(await buffer.count()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await buffer.count()).toBe(1);
  });

  it('registers a 60s chrome alarm', async () => {
    const create = vi.fn(async () => undefined);
    const addListener = vi.fn();
    (globalThis as unknown as { chrome: unknown }).chrome = { alarms: { create, onAlarm: { addListener } } };
    const scheduler = createFlushScheduler(new InMemoryEventBuffer());
    await scheduler.start();
    expect(create).toHaveBeenCalledWith(FLUSH_ALARM, { periodInMinutes: 1 });
    expect(addListener).toHaveBeenCalledTimes(1);
  });
});

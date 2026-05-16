import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureQueueHealth } from '../../../src/sync/captureQueueClassF';
import { QUEUE_LIMIT } from '../../../src/companion/queue';

// Lane 3 — capture queue exposed as a Class F health surface.
//
// Asserts the adapter maps the existing queue/dropped/failed
// counters into the documented PluginMaterializerHealth shape so
// the side panel + /v1/system/health can render Class F status
// uniformly. This adopts the existing capture queue (already
// Class F-compliant by behavior) without rewriting it.

const stubChromeStorage = (initial: Record<string, unknown> = {}): { reset: () => void } => {
  const store: Record<string, unknown> = { ...initial };
  // chrome.storage.local.get accepts string | string[] | { [key]: default }.
  // The OutboxStorage adapter calls it with the object form so the
  // fallback flows through when the key is missing. Honour both
  // forms so the existing capture queue helpers work.
  const get = (request: unknown): Promise<Record<string, unknown>> => {
    if (typeof request === 'string') {
      return Promise.resolve({ [request]: store[request] });
    }
    if (Array.isArray(request)) {
      const out: Record<string, unknown> = {};
      for (const k of request) out[k] = store[k];
      return Promise.resolve(out);
    }
    if (typeof request === 'object' && request !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, fallback] of Object.entries(request)) {
        out[k] = k in store ? store[k] : fallback;
      }
      return Promise.resolve(out);
    }
    return Promise.resolve({});
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn(get),
        set: vi.fn((entries: Record<string, unknown>) => {
          Object.assign(store, entries);
          return Promise.resolve();
        }),
      },
    },
  };
  return {
    reset: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
  };
};

describe('captureQueueHealth', () => {
  let stub: ReturnType<typeof stubChromeStorage>;
  afterEach(() => {
    stub?.reset();
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it('healthy when queue is below 80% capacity and no failed-explicit items', async () => {
    stub = stubChromeStorage({
      'sidetrack.captureQueue': [],
      'sidetrack.captureQueue.dropped': 0,
      'sidetrack.captureQueue.failed': [],
    });
    const health = await captureQueueHealth();
    expect(health.status).toBe('healthy');
    expect(health.activeSetSize).toBe(0);
    expect(health.activeSetBudget).toBe(QUEUE_LIMIT);
    expect(health.failedExplicitCount).toBe(0);
  });

  it('failed when failed-explicit items exist (queue full while companion offline)', async () => {
    stub = stubChromeStorage({
      'sidetrack.captureQueue': [],
      'sidetrack.captureQueue.droppedCount': 5,
      'sidetrack.captureQueue.failed': [
        {
          id: 'cap-1',
          queuedAt: '2026-05-07T00:00:00.000Z',
          failedAt: '2026-05-07T00:01:00.000Z',
          event: {
            provider: 'chatgpt',
            threadUrl: 'https://x',
            capturedAt: '2026-05-07T00:00:00.000Z',
            turns: [],
          },
        },
      ],
    });
    const health = await captureQueueHealth();
    expect(health.status).toBe('failed');
    expect(health.failedExplicitCount).toBe(1);
    expect(health.droppedPassiveCount).toBe(5);
    expect(health.lastError).toContain('explicit captures rejected');
  });
});

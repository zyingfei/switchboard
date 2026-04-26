import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCapture } from '../../src/capture/model';
import { appendCapture } from '../../src/background/storage';
import { getTrackedThreads, readSelectorHealth, recordSelectorCanaryCheck } from '../../src/registry/trackedThreads';

const storageState = new Map<string, unknown>();

const sampleCapture = (overrides: Partial<ProviderCapture> = {}): ProviderCapture => ({
  id: 'capture-one',
  provider: 'chatgpt',
  url: 'https://chatgpt.com/c/capture-one',
  title: 'Thread one',
  capturedAt: '2026-04-25T00:00:00.000Z',
  selectorCanary: 'passed',
  turns: [
    {
      id: 'turn-1',
      role: 'assistant',
      text: 'Visible response',
      ordinal: 0,
      sourceSelector: '[data-message-author-role]',
    },
  ],
  artifacts: [],
  warnings: [],
  visibleTextCharCount: 16,
  ...overrides,
});

beforeEach(() => {
  storageState.clear();
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storageState.get(key) })),
        set: vi.fn(async (value: Record<string, unknown>) => {
          for (const [key, entry] of Object.entries(value)) {
            storageState.set(key, entry);
          }
        }),
        remove: vi.fn(async (key: string) => {
          storageState.delete(key);
        }),
      },
    },
  });
});

describe('tracked thread registry', () => {
  it('exposes tracked threads through the reader interface and increments captureCount per thread', async () => {
    await appendCapture(sampleCapture());
    await appendCapture(
      sampleCapture({
        id: 'capture-two',
        title: 'Thread one updated',
        capturedAt: '2026-04-25T00:01:00.000Z',
      }),
    );

    const threads = await getTrackedThreads({ provider: 'chatgpt' });
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      provider: 'chatgpt',
      threadId: 'capture-one',
      threadUrl: 'https://chatgpt.com/c/capture-one',
      title: 'Thread one updated',
      captureCount: 2,
      status: 'active',
    });
    expect(threads[0].lastTurnAt).toBe('2026-04-25T00:01:00.000Z');
  });

  it('records selector canary health locally and marks stale threads before capture', async () => {
    await recordSelectorCanaryCheck({
      provider: 'claude',
      url: 'https://claude.ai/chat/thread-health',
      title: 'Claude thread health',
      selectorCanary: 'failed',
      checkedAt: '2026-04-25T00:00:00.000Z',
      loadId: 'load-1',
    });

    const threads = await getTrackedThreads({ provider: 'claude' });
    const selectorHealth = await readSelectorHealth();

    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      provider: 'claude',
      threadUrl: 'https://claude.ai/chat/thread-health',
      captureCount: 0,
      status: 'stale',
    });

    expect(selectorHealth.find((entry) => entry.provider === 'claude')).toMatchObject({
      cleanLoads: 0,
      recentLoads: 1,
      fallbackLoads: 0,
      failedLoads: 1,
      latestStatus: 'failed',
    });
  });

  it('replaces canary results for the same page load instead of double-counting retries', async () => {
    await recordSelectorCanaryCheck({
      provider: 'chatgpt',
      url: 'https://chatgpt.com/c/thread-health',
      title: 'ChatGPT thread health',
      selectorCanary: 'fallback',
      checkedAt: '2026-04-25T00:00:00.000Z',
      loadId: 'load-42',
    });

    await recordSelectorCanaryCheck({
      provider: 'chatgpt',
      url: 'https://chatgpt.com/c/thread-health',
      title: 'ChatGPT thread health',
      selectorCanary: 'passed',
      checkedAt: '2026-04-25T00:00:04.000Z',
      loadId: 'load-42',
    });

    const threads = await getTrackedThreads({ provider: 'chatgpt' });
    const selectorHealth = await readSelectorHealth();

    expect(threads[0]).toMatchObject({
      status: 'active',
      lastTurnAt: '2026-04-25T00:00:04.000Z',
    });

    expect(selectorHealth.find((entry) => entry.provider === 'chatgpt')).toMatchObject({
      cleanLoads: 1,
      recentLoads: 1,
      fallbackLoads: 0,
      failedLoads: 0,
      latestStatus: 'passed',
      latestCheckedAt: '2026-04-25T00:00:04.000Z',
    });
  });
});

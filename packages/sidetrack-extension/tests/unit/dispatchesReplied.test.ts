import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  markDispatchesRepliedForThread,
  readCachedDispatches,
  writeCachedDispatches,
} from '../../src/background/state';
import type { DispatchEventRecord } from '../../src/dispatch/types';

const installChromeStorageMock = (): { snapshot: () => Record<string, unknown> } => {
  const values: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn((query: Record<string, unknown> | string | null | undefined) => {
          if (typeof query === 'string') {
            return Promise.resolve({ [query]: values[query] });
          }
          if (query !== null && query !== undefined && typeof query === 'object') {
            return Promise.resolve(
              Object.fromEntries(
                Object.entries(query).map(([key, fallback]) => [key, values[key] ?? fallback]),
              ),
            );
          }
          return Promise.resolve({ ...values });
        }),
        set: vi.fn((next: Record<string, unknown>) => {
          Object.assign(values, next);
          return Promise.resolve();
        }),
      },
    },
  });
  return { snapshot: () => ({ ...values }) };
};

const buildDispatch = (overrides: Partial<DispatchEventRecord> = {}): DispatchEventRecord => ({
  bac_id: 'bac_dispatch_1',
  kind: 'research',
  target: { provider: 'claude', mode: 'paste' },
  sourceThreadId: 'bac_thread_1',
  title: 'Compare ranking strategies',
  body: 'long body',
  createdAt: '2026-04-29T10:00:00.000Z',
  redactionSummary: { matched: 0, categories: [] },
  tokenEstimate: 1000,
  status: 'sent',
  ...overrides,
});

describe('markDispatchesRepliedForThread', () => {
  beforeEach(() => {
    installChromeStorageMock();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('flips eligible dispatches to replied and returns their ids', async () => {
    await writeCachedDispatches([
      buildDispatch({ bac_id: 'd1', sourceThreadId: 'bac_thread_1', status: 'sent' }),
      buildDispatch({ bac_id: 'd2', sourceThreadId: 'bac_thread_1', status: 'pending' }),
      buildDispatch({ bac_id: 'd3', sourceThreadId: 'bac_thread_1', status: 'queued' }),
    ]);

    const flipped = await markDispatchesRepliedForThread('bac_thread_1');

    expect(new Set(flipped)).toEqual(new Set(['d1', 'd2', 'd3']));
    const after = await readCachedDispatches();
    expect(after.every((d) => d.status === 'replied')).toBe(true);
  });

  it('ignores dispatches sourced from other threads', async () => {
    await writeCachedDispatches([
      buildDispatch({ bac_id: 'd1', sourceThreadId: 'bac_thread_1', status: 'sent' }),
      buildDispatch({ bac_id: 'd2', sourceThreadId: 'bac_thread_OTHER', status: 'sent' }),
    ]);

    const flipped = await markDispatchesRepliedForThread('bac_thread_1');

    expect(flipped).toEqual(['d1']);
    const after = await readCachedDispatches();
    expect(after.find((d) => d.bac_id === 'd1')?.status).toBe('replied');
    expect(after.find((d) => d.bac_id === 'd2')?.status).toBe('sent');
  });

  it('does not re-flip dispatches that are already replied or noted', async () => {
    await writeCachedDispatches([
      buildDispatch({ bac_id: 'd1', sourceThreadId: 'bac_thread_1', status: 'replied' }),
      buildDispatch({ bac_id: 'd2', sourceThreadId: 'bac_thread_1', status: 'noted' }),
    ]);

    const flipped = await markDispatchesRepliedForThread('bac_thread_1');

    expect(flipped).toEqual([]);
    const after = await readCachedDispatches();
    expect(after.find((d) => d.bac_id === 'd1')?.status).toBe('replied');
    expect(after.find((d) => d.bac_id === 'd2')?.status).toBe('noted');
  });

  it('returns an empty array when there are no dispatches', async () => {
    const flipped = await markDispatchesRepliedForThread('bac_thread_1');
    expect(flipped).toEqual([]);
  });

  it('does not write to storage when nothing changes (avoid noisy churn)', async () => {
    await writeCachedDispatches([
      buildDispatch({ bac_id: 'd1', sourceThreadId: 'bac_thread_1', status: 'replied' }),
    ]);
    const setSpy = vi.spyOn(chrome.storage.local, 'set');
    setSpy.mockClear();

    await markDispatchesRepliedForThread('bac_thread_1');

    expect(setSpy).not.toHaveBeenCalled();
  });
});

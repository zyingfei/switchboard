import { describe, expect, it } from 'vitest';

import { collectHealth } from './health.js';

describe('collectHealth', () => {
  it('aggregates sub-collectors and computes uptime', async () => {
    const report = await collectHealth({
      startedAt: new Date('2026-05-03T00:00:00.000Z'),
      now: () => new Date('2026-05-03T00:00:42.000Z'),
      vaultRoot: '/tmp/vault',
      vaultWritable: () => Promise.resolve(true),
      vaultSizeBytes: () => Promise.resolve(1234),
      captureSummary: () =>
        Promise.resolve({
          lastByProvider: { chatgpt: '2026-05-03T00:00:01.000Z' },
          queueDepthHint: 2,
          droppedHint: 1,
        }),
      recallSummary: () =>
        Promise.resolve({
          indexExists: true,
          entryCount: 7,
          modelId: 'model',
          sizeBytes: 4096,
        }),
      serviceStatus: () => Promise.resolve({ installed: true, running: false }),
    });

    expect(report).toEqual({
      uptimeSec: 42,
      vault: { root: '/tmp/vault', writable: true, sizeBytes: 1234 },
      capture: {
        lastByProvider: { chatgpt: '2026-05-03T00:00:01.000Z' },
        queueDepthHint: 2,
        droppedHint: 1,
      },
      recall: { indexExists: true, entryCount: 7, modelId: 'model', sizeBytes: 4096 },
      service: { installed: true, running: false },
    });
  });

  it('uses null recall fields when the index is missing', async () => {
    const report = await collectHealth({
      startedAt: new Date('2026-05-03T00:00:00.000Z'),
      now: () => new Date('2026-05-03T00:00:00.000Z'),
      vaultRoot: '/tmp/vault',
      vaultWritable: () => Promise.resolve(true),
      vaultSizeBytes: () => Promise.resolve(null),
      captureSummary: () =>
        Promise.resolve({ lastByProvider: {}, queueDepthHint: null, droppedHint: null }),
      recallSummary: () =>
        Promise.resolve({
          indexExists: false,
          entryCount: null,
          modelId: null,
          sizeBytes: null,
        }),
      serviceStatus: () => Promise.resolve({ installed: false, running: false }),
    });

    expect(report.recall).toEqual({
      indexExists: false,
      entryCount: null,
      modelId: null,
      sizeBytes: null,
    });
  });
});

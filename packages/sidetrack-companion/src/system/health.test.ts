import { describe, expect, it } from 'vitest';

import { collectHealth, resolveServiceRunning } from './health.js';

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
      // dataLoss is always populated (unwired ⇒ all-zero, clean, no
      // reconciliation measured).
      dataLoss: {
        counters: {
          skippedMalformedLines: 0,
          storeSkippedOutOfOrder: 0,
          dotCollisions: 0,
          duplicateCaptures: 0,
          unreadableShards: 0,
        },
        reconciliation: null,
        clean: true,
      },
      observability: {
        asOf: '2026-05-03T00:00:42.000Z',
        status: 'ok',
        sections: { vault: 'ok', capture: 'ok', recall: 'ok', service: 'ok', dataLoss: 'ok' },
      },
    });
  });

  it('derives worst-of status from a failed materializer (not silently ok)', async () => {
    const report = await collectHealth({
      startedAt: new Date('2026-05-03T00:00:00.000Z'),
      now: () => new Date('2026-05-03T00:00:00.000Z'),
      vaultRoot: '/tmp/vault',
      vaultWritable: () => Promise.resolve(true),
      vaultSizeBytes: () => Promise.resolve(1),
      captureSummary: () =>
        Promise.resolve({ lastByProvider: {}, queueDepthHint: null, droppedHint: null }),
      recallSummary: () =>
        Promise.resolve({ indexExists: true, entryCount: 1, modelId: 'm', sizeBytes: 1 }),
      serviceStatus: () => Promise.resolve({ installed: true, running: true }),
      syncSummary: () => ({
        replicaId: 'r1',
        seq: 5,
        materializers: {
          connections: {
            status: 'failed',
            lastSuccessAt: null,
            lastError: 'boom',
            pending: true,
          },
        },
      }),
    });

    expect(report.observability?.status).toBe('failed');
    expect(report.observability?.sections['sync']).toBe('ok');
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

  // Minimal all-green deps so a test can override only the axis it
  // exercises without re-declaring the whole HealthDeps literal.
  const baseDeps = (): Parameters<typeof collectHealth>[0] => ({
    startedAt: new Date('2026-07-11T00:00:00.000Z'),
    now: () => new Date('2026-07-11T00:00:01.000Z'),
    vaultRoot: '/tmp/vault',
    vaultWritable: () => Promise.resolve(true),
    vaultSizeBytes: () => Promise.resolve(1),
    captureSummary: () =>
      Promise.resolve({ lastByProvider: {}, queueDepthHint: null, droppedHint: null }),
    recallSummary: () =>
      Promise.resolve({ indexExists: true, entryCount: 1, modelId: 'm', sizeBytes: 1 }),
    serviceStatus: () => Promise.resolve({ installed: true, running: true }),
  });

  describe('dataLoss tripwires (F26)', () => {
    it('surfaces a non-zero event-lane counter as a red signal (not clean, failed status)', async () => {
      const report = await collectHealth({
        ...baseDeps(),
        eventLaneHealth: () => ({
          skippedMalformedLines: 2,
          storeSkippedOutOfOrder: 0,
          dotCollisions: 0,
          duplicateCaptures: 0,
          unreadableShards: 0,
        }),
      });

      expect(report.dataLoss?.counters.skippedMalformedLines).toBe(2);
      expect(report.dataLoss?.clean).toBe(false);
      expect(report.observability?.sections['dataLoss']).toBe('stale');
      // Any tripped tripwire escalates overall status to failed — the
      // loudest signal PRD §15 falsifiability can produce.
      expect(report.observability?.status).toBe('failed');
    });

    it('reports the store-vs-JSONL reconciliation delta and stays clean at zero', async () => {
      const report = await collectHealth({
        ...baseDeps(),
        eventLaneHealth: () => ({
          skippedMalformedLines: 0,
          storeSkippedOutOfOrder: 0,
          dotCollisions: 0,
          duplicateCaptures: 0,
          unreadableShards: 0,
        }),
        storeReconciliation: () =>
          Promise.resolve({ storeRowCount: 100, expectedFromWatermark: 100, delta: 0 }),
      });

      expect(report.dataLoss?.reconciliation).toEqual({
        storeRowCount: 100,
        expectedFromWatermark: 100,
        delta: 0,
      });
      expect(report.dataLoss?.clean).toBe(true);
      expect(report.observability?.sections['dataLoss']).toBe('ok');
    });

    it('a non-zero reconciliation delta trips the wire even when counters are zero', async () => {
      const report = await collectHealth({
        ...baseDeps(),
        storeReconciliation: () =>
          Promise.resolve({ storeRowCount: 98, expectedFromWatermark: 100, delta: 2 }),
      });

      expect(report.dataLoss?.reconciliation?.delta).toBe(2);
      expect(report.dataLoss?.clean).toBe(false);
      expect(report.observability?.status).toBe('failed');
    });
  });

  describe('honest service.running (F28)', () => {
    it('a live not-running probe overrides a plist-inferred running=true', () => {
      // Installer claims running (plist exists) but the real liveness
      // probe says the process is dead — the health surface must trust
      // the probe, not plist existence.
      expect(resolveServiceRunning(true, 'not-running')).toBe(false);
    });

    it('a live running probe overrides a plist-inferred running=false', () => {
      expect(resolveServiceRunning(false, 'running')).toBe(true);
    });

    it('falls back to the plist heuristic only when the probe is unknown', () => {
      // Tool absent / timed out ⇒ we must NOT fabricate a false negative;
      // fall back to whatever the installer inferred.
      expect(resolveServiceRunning(true, 'unknown')).toBe(true);
      expect(resolveServiceRunning(false, 'unknown')).toBe(false);
    });
  });

  describe('liveness edges (F28)', () => {
    it('surfaces a ranker refresh lastError as a stale section, ok when healthy', async () => {
      const failing = await collectHealth({
        ...baseDeps(),
        rankerHealth: () => ({
          serveable: false,
          revisionId: 'rev-1',
          lastRefreshAt: '2026-07-11T00:00:00.000Z',
          lastError: 'refresh threw: boom',
        }),
      });
      expect(failing.ranker?.lastError).toBe('refresh threw: boom');
      expect(failing.observability?.sections['ranker']).toBe('stale');
      expect(failing.observability?.status).toBe('degraded');

      const healthy = await collectHealth({
        ...baseDeps(),
        rankerHealth: () => ({
          serveable: true,
          revisionId: 'rev-1',
          lastRefreshAt: '2026-07-11T00:00:00.000Z',
          lastError: null,
        }),
      });
      expect(healthy.observability?.sections['ranker']).toBe('ok');
    });

    it('surfaces a dead MCP child as failed', async () => {
      const report = await collectHealth({
        ...baseDeps(),
        mcpChildHealth: () => ({
          running: false,
          pid: null,
          lastExitCode: 70,
          lastError: 'exited (code=70)',
        }),
      });
      expect(report.mcpChild?.running).toBe(false);
      expect(report.observability?.sections['mcpChild']).toBe('stale');
      expect(report.observability?.status).toBe('failed');
    });

    it('a throwing liveness getter degrades to absent, not a crash', async () => {
      const report = await collectHealth({
        ...baseDeps(),
        rankerHealth: () => {
          throw new Error('probe blew up');
        },
      });
      // No ranker section, and the health path still returns.
      expect(report.ranker).toBeUndefined();
      expect(report.observability?.status).toBe('ok');
    });
  });
});

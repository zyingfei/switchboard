import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createRecallLifecycle } from './lifecycle.js';
import { writeIndex } from './indexFile.js';

const FAKE_DIM = 384;

const seedEvents = async (vaultRoot: string, count: number): Promise<void> => {
  const dir = join(vaultRoot, '_BAC', 'events');
  await mkdir(dir, { recursive: true });
  const lines = Array.from({ length: count }, (_, ordinal) =>
    JSON.stringify({
      bac_id: 'thread_x',
      capturedAt: '2026-05-04T00:00:00.000Z',
      turns: [
        { ordinal, role: 'user', text: `seed turn ${String(ordinal)}` },
      ],
    }),
  );
  await writeFile(join(dir, '2026-05-04.jsonl'), `${lines.join('\n')}\n`);
};

describe('recall lifecycle', () => {
  it('reports missing when no index file is present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recall-lifecycle-missing-'));
    try {
      const lifecycle = createRecallLifecycle({
        vaultRoot: root,
        companionVersion: '0.0.0-test',
        currentModelId: 'test/model',
        rebuilder: () => Promise.resolve({ indexed: 0 }),
        log: () => undefined,
        warn: () => undefined,
      });
      const report = await lifecycle.report();
      expect(report.status).toBe('missing');
      expect(report.entryCount).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports stale when the index header model differs from the current one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recall-lifecycle-stale-'));
    try {
      const indexPath = join(root, '_BAC', 'recall', 'index.bin');
      const embedding = new Float32Array(FAKE_DIM);
      embedding[0] = 1;
      await writeIndex(
        indexPath,
        [{ id: 'turn_a', threadId: 'thread_a', capturedAt: '2026-05-04T00:00:00.000Z', embedding }],
        'old/model',
      );
      const lifecycle = createRecallLifecycle({
        vaultRoot: root,
        companionVersion: '0.0.0-test',
        currentModelId: 'new/model',
        rebuilder: () => Promise.resolve({ indexed: 1 }),
        log: () => undefined,
        warn: () => undefined,
      });
      const report = await lifecycle.report();
      expect(report.status).toBe('stale');
      expect(report.modelId).toBe('old/model');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ensureFresh schedules a background rebuild when stale and resolves to ready after it completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recall-lifecycle-rebuild-'));
    try {
      await seedEvents(root, 2);
      let calls = 0;
      const rebuilder = async (): Promise<{ readonly indexed: number }> => {
        calls += 1;
        const indexPath = join(root, '_BAC', 'recall', 'index.bin');
        const embedding = new Float32Array(FAKE_DIM);
        embedding[0] = 1;
        await writeIndex(
          indexPath,
          [
            { id: 'turn_a', threadId: 't', capturedAt: '2026-05-04T00:00:00.000Z', embedding },
            { id: 'turn_b', threadId: 't', capturedAt: '2026-05-04T00:00:00.000Z', embedding },
          ],
          'fresh/model',
        );
        return { indexed: 2 };
      };
      const lifecycle = createRecallLifecycle({
        vaultRoot: root,
        companionVersion: '0.0.0-test',
        currentModelId: 'fresh/model',
        rebuilder,
        log: () => undefined,
        warn: () => undefined,
      });
      const before = await lifecycle.ensureFresh();
      expect(before.status).toBe('missing');
      expect(lifecycle.isRebuilding()).toBe(true);
      await lifecycle.waitForRebuild();
      const after = await lifecycle.report();
      expect(after.status).toBe('ready');
      expect(after.entryCount).toBe(2);
      expect(after.lastRebuildIndexed).toBe(2);
      expect(calls).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('captures rebuilder errors without crashing the process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recall-lifecycle-error-'));
    try {
      const lifecycle = createRecallLifecycle({
        vaultRoot: root,
        companionVersion: '0.0.0-test',
        currentModelId: 'fresh/model',
        rebuilder: () => Promise.reject(new Error('embedder boom')),
        log: () => undefined,
        warn: () => undefined,
      });
      lifecycle.scheduleRebuild('manual');
      await lifecycle.waitForRebuild();
      const report = await lifecycle.report();
      expect(report.lastError).toBe('embedder boom');
      expect(report.status).toBe('missing');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('counts captured turns across multiple jsonl files for coverage hints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recall-lifecycle-coverage-'));
    try {
      await seedEvents(root, 3);
      const lifecycle = createRecallLifecycle({
        vaultRoot: root,
        companionVersion: '0.0.0-test',
        currentModelId: 'test/model',
        rebuilder: () => Promise.resolve({ indexed: 0 }),
        log: () => undefined,
        warn: () => undefined,
      });
      const report = await lifecycle.report();
      expect(report.eventTurnCount).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

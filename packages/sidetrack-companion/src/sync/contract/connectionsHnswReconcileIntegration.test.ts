import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createConnectionsStore } from '../../connections/snapshot.js';
import type { ConnectionsSnapshot } from '../../connections/snapshot.js';
import { DISPATCH_RECORDED } from '../../dispatches/events.js';
import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import { createTimelineStore } from '../../timeline/projection.js';
import { createEventLog, type EventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { createSyncContractRunner } from './runner.js';
import { createConnectionsMaterializer } from './connectionsMaterializer.js';
import {
  runReconcileInChild,
  setReconcileChildScriptOverride,
} from './connectionsReconcileChildClient.js';

const envKeys = [
  'SIDETRACK_TEST_EMBEDDER',
  'SIDETRACK_SKIP_RANKER_SNAPSHOT',
  'SIDETRACK_CONNECTIONS_INCREMENTAL_SIMILARITY',
  'SIDETRACK_SIMILARITY_THRESHOLD',
  'SIDETRACK_SIMILARITY_TOP_K',
  'SIDETRACK_SIMILARITY_MIN_ENGAGEMENT_MS',
  'SIDETRACK_CONNECTIONS_CHILD',
  'SIDETRACK_CONNECTIONS_PHASE_LOG',
] as const;

const childEntryPath = (): string =>
  join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'dist',
    'sync',
    'contract',
    'connectionsReconcileChild.entry.js',
  );

const appendVisit = async (
  eventLog: EventLog,
  input: {
    readonly index: number;
    readonly observedAt: string;
    readonly focusedWindowMs?: number;
    readonly title?: string;
    readonly variant?: string;
  },
): ReturnType<EventLog['appendClientObserved']> => {
  const eventId = `hnsw-visit-${String(input.index)}`;
  const clientEventId =
    input.variant === undefined ? eventId : `${eventId}-${input.variant}`;
  return eventLog.appendClientObserved({
    clientEventId,
    aggregateId: clientEventId,
    type: BROWSER_TIMELINE_OBSERVED,
    baseVector: {},
    payload: {
      eventId,
      observedAt: input.observedAt,
      url: `https://hnsw.test/${String(input.index)}`,
      canonicalUrl: `https://hnsw.test/${String(input.index)}`,
      title: input.title ?? `sidetrack_eval_postgres hnsw visit ${String(input.index)}`,
      provider: 'generic',
      transition: 'activated',
      payloadVersion: 1,
      dimensions: { engagement: { focusedWindowMs: input.focusedWindowMs ?? 10_000 } },
    },
  });
};

const appendDispatch = (
  eventLog: EventLog,
  input: { readonly index: number },
): ReturnType<EventLog['appendClientObserved']> =>
  eventLog.appendClientObserved({
    clientEventId: `hnsw-dispatch-${String(input.index)}`,
    aggregateId: `dispatch-${String(input.index)}`,
    type: DISPATCH_RECORDED,
    baseVector: {},
    payload: {
      bac_id: `dispatch-${String(input.index)}`,
      target: { provider: 'claude' },
      createdAt: '2026-05-22T10:00:00.000Z',
      body: 'summarize current work',
    },
  });

const hnswBasePath = (root: string): string =>
  join(root, '_BAC', 'connections', 'visit-similarity-hnsw');

const currentHnswVersion = async (root: string): Promise<string> =>
  (await readFile(`${hnswBasePath(root)}.current`, 'utf8')).trim();

const expectCurrentHnswFiles = async (root: string): Promise<void> => {
  const version = await currentHnswVersion(root);
  await expectFile(`${hnswBasePath(root)}.${version}.bin`);
  await expectFile(`${hnswBasePath(root)}.${version}.json`);
};

const similarityRows = (
  snapshot: ConnectionsSnapshot,
): ReadonlyArray<{ readonly pair: string; readonly cosine: number }> =>
  snapshot.edges
    .filter((edge) => edge.kind === 'visit_resembles_visit')
    .map((edge) => {
      const cosine = edge.metadata?.['cosine'];
      if (typeof cosine !== 'number') throw new Error('missing similarity cosine metadata');
      return {
        pair: `${edge.fromNodeId}\u0000${edge.toNodeId}`,
        cosine,
      };
    })
    .sort((left, right) => left.pair.localeCompare(right.pair));

const expectFile = async (path: string): Promise<void> => {
  const info = await stat(path);
  expect(info.isFile()).toBe(true);
  expect(info.size).toBeGreaterThan(0);
};

describe('HNSW reconcile child integration', () => {
  let vaultRoot: string;
  let previousEnv: Record<(typeof envKeys)[number], string | undefined>;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-hnsw-child-'));
    previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<
      (typeof envKeys)[number],
      string | undefined
    >;
    process.env['SIDETRACK_TEST_EMBEDDER'] = '1';
    process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'] = '1';
    delete process.env['SIDETRACK_CONNECTIONS_INCREMENTAL_SIMILARITY'];
    process.env['SIDETRACK_SIMILARITY_THRESHOLD'] = '0.8';
    process.env['SIDETRACK_SIMILARITY_TOP_K'] = '20';
    process.env['SIDETRACK_SIMILARITY_MIN_ENGAGEMENT_MS'] = '5000';
    setReconcileChildScriptOverride(childEntryPath());
  });

  afterEach(async () => {
    setReconcileChildScriptOverride(undefined);
    for (const key of envKeys) {
      const value = previousEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('persists HNSW similarity files and advances the snapshot in a real child process', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    let eventNowMs = Date.parse('2026-05-22T10:00:00.000Z');
    const eventLog = createEventLog(vaultRoot, replica, {
      now: () => new Date(eventNowMs),
    });
    const baselineStore = createConnectionsStore(vaultRoot);

    await appendVisit(eventLog, {
      index: 0,
      observedAt: '2026-05-22T10:00:00.000Z',
    });
    const baselineResult = await runReconcileInChild({ vaultRoot, seq: 1 });
    expect(baselineResult).toMatchObject({ seq: 1, ok: true });
    const baselineSnapshot = await baselineStore.readCurrent();
    expect(baselineSnapshot).not.toBeNull();

    for (let index = 1; index <= 20; index += 1) {
      eventNowMs = Date.parse(`2026-05-22T11:${String(index).padStart(2, '0')}:00.000Z`);
      await appendVisit(eventLog, {
        index,
        observedAt: `2026-05-22T11:${String(index).padStart(2, '0')}:00.000Z`,
      });
    }

    const result = await runReconcileInChild({ vaultRoot, seq: 2 });
    expect(result).toMatchObject({ seq: 2, ok: true });

    await expectCurrentHnswFiles(vaultRoot);

    const snapshot = await createConnectionsStore(vaultRoot).readCurrent();
    expect(snapshot).not.toBeNull();
    expect(Date.parse(snapshot!.updatedAt)).toBeGreaterThan(Date.parse(baselineSnapshot!.updatedAt));

    eventNowMs = Date.parse('2026-05-22T12:00:00.000Z');
    await appendVisit(eventLog, {
      index: 21,
      observedAt: '2026-05-22T12:00:00.000Z',
      focusedWindowMs: 1,
    });

    // Regression: this child reconcile has existing active HNSW entries but no newly
    // eligible visit to embed, so the materializer itself must load the persisted store.
    const noEligibleEmbeddingResult = await runReconcileInChild({ vaultRoot, seq: 3 });
    expect(noEligibleEmbeddingResult).toMatchObject({ seq: 3, ok: true });
  });

  it('does not full-rebuild HNSW in a child pass when no visits changed', async () => {
    process.env['SIDETRACK_CONNECTIONS_PHASE_LOG'] = '1';
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    for (let index = 0; index < 4; index += 1) {
      await appendVisit(eventLog, {
        index,
        observedAt: `2026-05-22T10:0${String(index)}:00.000Z`,
      });
    }
    expect(await runReconcileInChild({ vaultRoot, seq: 1 })).toMatchObject({ seq: 1, ok: true });
    await appendDispatch(eventLog, { index: 1 });

    const output: string[] = [];
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      output.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    });
    try {
      expect(await runReconcileInChild({ vaultRoot, seq: 2 })).toMatchObject({
        seq: 2,
        ok: true,
      });
    } finally {
      writeSpy.mockRestore();
    }

    expect(output.join('')).toContain('buildVisitSimilarityHnsw full=false touched=0');
  });

  it('marks parent health successful when a runner drain completes in a child process', async () => {
    process.env['SIDETRACK_CONNECTIONS_CHILD'] = '1';
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createConnectionsStore(vaultRoot);
    const materializer = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore: createTimelineStore(vaultRoot),
      store,
      diagnosticsStore: { write: async () => undefined },
      diagnosticsLogger: () => {},
    });
    const runner = createSyncContractRunner();
    runner.register(materializer);
    const accepted = await appendVisit(eventLog, {
      index: 0,
      observedAt: '2026-05-22T10:00:00.000Z',
    });
    const before = Date.now();

    runner.onAcceptedEvent(accepted, { origin: 'local' });
    await runner.awaitIdle();

    const health = runner.health()['connections'];
    expect(health?.pending).toBe(false);
    expect(health?.lastSuccessAt).not.toBeNull();
    expect(Date.parse(health!.lastSuccessAt!)).toBeGreaterThanOrEqual(before - 5_000);
  });

  it('recovers from a partial published pair on restart', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);

    await appendVisit(eventLog, {
      index: 0,
      observedAt: '2026-05-22T10:00:00.000Z',
    });
    expect(await runReconcileInChild({ vaultRoot, seq: 1 })).toMatchObject({ seq: 1, ok: true });
    await expectCurrentHnswFiles(vaultRoot);

    await writeFile(`${hnswBasePath(vaultRoot)}.current`, 'v999\n', 'utf8');
    await writeFile(`${hnswBasePath(vaultRoot)}.v999.json`, '{}\n', 'utf8');
    await appendVisit(eventLog, {
      index: 1,
      observedAt: '2026-05-22T10:01:00.000Z',
    });

    expect(await runReconcileInChild({ vaultRoot, seq: 2 })).toMatchObject({ seq: 2, ok: true });
    await expectCurrentHnswFiles(vaultRoot);
  });

  it('reconciles deleted and changed visit embeddings in the child HNSW path', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    for (let index = 0; index < 8; index += 1) {
      await appendVisit(eventLog, {
        index,
        observedAt: `2026-05-22T10:${String(index).padStart(2, '0')}:00.000Z`,
      });
    }
    expect(await runReconcileInChild({ vaultRoot, seq: 1 })).toMatchObject({ seq: 1, ok: true });
    const before = await createConnectionsStore(vaultRoot).readCurrent();
    if (before === null) throw new Error('expected initial HNSW snapshot');
    const beforeRows = similarityRows(before);

    await appendVisit(eventLog, {
      index: 1,
      variant: 'inactive',
      observedAt: '2026-05-22T11:01:00.000Z',
      focusedWindowMs: 1,
    });
    await appendVisit(eventLog, {
      index: 2,
      variant: 'changed',
      observedAt: '2026-05-22T11:02:00.000Z',
      title: 'completely different changed embedding text',
    });

    expect(await runReconcileInChild({ vaultRoot, seq: 2 })).toMatchObject({ seq: 2, ok: true });
    const after = await createConnectionsStore(vaultRoot).readCurrent();
    if (after === null) throw new Error('expected reconciled HNSW snapshot');
    const afterRows = similarityRows(after);

    expect(afterRows).not.toEqual(beforeRows);
    expect(afterRows.length).toBeLessThan(beforeRows.length);
  });

  it('matches pairwise similarity rows through the actual reconcile child', async () => {
    const pairwiseRoot = await mkdtemp(join(tmpdir(), 'sidetrack-hnsw-child-pairwise-'));
    try {
      for (const [root, incremental] of [
        [vaultRoot, '1'],
        [pairwiseRoot, '0'],
      ] as const) {
        process.env['SIDETRACK_CONNECTIONS_INCREMENTAL_SIMILARITY'] = incremental;
        const replica = await loadOrCreateReplica(root);
        const eventLog = createEventLog(root, replica);
        for (let index = 0; index < 16; index += 1) {
          await appendVisit(eventLog, {
            index,
            observedAt: `2026-05-22T10:${String(index).padStart(2, '0')}:00.000Z`,
          });
        }
        expect(await runReconcileInChild({ vaultRoot: root, seq: incremental === '1' ? 1 : 2 }))
          .toMatchObject({ ok: true });
      }

      const hnswSnapshot = await createConnectionsStore(vaultRoot).readCurrent();
      const pairwiseSnapshot = await createConnectionsStore(pairwiseRoot).readCurrent();
      if (hnswSnapshot === null || pairwiseSnapshot === null) {
        throw new Error('expected child snapshots for HNSW and pairwise runs');
      }

      expect(similarityRows(hnswSnapshot)).toEqual(similarityRows(pairwiseSnapshot));
    } finally {
      await rm(pairwiseRoot, { recursive: true, force: true });
    }
  });
});

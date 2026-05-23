import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConnectionsStore } from '../../connections/snapshot.js';
import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import { createEventLog, type EventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
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
  },
): Promise<void> => {
  await eventLog.appendClientObserved({
    clientEventId: `hnsw-visit-${String(input.index)}`,
    aggregateId: `hnsw-visit-${String(input.index)}`,
    type: BROWSER_TIMELINE_OBSERVED,
    baseVector: {},
    payload: {
      eventId: `hnsw-visit-${String(input.index)}`,
      observedAt: input.observedAt,
      url: `https://hnsw.test/${String(input.index)}`,
      canonicalUrl: `https://hnsw.test/${String(input.index)}`,
      title: `sidetrack_eval_postgres hnsw visit ${String(input.index)}`,
      provider: 'generic',
      transition: 'activated',
      payloadVersion: 1,
      dimensions: { engagement: { focusedWindowMs: 10_000 } },
    },
  });
};

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
    process.env['SIDETRACK_SIMILARITY_MIN_ENGAGEMENT_MS'] = '0';
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

    await expectFile(join(vaultRoot, '_BAC', 'connections', 'visit-similarity-hnsw.bin'));
    await expectFile(join(vaultRoot, '_BAC', 'connections', 'visit-similarity-hnsw.json'));

    const snapshot = await createConnectionsStore(vaultRoot).readCurrent();
    expect(snapshot).not.toBeNull();
    expect(Date.parse(snapshot!.updatedAt)).toBeGreaterThan(Date.parse(baselineSnapshot!.updatedAt));
  });
});

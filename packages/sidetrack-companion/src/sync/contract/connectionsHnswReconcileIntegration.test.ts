import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createConnectionsStore } from '../../connections/snapshot.js';
import type { ConnectionsSnapshot } from '../../connections/snapshot.js';
import { DISPATCH_RECORDED } from '../../dispatches/events.js';
import { ENGAGEMENT_SESSION_AGGREGATED } from '../../engagement/events.js';
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
  'SIDETRACK_CONNECTIONS_INCREMENTAL_SCOPES',
  'SIDETRACK_SIMILARITY_REQUALIFY',
  'SIDETRACK_EVENT_STORE',
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
  const clientEventId = input.variant === undefined ? eventId : `${eventId}-${input.variant}`;
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

// Append a late engagement.session.aggregated event that lifts an
// already-logged visit past the >=5000ms similarity gate. Mirrors the
// gap-backfill event shape (`visit:<url>` visitId) so the requalify
// resolver exercises the same canonical-URL mapping the live path uses.
const appendEngagementAggregate = (
  eventLog: EventLog,
  input: { readonly index: number; readonly focusedWindowMs: number },
): ReturnType<EventLog['appendClientObserved']> => {
  const url = `https://hnsw.test/${String(input.index)}`;
  const visitId = `visit:${url}`;
  return eventLog.appendClientObserved({
    clientEventId: `engagement-aggregate-${String(input.index)}`,
    aggregateId: `${ENGAGEMENT_SESSION_AGGREGATED}:${visitId}`,
    type: ENGAGEMENT_SESSION_AGGREGATED,
    baseVector: {},
    payload: {
      payloadVersion: 1,
      visitId,
      sessionId: `backfill:${visitId}`,
      dimensions: {
        engagement: {
          activeMs: input.focusedWindowMs,
          visibleMs: input.focusedWindowMs,
          focusedWindowMs: input.focusedWindowMs,
          idleMs: 0,
          foregroundBursts: 1,
          returnCount: 0,
          scrollEvents: 0,
          maxScrollRatio: 0,
          copyCount: 0,
          pasteCount: 0,
        },
      },
    },
  });
};

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

const rowTouchesVisit = (
  row: { readonly pair: string; readonly cosine: number },
  visitKeys: ReadonlySet<string>,
): boolean => {
  const [fromNodeId, toNodeId] = row.pair.split('\u0000');
  const prefix = 'timeline-visit:';
  const fromVisitKey =
    fromNodeId?.startsWith(prefix) === true ? fromNodeId.slice(prefix.length) : '';
  const toVisitKey = toNodeId?.startsWith(prefix) === true ? toNodeId.slice(prefix.length) : '';
  return visitKeys.has(fromVisitKey) || visitKeys.has(toVisitKey);
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
    delete process.env['SIDETRACK_SIMILARITY_REQUALIFY'];
    delete process.env['SIDETRACK_EVENT_STORE'];
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
    expect(Date.parse(snapshot!.updatedAt)).toBeGreaterThan(
      Date.parse(baselineSnapshot!.updatedAt),
    );

    eventNowMs = Date.parse('2026-05-22T12:00:00.000Z');
    await appendVisit(eventLog, {
      index: 21,
      observedAt: '2026-05-22T12:00:00.000Z',
      focusedWindowMs: 1,
    });

    // Regression: this child reconcile has existing active HNSW entries but no newly
    // eligible visit to embed, so the materializer itself must load the persisted store.
    process.env['SIDETRACK_CONNECTIONS_PHASE_LOG'] = '1';
    const output: string[] = [];
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      output.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    });
    try {
      const noEligibleEmbeddingResult = await runReconcileInChild({ vaultRoot, seq: 3 });
      expect(noEligibleEmbeddingResult).toMatchObject({ seq: 3, ok: true });
    } finally {
      writeSpy.mockRestore();
    }
    const phaseOutput = output.join('');
    expect(phaseOutput).toContain(
      'pageEvidence.ensure records=1 ensured=1 full=false bounded=true',
    );
    expect(phaseOutput).toContain('buildVisitSimilarityHnsw full=false touched=0');
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

    // A dispatch is a no-graph event: it routes to the progress-only path,
    // which skips the HNSW pass entirely (so there's no buildVisitSimilarityHnsw
    // line at all). The invariant is simply that it NEVER triggers a full
    // HNSW rebuild when no visits changed.
    expect(output.join('')).not.toContain('buildVisitSimilarityHnsw full=true');
  });

  it('incrementally inserts new visits without full-rebuilding the child HNSW store', async () => {
    process.env['SIDETRACK_CONNECTIONS_PHASE_LOG'] = '1';
    process.env['SIDETRACK_CONNECTIONS_INCREMENTAL_SCOPES'] = '0';
    const fullRebuildRoot = await mkdtemp(join(tmpdir(), 'sidetrack-hnsw-child-full-'));
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const observedAtForIndex = (index: number): string =>
      index < 100
        ? new Date(Date.parse('2026-05-22T10:00:00.000Z') + index * 60_000).toISOString()
        : `2026-05-22T11:${String(index - 100).padStart(2, '0')}:00.000Z`;
    const appendRangeWithoutDrain = async (
      root: string,
      start: number,
      end: number,
    ): Promise<void> => {
      const rangeReplica = await loadOrCreateReplica(root);
      const rangeEventLog = createEventLog(root, rangeReplica);
      for (let index = start; index < end; index += 1) {
        await appendVisit(rangeEventLog, {
          index,
          observedAt: observedAtForIndex(index),
        });
      }
    };

    try {
      for (let index = 0; index < 100; index += 1) {
        await appendVisit(eventLog, {
          index,
          observedAt: observedAtForIndex(index),
        });
      }
      expect(await runReconcileInChild({ vaultRoot, seq: 1 })).toMatchObject({
        seq: 1,
        ok: true,
      });
      const before = await createConnectionsStore(vaultRoot).readCurrent();
      if (before === null) throw new Error('expected initial HNSW snapshot');
      const beforeRows = similarityRows(before);

      const newVisitKeys = new Set<string>();
      for (let index = 100; index < 105; index += 1) {
        const visitKey = `https://hnsw.test/${String(index)}`;
        newVisitKeys.add(visitKey);
        await appendVisit(eventLog, {
          index,
          observedAt: observedAtForIndex(index),
        });
      }

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

      const phaseOutput = output.join('');
      expect(phaseOutput).toContain('buildVisitSimilarityHnsw full=false touched=5');
      const hnswBuildMs = /buildVisitSimilarityHnsw full=false touched=5 edges=\d+ dt=(\d+)ms/u.exec(
        phaseOutput,
      )?.[1];
      expect(hnswBuildMs).toBeDefined();
      expect(Number(hnswBuildMs)).toBeLessThan(500);

      const after = await createConnectionsStore(vaultRoot).readCurrent();
      if (after === null) throw new Error('expected incremental HNSW snapshot');
      const afterRows = similarityRows(after);
      const newRows = afterRows.filter((row) => rowTouchesVisit(row, newVisitKeys));
      expect(newRows.length).toBeGreaterThan(0);
      expect(afterRows.length).toBeGreaterThan(beforeRows.length);

      await appendRangeWithoutDrain(fullRebuildRoot, 0, 105);
      expect(await runReconcileInChild({ vaultRoot: fullRebuildRoot, seq: 3 })).toMatchObject({
        seq: 3,
        ok: true,
      });
      const fullRebuildSnapshot = await createConnectionsStore(fullRebuildRoot).readCurrent();
      if (fullRebuildSnapshot === null) throw new Error('expected full-rebuild HNSW snapshot');
      const fullRows = similarityRows(fullRebuildSnapshot);
      expect(afterRows.length, phaseOutput).toBe(fullRows.length);
      expect(afterRows).toEqual(fullRows);
    } finally {
      await rm(fullRebuildRoot, { recursive: true, force: true });
    }
  }, 90_000);

  it('keeps large additive HNSW drift incremental and byte-equivalent to a full rebuild', async () => {
    process.env['SIDETRACK_CONNECTIONS_PHASE_LOG'] = '1';
    const fullRebuildRoot = await mkdtemp(join(tmpdir(), 'sidetrack-hnsw-child-full-'));
    const baselineCount = 8;
    const additiveCount = 20;
    const appendRange = async (
      root: string,
      start: number,
      end: number,
      seq: number,
    ): Promise<void> => {
      const replica = await loadOrCreateReplica(root);
      const eventLog = createEventLog(root, replica);
      for (let index = start; index < end; index += 1) {
        const observedAt = new Date(
          Date.parse('2026-05-22T10:00:00.000Z') + index * 60_000,
        ).toISOString();
        await appendVisit(eventLog, {
          index,
          observedAt,
          title:
            index < baselineCount
              ? `sidetrack_eval_postgres baseline visit ${String(index)}`
              : `sidetrack_eval_kubernetes additive visit ${String(index)}`,
        });
      }
      expect(await runReconcileInChild({ vaultRoot: root, seq })).toMatchObject({
        seq,
        ok: true,
      });
    };
    const appendRangeWithoutDrain = async (
      root: string,
      start: number,
      end: number,
    ): Promise<void> => {
      const replica = await loadOrCreateReplica(root);
      const eventLog = createEventLog(root, replica);
      for (let index = start; index < end; index += 1) {
        const observedAt = new Date(
          Date.parse('2026-05-22T10:00:00.000Z') + index * 60_000,
        ).toISOString();
        await appendVisit(eventLog, {
          index,
          observedAt,
          title:
            index < baselineCount
              ? `sidetrack_eval_postgres baseline visit ${String(index)}`
              : `sidetrack_eval_kubernetes additive visit ${String(index)}`,
        });
      }
    };

    try {
      await appendRange(vaultRoot, 0, baselineCount, 1);
      await appendRangeWithoutDrain(vaultRoot, baselineCount, baselineCount + additiveCount);

      const incrementalOutput: string[] = [];
      const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        incrementalOutput.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
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

      const phaseOutput = incrementalOutput.join('');
      expect(phaseOutput).toContain(
        `buildVisitSimilarityHnsw full=false touched=${String(additiveCount)}`,
      );
      expect(phaseOutput).toContain('replaceScopeRows scopedTimelineDelta');
      expect(phaseOutput).toContain('hnswNotFull=true');
      expect(phaseOutput).not.toContain('buildConnectionsSnapshot base');

      await appendRangeWithoutDrain(fullRebuildRoot, 0, baselineCount + additiveCount);
      expect(await runReconcileInChild({ vaultRoot: fullRebuildRoot, seq: 1 })).toMatchObject({
        seq: 1,
        ok: true,
      });

      const incrementalSnapshot = await createConnectionsStore(vaultRoot).readCurrent();
      const fullRebuildSnapshot = await createConnectionsStore(fullRebuildRoot).readCurrent();
      if (incrementalSnapshot === null || fullRebuildSnapshot === null) {
        throw new Error('expected incremental and full-rebuild snapshots');
      }
      expect(similarityRows(incrementalSnapshot)).toEqual(similarityRows(fullRebuildSnapshot));
    } finally {
      await rm(fullRebuildRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('reuses existing HNSW labels — touched is the set difference, not dirty-scopes', async () => {
    process.env['SIDETRACK_CONNECTIONS_PHASE_LOG'] = '1';
    process.env['SIDETRACK_CONNECTIONS_INCREMENTAL_SCOPES'] = '0';
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    for (let index = 0; index < 50; index += 1) {
      const observedAt = new Date(
        Date.parse('2026-05-22T10:00:00.000Z') + index * 60_000,
      ).toISOString();
      await appendVisit(eventLog, {
        index,
        observedAt,
      });
    }

    expect(await runReconcileInChild({ vaultRoot, seq: 1 })).toMatchObject({ seq: 1, ok: true });

    for (let index = 50; index < 53; index += 1) {
      await appendVisit(eventLog, {
        index,
        observedAt: `2026-05-22T11:${String(index - 50).padStart(2, '0')}:00.000Z`,
      });
    }

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

    expect(output.join('')).toContain('buildVisitSimilarityHnsw full=false touched=3');
  });

  it('requalifies an old visit into the reconcile set when late engagement crosses the gate', async () => {
    // Regression for the engagement-regression starvation: a visit
    // observed below the >=5000ms gate is inserted into the HNSW store
    // but forms no similarity edges. When a LATE engagement aggregate
    // (a gap-backfill event) lifts it past the gate on a later drain,
    // the scoped-delta reconcile set used to skip it entirely (its URL
    // was never in pendingTimelineVisitIds), so the similarity edges
    // never reformed. The requalify path must pull it back in.
    process.env['SIDETRACK_CONNECTIONS_PHASE_LOG'] = '1';
    process.env['SIDETRACK_CONNECTIONS_INCREMENTAL_SCOPES'] = '0';
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);

    // A corpus of eligible visits (index 0..7, default focusedWindowMs
    // 10_000) that all share the sidetrack_eval_postgres title token so
    // the requalified target has neighbours to resemble.
    for (let index = 0; index < 8; index += 1) {
      await appendVisit(eventLog, {
        index,
        observedAt: `2026-05-22T10:0${String(index)}:00.000Z`,
      });
    }
    // The target visit (index 8) starts BELOW the gate — inserted but
    // edge-less. Same title token so it would resemble the corpus once
    // eligible.
    await appendVisit(eventLog, {
      index: 8,
      observedAt: '2026-05-22T10:08:00.000Z',
      focusedWindowMs: 1,
    });
    expect(await runReconcileInChild({ vaultRoot, seq: 1 })).toMatchObject({ seq: 1, ok: true });

    const targetVisitKey = 'https://hnsw.test/8';
    const before = await createConnectionsStore(vaultRoot).readCurrent();
    if (before === null) throw new Error('expected baseline snapshot');
    const beforeTargetRows = similarityRows(before).filter((row) =>
      rowTouchesVisit(row, new Set([targetVisitKey])),
    );
    expect(beforeTargetRows.length).toBe(0);

    // Late engagement aggregate lifts the target past the gate. No new
    // BROWSER_TIMELINE_OBSERVED for the target — this is the exact live
    // gap: only the engagement event arrives.
    await appendEngagementAggregate(eventLog, { index: 8, focusedWindowMs: 60_000 });

    const output: string[] = [];
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      output.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
    try {
      expect(await runReconcileInChild({ vaultRoot, seq: 2 })).toMatchObject({ seq: 2, ok: true });
    } finally {
      writeSpy.mockRestore();
    }
    // The phase log must show the target was requalified into the set.
    expect(output.join('')).toContain('requalified=1');

    const after = await createConnectionsStore(vaultRoot).readCurrent();
    if (after === null) throw new Error('expected reconciled snapshot');
    const afterTargetRows = similarityRows(after).filter((row) =>
      rowTouchesVisit(row, new Set([targetVisitKey])),
    );
    expect(afterTargetRows.length).toBeGreaterThan(0);
  });

  it('requalifies a late-engagement visit via the typed event-store read (no full-log rebuild)', async () => {
    // Fix regression: the requalify re-derive used a full-log readMerged()
    // + full timeline + full engagement rebuild ON THE DRAIN THREAD. On the
    // 452k-event vault a routine session aggregate firing ~30s after a
    // visit (past the drain interval, so the visit has left the window)
    // triggered that per-drain full-log scan. With the event store on, the
    // re-derive now sources ONLY the requalify-relevant event types via the
    // type index (events_type_idx). This test drives the exact same late-
    // engagement requalify scenario with the store ENABLED, so the typed-
    // read branch runs, and asserts the requalified edge still forms —
    // proving the typed source is byte-equivalent to the readMerged path.
    process.env['SIDETRACK_CONNECTIONS_PHASE_LOG'] = '1';
    process.env['SIDETRACK_CONNECTIONS_INCREMENTAL_SCOPES'] = '0';
    process.env['SIDETRACK_EVENT_STORE'] = '1';
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);

    for (let index = 0; index < 8; index += 1) {
      await appendVisit(eventLog, {
        index,
        observedAt: `2026-05-22T10:0${String(index)}:00.000Z`,
      });
    }
    await appendVisit(eventLog, {
      index: 8,
      observedAt: '2026-05-22T10:08:00.000Z',
      focusedWindowMs: 1,
    });
    expect(await runReconcileInChild({ vaultRoot, seq: 1 })).toMatchObject({ seq: 1, ok: true });

    const targetVisitKey = 'https://hnsw.test/8';
    const before = await createConnectionsStore(vaultRoot).readCurrent();
    if (before === null) throw new Error('expected baseline snapshot');
    expect(
      similarityRows(before).filter((row) => rowTouchesVisit(row, new Set([targetVisitKey]))).length,
    ).toBe(0);

    // Late engagement aggregate only — no fresh BROWSER_TIMELINE_OBSERVED,
    // so the target is out-of-window and hits the requalify re-derive.
    await appendEngagementAggregate(eventLog, { index: 8, focusedWindowMs: 60_000 });

    const output: string[] = [];
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      output.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
    try {
      expect(await runReconcileInChild({ vaultRoot, seq: 2 })).toMatchObject({ seq: 2, ok: true });
    } finally {
      writeSpy.mockRestore();
    }
    expect(output.join('')).toContain('requalified=1');

    const after = await createConnectionsStore(vaultRoot).readCurrent();
    if (after === null) throw new Error('expected reconciled snapshot');
    expect(
      similarityRows(after).filter((row) => rowTouchesVisit(row, new Set([targetVisitKey]))).length,
    ).toBeGreaterThan(0);
  });

  it('does not requalify a late-engagement visit when the kill-switch is set', async () => {
    process.env['SIDETRACK_CONNECTIONS_PHASE_LOG'] = '1';
    process.env['SIDETRACK_CONNECTIONS_INCREMENTAL_SCOPES'] = '0';
    process.env['SIDETRACK_SIMILARITY_REQUALIFY'] = '0';
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    for (let index = 0; index < 8; index += 1) {
      await appendVisit(eventLog, {
        index,
        observedAt: `2026-05-22T10:0${String(index)}:00.000Z`,
      });
    }
    await appendVisit(eventLog, {
      index: 8,
      observedAt: '2026-05-22T10:08:00.000Z',
      focusedWindowMs: 1,
    });
    expect(await runReconcileInChild({ vaultRoot, seq: 1 })).toMatchObject({ seq: 1, ok: true });

    await appendEngagementAggregate(eventLog, { index: 8, focusedWindowMs: 60_000 });

    const output: string[] = [];
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      output.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
    try {
      expect(await runReconcileInChild({ vaultRoot, seq: 2 })).toMatchObject({ seq: 2, ok: true });
    } finally {
      writeSpy.mockRestore();
    }
    // Kill-switch: the requalify resolver must be inert (requalified=0).
    expect(output.join('')).toContain('requalified=0');
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
        expect(
          await runReconcileInChild({ vaultRoot: root, seq: incremental === '1' ? 1 : 2 }),
        ).toMatchObject({ ok: true });
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

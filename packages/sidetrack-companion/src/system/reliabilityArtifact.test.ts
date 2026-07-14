import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import { createEventLog } from '../sync/eventLog.js';
import { RECALL_ACTION, RECALL_SERVED } from '../recall/events.js';
import {
  RELIABILITY_ARTIFACT_MAX_AGE_MS,
  isReliabilityArtifactFresh,
  readReliabilityArtifact,
  reliabilityArtifactPath,
  writeReliabilityArtifact,
} from './reliabilityArtifact.js';

const NOW = new Date('2026-07-13T12:00:00.000Z');

let vaultRoot = '';

const makeEventLog = () => {
  let seq = 0;
  return createEventLog(vaultRoot, {
    replicaId: '11111111-1111-4111-8111-111111111111',
    created: true,
    nextSeq: async () => {
      seq += 1;
      return seq;
    },
    peekSeq: () => seq,
    observeSeq: async (incoming: number) => {
      seq = Math.max(seq, incoming);
    },
  });
};

let peerSeq = 0;
const peerEvent = (type: string, payload: unknown, aggregateId: string): AcceptedEvent => {
  peerSeq += 1;
  return {
    clientEventId: `peer-${type}-${String(peerSeq)}`,
    dot: { replicaId: '22222222-2222-4222-8222-222222222222', seq: peerSeq },
    deps: {},
    aggregateId,
    type,
    payload,
    acceptedAtMs: NOW.getTime(),
  };
};

beforeEach(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-reliability-'));
  peerSeq = 0;
});

afterEach(async () => {
  await rm(vaultRoot, { recursive: true, force: true });
});

describe('writeReliabilityArtifact / readReliabilityArtifact — round-trip', () => {
  it('materializes a per-surface reliability report from the event log', async () => {
    const eventLog = makeEventLog();
    await eventLog.importPeerEvent(
      peerEvent(
        RECALL_SERVED,
        {
          payloadVersion: 2,
          servedContextId: 'ctx-1',
          query: 'q',
          intent: 'search',
          surface: 'search',
          results: [
            { entityId: 'a', sourceKind: 'semantic_query', fusedScore: 0.9, servedPosition: 0, propensity: 1.0 },
            { entityId: 'b', sourceKind: 'bm25', fusedScore: 0.3, servedPosition: 1, propensity: 1.0 },
          ],
          rerankApplied: false,
          sequenceNumber: 1,
          servedAt: NOW.toISOString(),
        },
        'ctx-1',
      ),
    );
    await eventLog.importPeerEvent(
      peerEvent(
        RECALL_ACTION,
        {
          payloadVersion: 1,
          servedContextId: 'ctx-1',
          entityId: 'a',
          actionKind: 'click',
          actionAt: NOW.toISOString(),
        },
        'ctx-1',
      ),
    );

    const written = await writeReliabilityArtifact({ vaultRoot, eventLog, now: () => NOW });
    expect(written.schemaVersion).toBe(1);
    expect(written.generatedAt).toBe(NOW.toISOString());
    expect(written.report.surfaces.map((s) => s.surface)).toEqual(['search']);
    const search = written.report.surfaces[0];
    expect(search?.fit.sampleCount).toBe(2);
    expect(search?.fit.positiveCount).toBe(1);
    expect(search?.fit.rawReliability.bins.length).toBe(10);

    // Read it back from disk — same content.
    const readBack = await readReliabilityArtifact(vaultRoot);
    expect(readBack).not.toBeNull();
    expect(readBack?.report.surfaces[0]?.surface).toBe('search');
    expect(readBack?.report.totalSamples).toBe(2);
  });

  it('produces an empty-but-valid report when there are no engaged impressions', async () => {
    const eventLog = makeEventLog();
    const written = await writeReliabilityArtifact({ vaultRoot, eventLog, now: () => NOW });
    expect(written.report.surfaces.length).toBe(0);
    expect(written.report.totalSamples).toBe(0);
    const readBack = await readReliabilityArtifact(vaultRoot);
    expect(readBack?.report.totalSamples).toBe(0);
  });
});

describe('readReliabilityArtifact — lenient reader', () => {
  it('returns null when the file is missing', async () => {
    expect(await readReliabilityArtifact(vaultRoot)).toBeNull();
  });

  it('returns null on a schemaVersion mismatch', async () => {
    const path = reliabilityArtifactPath(vaultRoot);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ schemaVersion: 999, generatedAt: NOW.toISOString(), report: { surfaces: [] } }),
      'utf8',
    );
    expect(await readReliabilityArtifact(vaultRoot)).toBeNull();
  });

  it('returns null on corrupt JSON', async () => {
    const path = reliabilityArtifactPath(vaultRoot);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{ not json', 'utf8');
    expect(await readReliabilityArtifact(vaultRoot)).toBeNull();
  });

  it('returns null when the report envelope is malformed (no surfaces array)', async () => {
    const path = reliabilityArtifactPath(vaultRoot);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ schemaVersion: 1, generatedAt: NOW.toISOString(), report: {} }),
      'utf8',
    );
    expect(await readReliabilityArtifact(vaultRoot)).toBeNull();
  });
});

describe('isReliabilityArtifactFresh', () => {
  it('is fresh within the max age and stale beyond it', () => {
    const artifact = {
      schemaVersion: 1,
      generatedAt: NOW.toISOString(),
      report: { generatedAt: NOW.toISOString(), numBins: 10, surfaces: [], totalSamples: 0 },
    };
    const justInside = new Date(NOW.getTime() + RELIABILITY_ARTIFACT_MAX_AGE_MS - 1);
    const justOutside = new Date(NOW.getTime() + RELIABILITY_ARTIFACT_MAX_AGE_MS + 1);
    expect(isReliabilityArtifactFresh(artifact, () => justInside)).toBe(true);
    expect(isReliabilityArtifactFresh(artifact, () => justOutside)).toBe(false);
  });

  it('treats an unparseable generatedAt as stale', () => {
    const artifact = {
      schemaVersion: 1,
      generatedAt: 'not-a-date',
      report: { generatedAt: 'not-a-date', numBins: 10, surfaces: [], totalSamples: 0 },
    };
    expect(isReliabilityArtifactFresh(artifact, () => NOW)).toBe(false);
  });
});

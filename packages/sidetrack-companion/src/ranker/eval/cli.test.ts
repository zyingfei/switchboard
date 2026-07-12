import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeExtractedPageEvidenceFast } from '../../page-evidence/store.js';
import {
  RECALL_ACTION,
  RECALL_SERVED,
  type RecallActionKind,
  type RecallServedCandidateSnapshot,
} from '../../recall/events.js';
import { createEventLog } from '../../sync/eventLog.js';
import { loadOrCreateReplica } from '../../sync/replicaId.js';
import { CANDIDATE_PAIR_FEATURE_KEYS, FEATURE_SCHEMA_VERSION } from '../feature-schema.js';
import { runConnectionsPrecisionEval, runReplayEval } from './cli.js';
import { readReplayEvalVerdict, replayEvalVerdictPath } from './verdictArtifact.js';

const BASE_TIME = Date.parse('2026-06-10T09:00:00.000Z');

const featureVector = (servedPositionOneBased: number, cosine: number): number[] => {
  const map: Record<string, number> = {
    schemaVersion: FEATURE_SCHEMA_VERSION,
    served_position: servedPositionOneBased,
    cosine_similarity: cosine,
  };
  return CANDIDATE_PAIR_FEATURE_KEYS.map((key) => map[key] ?? 0);
};

const candidate = (
  entityId: string,
  servedPosition: number,
  cosine: number,
): RecallServedCandidateSnapshot => ({
  entityId,
  sourceKind: 'timeline_visit',
  canonicalUrl: `https://vault.test/${entityId}`,
  fusedScore: 1 / (servedPosition + 1),
  servedPosition,
  features: featureVector(servedPosition + 1, cosine),
  featureSchemaVersion: FEATURE_SCHEMA_VERSION,
});

const writeEvidence = async (
  vaultRoot: string,
  entityId: string,
  title: string,
  body: string,
): Promise<void> => {
  await writeExtractedPageEvidenceFast(
    vaultRoot,
    {
      payloadVersion: 1,
      canonicalUrl: `https://vault.test/${entityId}`,
      url: `https://vault.test/${entityId}`,
      title,
      extractedAt: new Date(BASE_TIME).toISOString(),
      extractionSource: 'reader-mode',
      extractionPolicy: { trigger: 'manual' },
      quality: 'high',
      qualitySignals: {
        extractedWordCount: body.split(/\s+/).length,
        contentToDomRatio: 0.7,
        boilerplateFraction: 0.1,
        extractionStrategy: 'reader-mode',
      },
      content: {
        text: body,
        contentHash: `hash-${entityId}`,
        charCount: body.length,
      },
      storageMode: 'indexed_chunks',
    },
    { embeddingsEnabled: false, rebuildManifestAfterWrite: false },
  );
};

let vaultRoot: string;
afterEach(async () => {
  if (vaultRoot !== undefined) await rm(vaultRoot, { recursive: true, force: true });
});

describe('runReplayEval (CLI orchestration, reads from disk)', () => {
  it('reads a vault event log + page evidence, ranks the BM25 floor by content, and persists the verdict', async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'replay-cli-'));
    const replica = await loadOrCreateReplica(vaultRoot);
    const log = createEventLog(vaultRoot, replica);

    // Query "postgres merge" — the POSITIVE candidate's vault content is the
    // only doc mentioning both terms, so the grep-over-vault floor should
    // rank it first (nDCG@10 = 1) even though its served/cosine order is 2nd.
    await writeEvidence(
      vaultRoot,
      'c_pos',
      'Postgres MERGE concurrency',
      'postgres merge write skew concurrency handling',
    );
    await writeEvidence(vaultRoot, 'c_hi', 'Invoice aging report', 'invoice aging reconciliation');
    await writeEvidence(vaultRoot, 'c_lo', 'Kubernetes eviction', 'pod eviction pressure budget');

    // Served: c_hi has the highest cosine (baseline/served would rank it 1st).
    const candidates = [
      candidate('c_hi', 0, 0.9),
      candidate('c_pos', 1, 0.5),
      candidate('c_lo', 2, 0.1),
    ];
    await log.appendClient({
      clientEventId: 'served-imp1',
      aggregateId: 'imp1',
      type: RECALL_SERVED,
      payload: {
        payloadVersion: 1,
        servedContextId: 'imp1',
        query: 'postgres merge',
        intent: 'search',
        sessionContext: { currentUrl: 'https://vault.test/anchor' },
        results: candidates,
        rerankApplied: false,
        sequenceNumber: 1,
        servedAt: new Date(BASE_TIME).toISOString(),
      },
      baseVector: {},
    });
    const action = async (entityId: string, kind: RecallActionKind): Promise<void> => {
      await log.appendClient({
        clientEventId: `action-${entityId}`,
        aggregateId: 'imp1',
        type: RECALL_ACTION,
        payload: {
          payloadVersion: 1,
          servedContextId: 'imp1',
          entityId,
          actionKind: kind,
          actionAt: new Date(BASE_TIME + 1000).toISOString(),
        },
        baseVector: {},
      });
    };
    await action('c_pos', 'flow_confirm');
    await action('c_lo', 'reject');

    const result = await runReplayEval(vaultRoot, { persist: true });

    // BM25 floor ranks c_pos first (only doc with both query terms) → nDCG=1.
    const bm25 = result.report.arms.find((arm) => arm.id === 'grep_bm25')!;
    expect(bm25.available).toBe(true);
    expect(bm25.metrics.nDcgAt10).toBeCloseTo(1, 12);

    // Graph baseline ranks c_hi (highest cosine) first, c_pos second →
    // nDCG@10 = 1/log2(3) < 1: the honest floor BEATS the baseline here.
    const baseline = result.report.arms.find((arm) => arm.id === 'graph_baseline')!;
    expect(baseline.metrics.nDcgAt10).toBeLessThan(bm25.metrics.nDcgAt10);

    // Verdict persisted to disk, report-only, round-trips.
    expect(result.verdictPath).toBe(replayEvalVerdictPath(vaultRoot));
    const onDisk = await readReplayEvalVerdict(vaultRoot);
    expect(onDisk).not.toBeNull();
    expect(onDisk!.reportOnly).toBe(true);
    expect(onDisk!.impressionsWithPositiveCount).toBe(1);
    const raw = await readFile(replayEvalVerdictPath(vaultRoot), 'utf8');
    expect(JSON.parse(raw).schemaVersion).toBe(onDisk!.schemaVersion);
  });

  it('does not persist the verdict when persist=false', async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'replay-cli-'));
    const replica = await loadOrCreateReplica(vaultRoot);
    const log = createEventLog(vaultRoot, replica);
    await log.appendClient({
      clientEventId: 'served-empty',
      aggregateId: 'imp0',
      type: RECALL_SERVED,
      payload: {
        payloadVersion: 1,
        servedContextId: 'imp0',
        query: 'q',
        intent: 'search',
        results: [candidate('x', 0, 0.5)],
        rerankApplied: false,
        sequenceNumber: 1,
        servedAt: new Date(BASE_TIME).toISOString(),
      },
      baseVector: {},
    });
    const result = await runReplayEval(vaultRoot, { persist: false });
    expect(result.verdictPath).toBeNull();
    expect(await readReplayEvalVerdict(vaultRoot)).toBeNull();
  });
});

describe('runConnectionsPrecisionEval (CLI orchestration)', () => {
  it('runs read-only over a vault with no committed snapshot and reports empty precision', async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'conn-prec-cli-'));
    await loadOrCreateReplica(vaultRoot);
    const result = await runConnectionsPrecisionEval(vaultRoot);
    // No snapshot on disk → empty placeholder → zero served edges.
    expect(result.report.totalServedSimilarityEdges).toBe(0);
    expect(result.report.overallPrecision).toBeNull();
  });
});

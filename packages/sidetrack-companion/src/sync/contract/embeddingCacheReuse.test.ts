import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the embedder + count its calls. The cache reuse claim is
// "metadata-only extractor upgrade reuses vectors keyed by
// embedTextHash — embedder is NOT called again." This test makes
// the embedder counter the primary assertion.
const embedCalls: { texts: string[] }[] = [];
vi.mock('../../recall/embedder.js', async () => {
  const real = await vi.importActual<typeof import('../../recall/embedder.js')>(
    '../../recall/embedder.js',
  );
  return {
    ...real,
    embed: async (texts: readonly string[]) => {
      embedCalls.push({ texts: [...texts] });
      return texts.map(() => {
        const v = new Float32Array(384);
        v[0] = 1;
        return v;
      });
    },
  };
});

import { createRecallActivityTracker } from '../../recall/activity.js';
import { createEmbeddingCache } from '../../recall/embeddingCache.js';
import { createExtractionStore } from '../../recall/extraction/store.js';
import type { ExtractionRevision, ExtractionSourceState } from '../../recall/extraction/types.js';
import { createRecallLifecycle } from '../../recall/lifecycle.js';
import { createEventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { createRecallMaterializer } from './recallMaterializer.js';
import { createSyncContractRunner } from './runner.js';

// L2-G2 — same sourceUnitId, metadata-only extraction improvement
// → embedding cache reuses vector; embedder NOT called for unchanged
// text.

describe('Lane 2 / L2-G2 — embedding cache reuse', () => {
  let vaultRoot: string;
  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-l2-cache-'));
    embedCalls.length = 0;
  });
  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const setUp = async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const recallActivity = createRecallActivityTracker();
    const recallLifecycle = createRecallLifecycle({
      vaultRoot,
      companionVersion: 'test',
      activity: recallActivity,
      replica: { replicaId: replica.replicaId, nextSeq: replica.nextSeq },
      eventLog,
    });
    await recallLifecycle.ensureFresh();
    await recallLifecycle.waitForRebuild();
    const store = createExtractionStore(vaultRoot);
    const indexPath = join(vaultRoot, '_BAC', 'recall', 'index.bin');
    const cache = createEmbeddingCache(vaultRoot);
    const runner = createSyncContractRunner();
    runner.register(
      createRecallMaterializer({
        recallLifecycle,
        recallActivity,
        eventLog,
        extractionStore: store,
        indexPath,
        embeddingCache: cache,
      }),
    );
    return { eventLog, runner, store, cache };
  };

  const makeRev = (input: {
    sourceUnitId: string;
    extractionRevisionId: string;
    text: string;
    extractorVersion: string;
    extractionSchemaVersion: number;
  }): ExtractionRevision => ({
    extractionRevisionId: input.extractionRevisionId,
    sourceUnitId: input.sourceUnitId,
    sourceBacId: 'thread-x',
    extractorId: 'legacy',
    extractorVersion: input.extractorVersion,
    extractionSchemaVersion: input.extractionSchemaVersion,
    inputHash: 'h1',
    outputHash: 'h2',
    chunkerVersion: 'legacy',
    createdAt: '2026-05-07T00:00:00.000Z',
    producerReplicaId: 'peer-A',
    producerDot: { replicaId: 'peer-A', seq: 1 },
    content: {
      turns: [{ ordinal: 0, role: 'user', text: input.text }],
      title: 'Cache test',
      threadUrl: 'https://example.test/x',
      capturedAt: '2026-05-07T00:00:00.000Z',
    },
  });

  it('metadata-only upgrade — same chunk text → cache hits → embedder NOT called for second revision', async () => {
    const { eventLog, runner, store } = await setUp();

    // First reconcile: v1 with text T. Embedder runs.
    const v1 = makeRev({
      sourceUnitId: 'src:thread-x:0',
      extractionRevisionId: 'rev-v1',
      text: 'identical text across upgrades',
      extractorVersion: '1.0.0',
      extractionSchemaVersion: 1,
    });
    await store.putRevision(v1);
    const baseState: ExtractionSourceState = {
      sourceUnitId: v1.sourceUnitId,
      sourceBacId: v1.sourceBacId,
      latestExtractionRevision: v1.extractionRevisionId,
      status: 'stale',
      history: [
        {
          extractionRevisionId: v1.extractionRevisionId,
          extractorId: v1.extractorId,
          extractorVersion: v1.extractorVersion,
          createdAt: v1.createdAt,
        },
      ],
    };
    await store.putSourceState(baseState);
    await runner.catchUpAll(eventLog);
    const firstReconcileEmbedCalls = embedCalls.length;
    const firstReconcileEmbedTexts = embedCalls.flatMap((c) => c.texts);
    expect(firstReconcileEmbedCalls).toBeGreaterThan(0);
    expect(firstReconcileEmbedTexts.length).toBeGreaterThan(0);

    // Reset the per-test counter.
    embedCalls.length = 0;

    // v2: same text T (metadata-only upgrade). Bumps schema /
    // version, but the chunker output (textHash) is identical.
    const v2 = makeRev({
      sourceUnitId: 'src:thread-x:0',
      extractionRevisionId: 'rev-v2',
      text: 'identical text across upgrades',
      extractorVersion: '1.1.0',
      extractionSchemaVersion: 2, // bumped → policy picks v2 over v1
    });
    await store.putRevision(v2);
    await store.putSourceState({
      ...baseState,
      latestExtractionRevision: v2.extractionRevisionId,
      status: 'stale',
      history: [
        ...baseState.history,
        {
          extractionRevisionId: v2.extractionRevisionId,
          extractorId: v2.extractorId,
          extractorVersion: v2.extractorVersion,
          createdAt: v2.createdAt,
        },
      ],
    });
    await runner.catchUpAll(eventLog);

    // The cache hit: embedder NOT called again for the same text
    // (textHash identical → cache returns the prior vector).
    expect(
      embedCalls.length,
      'embedder must not be called when text is unchanged across the upgrade',
    ).toBe(0);
  });

  it('content change → cache miss → embedder called (sanity check)', async () => {
    const { eventLog, runner, store } = await setUp();

    const v1 = makeRev({
      sourceUnitId: 'src:thread-x:0',
      extractionRevisionId: 'rev-v1',
      text: 'one',
      extractorVersion: '1.0.0',
      extractionSchemaVersion: 1,
    });
    await store.putRevision(v1);
    await store.putSourceState({
      sourceUnitId: v1.sourceUnitId,
      sourceBacId: v1.sourceBacId,
      latestExtractionRevision: v1.extractionRevisionId,
      status: 'stale',
      history: [
        {
          extractionRevisionId: v1.extractionRevisionId,
          extractorId: v1.extractorId,
          extractorVersion: v1.extractorVersion,
          createdAt: v1.createdAt,
        },
      ],
    });
    await runner.catchUpAll(eventLog);
    embedCalls.length = 0;

    const v2 = makeRev({
      sourceUnitId: 'src:thread-x:0',
      extractionRevisionId: 'rev-v2',
      text: 'TWO different text', // CHANGED
      extractorVersion: '1.1.0',
      extractionSchemaVersion: 2,
    });
    await store.putRevision(v2);
    await store.putSourceState({
      sourceUnitId: v2.sourceUnitId,
      sourceBacId: v2.sourceBacId,
      latestExtractionRevision: v2.extractionRevisionId,
      status: 'stale',
      history: [
        {
          extractionRevisionId: v1.extractionRevisionId,
          extractorId: v1.extractorId,
          extractorVersion: v1.extractorVersion,
          createdAt: v1.createdAt,
        },
        {
          extractionRevisionId: v2.extractionRevisionId,
          extractorId: v2.extractorId,
          extractorVersion: v2.extractorVersion,
          createdAt: v2.createdAt,
        },
      ],
    });
    await runner.catchUpAll(eventLog);

    expect(embedCalls.length, 'embedder is called when text changes').toBeGreaterThan(0);
  });
});

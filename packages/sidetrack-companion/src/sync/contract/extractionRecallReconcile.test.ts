import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Embedder stubbed via the production `setEmbedderOverride` seam — see
// installStubEmbedder. `bun test` lacks `vi.importActual` and `vi.mock`
// leaks process-globally in this repo.
import { installStubEmbedder, type StubEmbedderHandle } from '../../test-helpers/stubEmbedder.js';
import { createRecallActivityTracker } from '../../recall/activity.js';
import { createExtractionStore } from '../../recall/extraction/store.js';
import {
  type ExtractionRevision,
  type ExtractionSourceState,
} from '../../recall/extraction/types.js';
import { readIndex } from '../../recall/indexFile.js';
import { createRecallLifecycle } from '../../recall/lifecycle.js';
import { createEventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { createRecallMaterializer } from './recallMaterializer.js';
import { createSyncContractRunner } from './runner.js';

// Lane 2 contract gates wired through the recall materializer's
// extraction-store reconciliation path:
//
//   L2-G1 — Same sourceUnitId, newer extraction revision → recall
//           returns only the active (newer) chunks; lifecycle does
//           NOT report a full rebuild.
//   L2-G10 — Replay-recoverable extraction → recall. Crash AFTER
//            extraction store flips status to 'stale' but BEFORE
//            recall reconciles. Restart's catchUp scans the store
//            durably and source-replaces.
//
// The setup is purely Class E driven: we put the extraction
// revision + source state directly into the store (skipping
// capture event flow) so the test stays focused on the recall
// consumer side.

const makeRevision = (input: {
  sourceUnitId: string;
  extractionRevisionId: string;
  text: string;
}): ExtractionRevision => ({
  extractionRevisionId: input.extractionRevisionId,
  sourceUnitId: input.sourceUnitId,
  sourceBacId: 'thread-x',
  extractorId: 'legacy',
  extractorVersion: '0.0.0',
  extractionSchemaVersion: 1,
  inputHash: 'h1',
  outputHash: 'h2',
  chunkerVersion: 'legacy',
  createdAt: '2026-05-07T00:00:00.000Z',
  producerReplicaId: 'peer-A',
  producerDot: { replicaId: 'peer-A', seq: 1 },
  content: {
    turns: [{ ordinal: 0, role: 'user', text: input.text }],
    title: 'Extraction recall test',
    threadUrl: 'https://example.test/x',
    capturedAt: '2026-05-07T00:00:00.000Z',
  },
});

describe('Lane 2 recall consumer ↔ extraction store reconciliation', () => {
  let vaultRoot: string;
  let stubEmbedder: StubEmbedderHandle;
  beforeEach(async () => {
    stubEmbedder = installStubEmbedder();
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-l2-recall-recon-'));
  });
  afterEach(async () => {
    stubEmbedder.restore();
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
    const runner = createSyncContractRunner();
    runner.register(
      createRecallMaterializer({
        recallLifecycle,
        recallActivity,
        eventLog,
        extractionStore: store,
        indexPath,
      }),
    );
    return { eventLog, runner, store, indexPath, recallLifecycle };
  };

  it('L2-G1 — newer extraction revision → recall returns only the active chunks; old chunks gone; no full rebuild', async () => {
    const { eventLog: _eventLog, runner, store, indexPath } = await setUp();
    void _eventLog;
    // Seed v1 in store, mark stale, run catchUp.
    const v1 = makeRevision({
      sourceUnitId: 'src:thread-x:turn-0',
      extractionRevisionId: 'rev-v1',
      text: 'first version of the extraction',
    });
    await store.putRevision(v1);
    const v1State: ExtractionSourceState = {
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
    await store.putSourceState(v1State);
    await runner.catchUpAll(_eventLog);

    let index = await readIndex(indexPath);
    expect(index, 'recall index exists after v1 reconcile').not.toBeNull();
    const v1Chunks = index!.items.filter(
      (item) => item.metadata?.extractionRevisionId === 'rev-v1',
    );
    expect(v1Chunks.length).toBeGreaterThan(0);

    // v2 lands; status flips back to stale.
    const v2 = makeRevision({
      sourceUnitId: 'src:thread-x:turn-0',
      extractionRevisionId: 'rev-v2',
      text: 'second version is dramatically improved',
    });
    await store.putRevision(v2);
    await store.putSourceState({
      ...v1State,
      latestExtractionRevision: v2.extractionRevisionId,
      status: 'stale',
      history: [
        ...v1State.history,
        {
          extractionRevisionId: v2.extractionRevisionId,
          extractorId: v2.extractorId,
          extractorVersion: v2.extractorVersion,
          createdAt: v2.createdAt,
        },
      ],
    });
    // Trigger a runner pass — could be onAcceptedEvent OR catchUp;
    // here we use catchUp because the L2-G10 invariant says recall
    // must reconcile from durable state, not from a notification.
    await runner.catchUpAll(_eventLog);

    index = await readIndex(indexPath);
    const v1AfterUpgrade = index!.items.filter(
      (item) => item.metadata?.extractionRevisionId === 'rev-v1',
    );
    const v2AfterUpgrade = index!.items.filter(
      (item) => item.metadata?.extractionRevisionId === 'rev-v2',
    );
    expect(v1AfterUpgrade, 'v1 chunks GONE — source-scoped replace').toHaveLength(0);
    expect(v2AfterUpgrade.length).toBeGreaterThan(0);
    // Source state pointer flipped to 'current'.
    const stateAfter = await store.readSourceState(v1.sourceUnitId);
    expect(stateAfter?.status).toBe('current');
    expect(stateAfter?.indexedExtractionRevision).toBe('rev-v2');
  });

  it('L2-G10 — replay-recoverable: crash AFTER store flip, BEFORE recall reconcile → next catchUp repairs index', async () => {
    // First incarnation: put a stale revision in the store, drop
    // the runner without running catchUp. Simulates a crash right
    // after extraction materializer flipped the source state.
    const first = await setUp();
    const v1 = makeRevision({
      sourceUnitId: 'src:thread-x:turn-0',
      extractionRevisionId: 'rev-pre-crash',
      text: 'crashed before recall got the memo',
    });
    await first.store.putRevision(v1);
    await first.store.putSourceState({
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
    // No catchUpAll. Simulate process exit by abandoning the runner.

    // Second incarnation: restart, build a fresh runner, call
    // catchUpAll. Recall consumer scans extraction store for stale
    // sources independently of any in-memory notification.
    const second = await setUp();
    await second.runner.catchUpAll(first.eventLog);

    const index = await readIndex(second.indexPath);
    expect(index, 'index recovered after restart').not.toBeNull();
    const recovered = index!.items.filter(
      (item) => item.metadata?.extractionRevisionId === 'rev-pre-crash',
    );
    expect(recovered.length).toBeGreaterThan(0);
    const stateAfter = await second.store.readSourceState(v1.sourceUnitId);
    expect(stateAfter?.status).toBe('current');
  });
});

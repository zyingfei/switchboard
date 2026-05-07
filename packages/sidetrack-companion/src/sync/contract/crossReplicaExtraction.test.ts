import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../recall/embedder.js', async () => {
  const real = await vi.importActual<typeof import('../../recall/embedder.js')>(
    '../../recall/embedder.js',
  );
  return {
    ...real,
    embed: async (texts: readonly string[]) =>
      texts.map(() => {
        const v = new Float32Array(384);
        v[0] = 1;
        return v;
      }),
  };
});

import { createRecallActivityTracker } from '../../recall/activity.js';
import { CAPTURE_EXTRACTION_PRODUCED } from '../../recall/extraction/events.js';
import { createExtractionStore } from '../../recall/extraction/store.js';
import { readIndex } from '../../recall/indexFile.js';
import { createRecallLifecycle } from '../../recall/lifecycle.js';
import type { AcceptedEvent } from '../causal.js';
import { createEventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { createExtractionMaterializer } from './extractionMaterializer.js';
import { createRecallMaterializer } from './recallMaterializer.js';
import { createSyncContractRunner } from './runner.js';

// Lane 2 cross-replica gates — exercised end-to-end through both
// the extraction materializer AND the recall materializer in
// process. We simulate the relay by hand: A emits an event; we
// hand the event to B's runner with origin: 'peer'.
//
//   L2-G4 — Cross-replica extraction upgrade. A on extractor v1;
//           B re-captures with extractor v1.1 and emits
//           capture.extraction.produced. After sync, BOTH replicas
//           have the v1.1 chunks active.
//   L2-G8 — No-login peer recall via capture.extraction.produced.
//           Companion B has NEVER seen the original capture for
//           thread-x — only the capture.extraction.produced event.
//           B's recall query returns the v1.1 content.

describe('Lane 2 cross-replica extraction', () => {
  let vaultA: string;
  let vaultB: string;
  beforeEach(async () => {
    vaultA = await mkdtemp(join(tmpdir(), 'sidetrack-l2-cross-A-'));
    vaultB = await mkdtemp(join(tmpdir(), 'sidetrack-l2-cross-B-'));
  });
  afterEach(async () => {
    await rm(vaultA, { recursive: true, force: true });
    await rm(vaultB, { recursive: true, force: true });
  });

  const setUpReplica = async (vaultRoot: string) => {
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
      createExtractionMaterializer({ store, eventLog }),
    );
    runner.register(
      createRecallMaterializer({
        recallLifecycle,
        recallActivity,
        eventLog,
        extractionStore: store,
        indexPath,
      }),
    );
    return { eventLog, runner, store, indexPath };
  };

  const extractionProducedEvent = (input: {
    seq: number;
    extractionRevisionId: string;
    extractorVersion: string;
    extractionSchemaVersion: number;
    text: string;
    sourceUnitId?: string;
  }): AcceptedEvent => ({
    clientEventId: `extract-${input.seq}`,
    dot: { replicaId: 'peer-B', seq: input.seq },
    deps: {},
    aggregateId: 'thread-x',
    type: CAPTURE_EXTRACTION_PRODUCED,
    payload: {
      sourceUnitId: input.sourceUnitId ?? 'src:chatgpt:thread-x:turn-0',
      sourceBacId: 'thread-x',
      extractionRevisionId: input.extractionRevisionId,
      extractorId: 'legacy',
      extractorVersion: input.extractorVersion,
      extractionSchemaVersion: input.extractionSchemaVersion,
      inputHash: 'h',
      outputHash: 'h',
      chunkerVersion: 'legacy',
      content: {
        turns: [{ ordinal: 0, role: 'user', text: input.text }],
        title: 'Cross-replica extraction',
        threadUrl: 'https://chatgpt.com/c/thread-x',
        capturedAt: '2026-05-07T00:00:00.000Z',
      },
    },
    acceptedAtMs: input.seq,
  });

  it('L2-G4 — A on v1; B re-captures with v1.1 and emits capture.extraction.produced; after sync both have v1.1 active', async () => {
    const a = await setUpReplica(vaultA);
    const b = await setUpReplica(vaultB);

    // A: original extraction v1 emitted.
    const eventV1 = extractionProducedEvent({
      seq: 1,
      extractionRevisionId: 'rev-v1',
      extractorVersion: '1.0.0',
      extractionSchemaVersion: 1,
      text: 'first version',
    });
    await a.eventLog.importPeerEvent(eventV1);
    a.runner.onAcceptedEvent(eventV1, { origin: 'local' });
    await a.runner.awaitIdle();
    await a.runner.catchUpAll(a.eventLog); // recall reconcile

    // Sync v1 to B.
    await b.eventLog.importPeerEvent(eventV1);
    b.runner.onAcceptedEvent(eventV1, { origin: 'peer' });
    await b.runner.awaitIdle();
    await b.runner.catchUpAll(b.eventLog);

    // Both replicas have v1 active.
    expect((await a.store.readSourceState('src:chatgpt:thread-x:turn-0'))?.latestExtractionRevision).toBe('rev-v1');
    expect((await b.store.readSourceState('src:chatgpt:thread-x:turn-0'))?.latestExtractionRevision).toBe('rev-v1');

    // B re-captures with v1.1 (newer extractorVersion + schema).
    const eventV2 = extractionProducedEvent({
      seq: 2,
      extractionRevisionId: 'rev-v2',
      extractorVersion: '1.1.0',
      extractionSchemaVersion: 2,
      text: 'first version', // text unchanged → cache hit, but new revision still active
    });
    await b.eventLog.importPeerEvent(eventV2);
    b.runner.onAcceptedEvent(eventV2, { origin: 'local' });
    await b.runner.awaitIdle();
    await b.runner.catchUpAll(b.eventLog);

    // Sync v2 to A.
    await a.eventLog.importPeerEvent(eventV2);
    a.runner.onAcceptedEvent(eventV2, { origin: 'peer' });
    await a.runner.awaitIdle();
    await a.runner.catchUpAll(a.eventLog);

    // Both replicas now have v2 active. Active-revision policy is
    // deterministic (higher schema version wins).
    expect((await a.store.readSourceState('src:chatgpt:thread-x:turn-0'))?.latestExtractionRevision).toBe('rev-v2');
    expect((await b.store.readSourceState('src:chatgpt:thread-x:turn-0'))?.latestExtractionRevision).toBe('rev-v2');
    // Recall index on both replicas reflects v2.
    const indexA = await readIndex(a.indexPath);
    const indexB = await readIndex(b.indexPath);
    const v2OnA = indexA!.items.filter((e) => e.metadata?.extractionRevisionId === 'rev-v2');
    const v2OnB = indexB!.items.filter((e) => e.metadata?.extractionRevisionId === 'rev-v2');
    expect(v2OnA.length).toBeGreaterThan(0);
    expect(v2OnB.length).toBeGreaterThan(0);
    // No v1 chunks remain (source-scoped replace).
    const v1OnA = indexA!.items.filter((e) => e.metadata?.extractionRevisionId === 'rev-v1');
    const v1OnB = indexB!.items.filter((e) => e.metadata?.extractionRevisionId === 'rev-v1');
    expect(v1OnA).toHaveLength(0);
    expect(v1OnB).toHaveLength(0);
  });

  it('L2-G8 — no-login peer recall: B never saw the original capture; v1.1 extraction event suffices', async () => {
    const b = await setUpReplica(vaultB);

    // B has zero events. A capture.extraction.produced event arrives
    // — this is the no-login case: B did not capture the
    // conversation; another replica did, and shipped the
    // extraction over the relay.
    const event = extractionProducedEvent({
      seq: 1,
      extractionRevisionId: 'rev-v1.1',
      extractorVersion: '1.1.0',
      extractionSchemaVersion: 2,
      text: 'this turn arrived via peer extraction event, not via local capture',
    });
    await b.eventLog.importPeerEvent(event);
    b.runner.onAcceptedEvent(event, { origin: 'peer' });
    await b.runner.awaitIdle();
    await b.runner.catchUpAll(b.eventLog);

    // B's recall index has the chunks even though B never logged
    // into chatgpt.
    const index = await readIndex(b.indexPath);
    expect(index, 'recall index exists on B').not.toBeNull();
    const chunks = index!.items.filter(
      (e) => e.metadata?.extractionRevisionId === 'rev-v1.1',
    );
    expect(chunks.length).toBeGreaterThan(0);
    // Confirm B's eventLog has zero capture.recorded events for
    // thread-x — the no-login claim.
    const merged = await b.eventLog.readMerged();
    const captures = merged.filter((e) => e.type === 'capture.recorded');
    expect(captures, 'B has no capture.recorded events').toHaveLength(0);
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the embedder BEFORE importing anything that loads it. Same
// pattern as src/recall/ingestor.test.ts.
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
import { readIndex } from '../../recall/indexFile.js';
import { createRecallLifecycle } from '../../recall/lifecycle.js';
import type { AcceptedEvent } from '../causal.js';
import { createEventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { createRecallMaterializer } from './recallMaterializer.js';
import { createSyncContractRunner } from './runner.js';

// Lane 1 contract gates exercised end-to-end through the runner +
// recall materializer + recall lifecycle, with a deterministic
// in-memory embedder. These complement burstResilience.test.ts
// (which proved the materializer scheduler is sound) by proving the
// FULL chain from "peer event arrives" to "recall query finds it"
// works inside a single process.
//
//   L1-G2 — Capture-then-recall. Peer capture event → recall index
//           contains the chunks within the materializer's drain.
//           (User-outcome equivalent at unit level: a
//           queryable-via-rank state.)
//   L1-G3 — Tombstone-then-recall. recall.tombstone.target event
//           → matching chunks marked tombstoned in the index.
//   L1-G5 — Crash recovery. A capture event lands in the merged
//           log, but the materializer never gets a chance to drain
//           (simulated by re-creating the runner before awaitIdle).
//           Restart's catchUpAll AWAITs drain → index is correct.
//
// L1-G4 (catchUp AWAITS) is asserted in runner.test.ts via the
// catchUpAll-elapsed-time check; here we lean on the same property.

describe('Lane 1 recall freshness — capture-then-recall, tombstone, crash recovery', () => {
  let vaultRoot: string;
  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-l1-recall-fresh-'));
  });
  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  // Helper: assemble (runner + recall materializer) bound to one
  // vault. Same shape as runtime/companion.ts wires.
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
    const runner = createSyncContractRunner();
    runner.register(createRecallMaterializer({ recallLifecycle, recallActivity, eventLog }));
    return { eventLog, runner, recallLifecycle };
  };

  const captureEvent = (turnText: string): AcceptedEvent => ({
    clientEventId: 'cap-x',
    dot: { replicaId: 'peer-A', seq: 1 },
    deps: {},
    aggregateId: 'thread-x',
    type: 'capture.recorded',
    payload: {
      bac_id: 'thread-x',
      threadUrl: 'https://example.test/x',
      provider: 'chatgpt',
      title: 'Capture probe',
      capturedAt: '2026-05-07T00:00:00.000Z',
      turns: [{ ordinal: 0, role: 'user', text: turnText }],
    },
    acceptedAtMs: 1,
  });

  const tombstoneEvent = (): AcceptedEvent => ({
    clientEventId: 'tomb-x',
    dot: { replicaId: 'peer-A', seq: 2 },
    deps: { 'peer-A': 1 },
    aggregateId: 'thread-x',
    type: 'recall.tombstone.target',
    payload: { threadId: 'thread-x' },
    acceptedAtMs: 2,
  });

  it('L1-G2 — peer capture event → recall index contains the chunks (no restart needed)', async () => {
    const { eventLog, runner } = await setUp();
    const event = captureEvent('hello recall world');
    await eventLog.importPeerEvent(event);
    runner.onAcceptedEvent(event, { origin: 'peer' });
    await runner.awaitIdle();

    const indexPath = join(vaultRoot, '_BAC', 'recall', 'index.bin');
    const index = await readIndex(indexPath);
    expect(index, 'index file exists after peer capture').not.toBeNull();
    expect(index!.items.length).toBeGreaterThan(0);
    const chunk = index!.items[0]!;
    expect(chunk.threadId).toBe('thread-x');
    expect(chunk.tombstoned).toBe(false);
  });

  it('L1-G3 — peer tombstone event → matching chunks tombstoned (recall query excludes them)', async () => {
    const { eventLog, runner } = await setUp();
    // First a capture, then the tombstone.
    const cap = captureEvent('about to be tombstoned');
    await eventLog.importPeerEvent(cap);
    runner.onAcceptedEvent(cap, { origin: 'peer' });
    await runner.awaitIdle();

    const tomb = tombstoneEvent();
    await eventLog.importPeerEvent(tomb);
    runner.onAcceptedEvent(tomb, { origin: 'peer' });
    await runner.awaitIdle();

    const indexPath = join(vaultRoot, '_BAC', 'recall', 'index.bin');
    const index = await readIndex(indexPath);
    expect(index, 'index file exists').not.toBeNull();
    const liveItems = index!.items.filter((item) => item.tombstoned !== true);
    expect(
      liveItems,
      'recall query (which filters tombstoned) sees no live entries for thread-x after tombstone',
    ).toHaveLength(0);
    // Tombstoned rows still on disk (OR-Set semantics).
    const tombstoned = index!.items.filter((item) => item.tombstoned === true);
    expect(tombstoned.length).toBeGreaterThan(0);
  });

  it('L1-G5 — crash before materializer drain → next startup catchUpAll AWAITs and recovers the index', async () => {
    // First incarnation: import the event into the merged log but
    // do NOT call awaitIdle (simulates crash mid-drain).
    const first = await setUp();
    const event = captureEvent('post-crash recovery probe');
    await first.eventLog.importPeerEvent(event);
    first.runner.onAcceptedEvent(event, { origin: 'peer' });
    // Deliberately skip awaitIdle. The materializer's IIFE may or
    // may not have drained — we discard the runner without waiting.

    // Second incarnation: re-open the vault, build a fresh runner,
    // call catchUpAll. The runner.catchUpAll AWAITs drain. After
    // it resolves, the recall index reflects the event.
    const second = await setUp();
    await second.runner.catchUpAll(second.eventLog);

    const indexPath = join(vaultRoot, '_BAC', 'recall', 'index.bin');
    const index = await readIndex(indexPath);
    expect(index, 'index file exists after restart catchUp').not.toBeNull();
    expect(index!.items.length).toBeGreaterThan(0);
    expect(index!.items[0]!.threadId).toBe('thread-x');
  });
});

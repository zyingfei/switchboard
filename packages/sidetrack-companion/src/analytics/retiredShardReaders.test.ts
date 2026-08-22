// F2 seam (2026-08-21) — shared regression coverage for "retired-shard
// readers": the 7 typed stores' rebuildFromJsonl/catchUpFromJsonl
// cold-repair paths, and the topic-full-timeline read primitive, must all
// still see a day's events after analytics/hotTailRetirement.ts's F2 apply
// has MOVED that day's shard from `_BAC/log` to `_BAC/retired/log`.
//
// This file writes shard JSONL directly (no seal/apply machinery — that is
// already covered end-to-end by hotTailRetirement.test.ts) to isolate the
// READ-SIDE contract this seam adds: `rebuildFromJsonl(logRoot, priorRoots)`
// / `catchUpFromJsonl(logRoot, priorRoots)` and
// `readCanonicalEventHistoryIncludingRetired`.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import { createEventStore } from '../sync/eventStore.js';
import { THREAD_UPSERTED } from '../threads/events.js';
import { projectThread } from '../threads/projection.js';
import { createThreadRegisterStore } from '../threads/threadRegisterStore.js';
import {
  canonicalEventLogRootsForRebuild,
  readCanonicalEventHistoryIncludingRetired,
  retiredEventLogRoot,
} from './hotTailRetirement.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

const REPLICA = 'peer-retired-read';

const genericEvent = (input: {
  readonly seq: number;
  readonly type?: string;
  readonly acceptedAtMs?: number;
}): AcceptedEvent => ({
  clientEventId: `${REPLICA}.${String(input.seq)}.${input.type ?? 'thread.upserted'}`,
  dot: { replicaId: REPLICA, seq: input.seq },
  deps: {},
  aggregateId: `agg-${String(input.seq)}`,
  type: input.type ?? 'thread.upserted',
  payload: { bac_id: `T${String(input.seq)}`, title: `event ${String(input.seq)}` },
  acceptedAtMs: input.acceptedAtMs ?? input.seq,
});

const upsertEvent = (bacId: string, seq: number, title: string): AcceptedEvent => ({
  clientEventId: `${REPLICA}.${String(seq)}.${THREAD_UPSERTED}`,
  dot: { replicaId: REPLICA, seq },
  deps: {},
  aggregateId: bacId,
  type: THREAD_UPSERTED,
  payload: {
    bac_id: bacId,
    provider: 'chatgpt',
    threadUrl: `https://example.test/${bacId}`,
    title,
    lastSeenAt: '2026-08-21T12:00:00.000Z',
  },
  acceptedAtMs: seq,
});

const writeShard = async (root: string, replica: string, day: string, events: readonly AcceptedEvent[]): Promise<void> => {
  const dir = join(root, replica);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${day}.jsonl`), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
};

describe('F2 seam — retired-shard readers', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const tempVault = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), 'sidetrack-retired-reader-'));
    dirs.push(d);
    await mkdir(join(d, '_BAC', 'connections'), { recursive: true });
    return d;
  };

  // The event-store-specific hazard: catchUpFromJsonl gates re-ingestion of
  // a seq at/below a replica's own watermark as "out of order". This
  // fixture deliberately gives the RETIRED day the LOWER seqs and the HOT
  // day the HIGHER seqs (the realistic shape — retired days are always
  // older) so that walking hot-before-retired would advance the watermark
  // past the retired seqs and permanently skip them. If eventStore.ts's
  // `priorRoots` ordering (retired walked to completion, including its own
  // flush, BEFORE logRoot) ever regressed, this test would see 3 events
  // instead of 6.
  sqliteIt(
    'eventStore cold rebuild recovers a retired day\'s events (retired-first ordering)',
    async () => {
      const vault = await tempVault();
      const hotLogRoot = join(vault, '_BAC', 'log');
      const retiredLogRoot = retiredEventLogRoot(vault);
      const retiredEvents = [1, 2, 3].map((seq) => genericEvent({ seq }));
      const hotEvents = [4, 5, 6].map((seq) => genericEvent({ seq }));
      await writeShard(retiredLogRoot, REPLICA, '2026-01-01', retiredEvents);
      await writeShard(hotLogRoot, REPLICA, '2026-01-02', hotEvents);

      const store = await createEventStore(vault);
      try {
        const { logRoot, priorRoots } = canonicalEventLogRootsForRebuild(vault);
        expect(logRoot).toBe(hotLogRoot);
        expect(priorRoots).toEqual([retiredLogRoot]);
        const ingested = await store.rebuildFromJsonl(logRoot, priorRoots).then(
          () => store.readSince({}).length,
        );
        expect(ingested).toBe(6);
        const seqs = store.readSince({}).map((e) => e.dot.seq).sort((a, b) => a - b);
        expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
      } finally {
        store.close();
      }
    },
  );

  // The COUNTERFACTUAL the retired-first ordering exists to prevent: walk
  // the hot root first and the retired day is not merely "missed" — it is
  // PERMANENTLY unrecoverable through the watermark-gated catch-up path.
  // The hot day's flush advances the replica watermark to 6, so every
  // retired seq (1-3) then classifies as an already-committed redelivery
  // and is dropped, even though those rows were never ingested. This is
  // the exact failure shape a cold-repair caller would hit if it walked
  // `[logRoot, ...priorRoots]` instead of `[...priorRoots, logRoot]`.
  sqliteIt('hot-first walking permanently skips the retired day (the watermark-skip bug)', async () => {
    const vault = await tempVault();
    const hotLogRoot = join(vault, '_BAC', 'log');
    const retiredLogRoot = retiredEventLogRoot(vault);
    await writeShard(retiredLogRoot, REPLICA, '2026-01-01', [1, 2, 3].map((seq) => genericEvent({ seq })));
    await writeShard(hotLogRoot, REPLICA, '2026-01-02', [4, 5, 6].map((seq) => genericEvent({ seq })));

    const store = await createEventStore(vault);
    try {
      // Wrong order: hot walked (and watermark-flushed) first...
      const hotIngested = await store.catchUpFromJsonl(hotLogRoot);
      expect(hotIngested).toBe(3);
      // ...then the retired root: all 3 retired rows now fall at/below the
      // replica watermark and are skipped, not ingested.
      const retiredIngested = await store.catchUpFromJsonl(retiredLogRoot);
      expect(retiredIngested).toBe(0);
      const seqs = store.readSince({}).map((e) => e.dot.seq).sort((a, b) => a - b);
      expect(seqs).toEqual([4, 5, 6]);
    } finally {
      store.close();
    }
  });

  // eventStore's single live production call site
  // (startCoalescedEventStoreCatchUp) is unaffected: `priorRoots` is
  // opt-in (defaults to `[]`) and that call site is deliberately left
  // passing only the hot logRoot — the per-drain hot path must never scan
  // the ever-growing retired mirror. This is asserted structurally by the
  // above: calling `rebuildFromJsonl(logRoot)` with NO priorRoots (the
  // pre-seam call shape) still works and simply does not see the retired
  // day — the seam is additive, not a behaviour change to the default.
  sqliteIt('eventStore rebuildFromJsonl without priorRoots is unchanged (retired day absent)', async () => {
    const vault = await tempVault();
    const hotLogRoot = join(vault, '_BAC', 'log');
    const retiredLogRoot = retiredEventLogRoot(vault);
    await writeShard(retiredLogRoot, REPLICA, '2026-01-01', [1, 2, 3].map((seq) => genericEvent({ seq })));
    await writeShard(hotLogRoot, REPLICA, '2026-01-02', [4, 5, 6].map((seq) => genericEvent({ seq })));

    const store = await createEventStore(vault);
    try {
      await store.rebuildFromJsonl(hotLogRoot);
      const seqs = store.readSince({}).map((e) => e.dot.seq).sort((a, b) => a - b);
      expect(seqs).toEqual([4, 5, 6]);
    } finally {
      store.close();
    }
  });

  // A representative "simple" typed store (idempotent INSERT OR IGNORE,
  // no watermark gate on rebuild — see engagementFactsStore.ts /
  // timelineFactsStore.ts / etc.'s shared header comment) — proves the
  // same `priorRoots` wiring generalizes across the store family, not just
  // eventStore.ts's order-sensitive case.
  sqliteIt('threadRegisterStore cold rebuild recovers a retired day\'s events', async () => {
    const vault = await tempVault();
    const hotLogRoot = join(vault, '_BAC', 'log');
    const retiredLogRoot = retiredEventLogRoot(vault);
    const e1 = upsertEvent('T1', 1, 'first (retired day)');
    const e2 = upsertEvent('T1', 2, 'second (hot day)');
    await writeShard(retiredLogRoot, REPLICA, '2026-01-01', [e1]);
    await writeShard(hotLogRoot, REPLICA, '2026-01-02', [e2]);

    const store = await createThreadRegisterStore(vault);
    const { logRoot, priorRoots } = canonicalEventLogRootsForRebuild(vault);
    await store.rebuildFromJsonl(logRoot, priorRoots);
    const fromStore = store.read('T1');
    store.close();
    expect(fromStore).toEqual(projectThread('T1', [e1, e2]));
  });

  // "topic full-timeline still counts them": the primitive a topic
  // full-timeline rebuild WOULD use to see retired history. NOT wired into
  // connectionsMaterializer.ts's `SIDETRACK_CONNECTIONS_TOPIC_FULL_TIMELINE`
  // branch in this change — that call site is inside the protected file
  // and out of this task's narrow seam (see the landing note). This test
  // pins the primitive's correctness so that a follow-up wiring it in is a
  // one-line, already-proven change.
  it('readCanonicalEventHistoryIncludingRetired includes both retired and hot days', async () => {
    const vault = await tempVault();
    const hotLogRoot = join(vault, '_BAC', 'log');
    const retiredLogRoot = retiredEventLogRoot(vault);
    const retiredEvents = [1, 2].map((seq) => genericEvent({ seq }));
    const hotEvents = [3, 4].map((seq) => genericEvent({ seq }));
    await writeShard(retiredLogRoot, REPLICA, '2026-01-01', retiredEvents);
    await writeShard(hotLogRoot, REPLICA, '2026-01-02', hotEvents);

    const history = await readCanonicalEventHistoryIncludingRetired(vault);
    const seqs = history.filter((e) => e.dot.replicaId === REPLICA).map((e) => e.dot.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3, 4]);
  });

  it('readCanonicalEventHistoryIncludingRetired tolerates an absent retired root (no F2 apply run yet)', async () => {
    const vault = await tempVault();
    const hotLogRoot = join(vault, '_BAC', 'log');
    await writeShard(hotLogRoot, REPLICA, '2026-01-02', [genericEvent({ seq: 1 })]);

    const history = await readCanonicalEventHistoryIncludingRetired(vault);
    expect(history.filter((e) => e.dot.replicaId === REPLICA)).toHaveLength(1);
  });
});

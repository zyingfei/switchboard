import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type AcceptedEvent, eventDominates } from './causal.js';
import { createEventLog, type EventLog } from './eventLog.js';
import { loadOrCreateReplica, type ReplicaContext } from './replicaId.js';
import { projectReviewDraft, type ReviewProjectionAnchor } from '../review/projection.js';

// End-to-end simulation: two companions, each writing to its own
// vault, exchanging log shards through a `syncLogs` step that
// mimics what Syncthing / Dropbox would do over `_BAC/log/`.
//
// The properties we want to prove:
//   1. Concurrent edits to the same scalar surface as a `conflict`
//      register on BOTH replicas after a sync.
//   2. A manual-merge edit whose `baseVector` covers all candidates
//      collapses the conflict back to `resolved` on BOTH replicas
//      after the next sync.
//   3. Each replica's projection is independently constructed from
//      its locally-merged log; `eventDominates` does the work — no
//      Lamport scalar comparison required.

const anchor = (exact: string): ReviewProjectionAnchor => ({
  textQuote: { exact, prefix: '', suffix: '' },
  textPosition: { start: 0, end: exact.length },
  cssSelector: 'main',
});

interface ReplicaHarness {
  readonly root: string;
  readonly replica: ReplicaContext;
  readonly log: EventLog;
}

const setupReplica = async (label: string): Promise<ReplicaHarness> => {
  const root = await mkdtemp(join(tmpdir(), `sidetrack-replica-${label}-`));
  const replica = await loadOrCreateReplica(root);
  const log = createEventLog(root, replica);
  return { root, replica, log };
};

// Copy every replica shard from `src/_BAC/log/` into
// `dst/_BAC/log/`. Symmetric calls between the two harnesses bring
// both vaults to the same merged log. We use cp(recursive) — peers
// always write to disjoint subdirectories so there is no overwrite
// risk by construction.
const syncLogs = async (src: ReplicaHarness, dst: ReplicaHarness): Promise<void> => {
  const srcLogRoot = join(src.root, '_BAC', 'log');
  let entries: string[];
  try {
    entries = await readdir(srcLogRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    await cp(join(srcLogRoot, entry), join(dst.root, '_BAC', 'log', entry), {
      recursive: true,
      force: true,
    });
  }
};

describe('two-replica review-draft simulation', () => {
  let A: ReplicaHarness;
  let B: ReplicaHarness;

  beforeEach(async () => {
    A = await setupReplica('A');
    B = await setupReplica('B');
  });

  afterEach(async () => {
    await rm(A.root, { recursive: true, force: true });
    await rm(B.root, { recursive: true, force: true });
  });

  it('concurrent overall edits surface as a conflict on both replicas after a sync', async () => {
    // A and B both add the same span — concurrent because neither
    // observed the other's add.
    await A.log.appendClient({
      clientEventId: 'span-add-A',
      aggregateId: 't',
      type: 'review-draft.span.added',
      payload: { spanId: 's-1', anchor: anchor('hello'), quote: 'hello', comment: 'A note' },
      baseVector: {},
    });
    await B.log.appendClient({
      clientEventId: 'span-add-B',
      aggregateId: 't',
      type: 'review-draft.span.added',
      payload: { spanId: 's-1', anchor: anchor('hello'), quote: 'hello', comment: 'B note' },
      baseVector: {},
    });

    await A.log.appendClient({
      clientEventId: 'overall-A',
      aggregateId: 't',
      type: 'review-draft.overall.set',
      payload: { text: 'A summary' },
      baseVector: {},
    });
    await B.log.appendClient({
      clientEventId: 'overall-B',
      aggregateId: 't',
      type: 'review-draft.overall.set',
      payload: { text: 'B summary' },
      baseVector: {},
    });

    // Sync both directions so each side sees both replicas' shards.
    await syncLogs(A, B);
    await syncLogs(B, A);

    const eventsA = await A.log.readByAggregate('t');
    const eventsB = await B.log.readByAggregate('t');
    const projA = projectReviewDraft('t', 'url', eventsA);
    const projB = projectReviewDraft('t', 'url', eventsB);

    expect(projA.overall.status).toBe('conflict');
    expect(projB.overall.status).toBe('conflict');
    if (projA.overall.status === 'conflict') {
      expect(projA.overall.candidates.map((c) => c.value).sort()).toEqual([
        'A summary',
        'B summary',
      ]);
    }
    expect(projA.vector).toEqual(projB.vector);
  });

  it('manual-merge resolves the conflict on both replicas after the next sync', async () => {
    await A.log.appendClient({
      clientEventId: 'span-add',
      aggregateId: 't',
      type: 'review-draft.span.added',
      payload: { spanId: 's-1', anchor: anchor('q'), quote: 'q', comment: '' },
      baseVector: {},
    });
    await syncLogs(A, B);
    // A and B both edit the comment concurrently.
    const baseAfterAdd = (await A.log.readByAggregate('t')).reduce<Record<string, number>>(
      (vector, event) => {
        const previous = vector[event.dot.replicaId] ?? 0;
        if (event.dot.seq > previous) vector[event.dot.replicaId] = event.dot.seq;
        return vector;
      },
      {},
    );
    await A.log.appendClient({
      clientEventId: 'comment-A',
      aggregateId: 't',
      type: 'review-draft.comment.set',
      payload: { spanId: 's-1', text: 'A take' },
      baseVector: baseAfterAdd,
    });
    await B.log.appendClient({
      clientEventId: 'comment-B',
      aggregateId: 't',
      type: 'review-draft.comment.set',
      payload: { spanId: 's-1', text: 'B take' },
      baseVector: baseAfterAdd,
    });
    await syncLogs(A, B);
    await syncLogs(B, A);

    const projBeforeMerge = projectReviewDraft('t', 'url', await A.log.readByAggregate('t'));
    expect(projBeforeMerge.spans[0]?.comment.status).toBe('conflict');

    // User on B clicks "Use combined" — issues a comment.set whose
    // baseVector covers ALL prior dots (i.e., the merged vector).
    await B.log.appendClient({
      clientEventId: 'comment-merge',
      aggregateId: 't',
      type: 'review-draft.comment.set',
      payload: { spanId: 's-1', text: 'A take + B take' },
      baseVector: projBeforeMerge.vector,
    });
    await syncLogs(B, A);

    const projA = projectReviewDraft('t', 'url', await A.log.readByAggregate('t'));
    const projB = projectReviewDraft('t', 'url', await B.log.readByAggregate('t'));

    expect(projA.spans[0]?.comment).toMatchObject({
      status: 'resolved',
      value: 'A take + B take',
    });
    expect(projB.spans[0]?.comment).toMatchObject({
      status: 'resolved',
      value: 'A take + B take',
    });
    // Both replicas see the same vector after a full sync.
    expect(projA.vector).toEqual(projB.vector);
  });

  it('merge event causally dominates the candidate dots it observed', async () => {
    await A.log.appendClient({
      clientEventId: 'span-add',
      aggregateId: 't',
      type: 'review-draft.span.added',
      payload: { spanId: 's-1', anchor: anchor('q'), quote: 'q' },
      baseVector: {},
    });
    await syncLogs(A, B);
    const aBase = (await A.log.readByAggregate('t')).reduce<Record<string, number>>((vec, e) => {
      vec[e.dot.replicaId] = Math.max(vec[e.dot.replicaId] ?? 0, e.dot.seq);
      return vec;
    }, {});
    const aEdit = await A.log.appendClient({
      clientEventId: 'a-edit',
      aggregateId: 't',
      type: 'review-draft.comment.set',
      payload: { spanId: 's-1', text: 'A wrote' },
      baseVector: aBase,
    });
    const bEdit = await B.log.appendClient({
      clientEventId: 'b-edit',
      aggregateId: 't',
      type: 'review-draft.comment.set',
      payload: { spanId: 's-1', text: 'B wrote' },
      baseVector: aBase,
    });
    await syncLogs(A, B);
    await syncLogs(B, A);
    const merged = await A.log.readByAggregate('t');
    const fullVector = merged.reduce<Record<string, number>>((vec, e) => {
      vec[e.dot.replicaId] = Math.max(vec[e.dot.replicaId] ?? 0, e.dot.seq);
      return vec;
    }, {});
    const merge = await A.log.appendClient({
      clientEventId: 'merge',
      aggregateId: 't',
      type: 'review-draft.comment.set',
      payload: { spanId: 's-1', text: 'merged' },
      baseVector: fullVector,
    });
    expect(eventDominates(merge as AcceptedEvent, aEdit as AcceptedEvent)).toBe(true);
    expect(eventDominates(merge as AcceptedEvent, bEdit as AcceptedEvent)).toBe(true);
    expect(eventDominates(aEdit as AcceptedEvent, bEdit as AcceptedEvent)).toBe(false);
    expect(eventDominates(bEdit as AcceptedEvent, aEdit as AcceptedEvent)).toBe(false);
  });

  it('T2.5 — concurrent append-only captures from both replicas survive a partition + rejoin', async () => {
    // Append-only events (capture.recorded) are NOT subject to
    // mergeRegister or OR-Set semantics — they're a linearizable
    // union. This test proves: if A captures while partitioned
    // from B, and B captures while partitioned from A (each
    // with empty deps because neither has seen the other),
    // after sync both replicas have BOTH events with their
    // distinct dots intact. Nothing collapses. Nothing dedupes.
    const captureA = await A.log.appendClient({
      clientEventId: 'capture-on-A',
      aggregateId: 'thread_capture_a',
      type: 'capture.recorded',
      payload: {
        bac_id: 'thread_capture_a',
        capturedAt: '2026-05-07T09:00:00.000Z',
        turns: [{ ordinal: 0, role: 'user', text: 'A side capture' }],
      },
      baseVector: {},
    });
    const captureB = await B.log.appendClient({
      clientEventId: 'capture-on-B',
      aggregateId: 'thread_capture_b',
      type: 'capture.recorded',
      payload: {
        bac_id: 'thread_capture_b',
        capturedAt: '2026-05-07T09:00:01.000Z',
        turns: [{ ordinal: 0, role: 'user', text: 'B side capture' }],
      },
      baseVector: {},
    });

    // Partition + rejoin.
    await syncLogs(A, B);
    await syncLogs(B, A);

    // Both replicas' merged logs contain both events keyed by
    // their original dots (no re-stamping).
    const mergedFromA = (await A.log.readMerged()).filter((e) => e.type === 'capture.recorded');
    const mergedFromB = (await B.log.readMerged()).filter((e) => e.type === 'capture.recorded');
    const dotsA = mergedFromA.map((e) => `${e.dot.replicaId}:${String(e.dot.seq)}`).sort();
    const dotsB = mergedFromB.map((e) => `${e.dot.replicaId}:${String(e.dot.seq)}`).sort();
    expect(dotsA).toEqual(dotsB);
    expect(dotsA.length).toBe(2);
    // Neither dominates the other — concurrent append-only.
    expect(eventDominates(captureA as AcceptedEvent, captureB as AcceptedEvent)).toBe(false);
    expect(eventDominates(captureB as AcceptedEvent, captureA as AcceptedEvent)).toBe(false);
    // Distinct aggregateIds + clientEventIds — neither replica
    // can confuse them via dedupe.
    const aggregates = new Set(mergedFromA.map((e) => e.aggregateId));
    expect(aggregates).toEqual(new Set(['thread_capture_a', 'thread_capture_b']));
  });

  it('T2.6 — multi-field concurrent edits: A overall, B verdict — both slots resolve independently after sync', async () => {
    // Different register slots on the same aggregate are
    // independent: A editing `overall` does NOT conflict with B
    // editing `verdict`. Both projections collapse to resolved
    // values after sync, on both replicas.
    await A.log.appendClient({
      clientEventId: 'a-overall',
      aggregateId: 'thread_multi',
      type: 'review-draft.overall.set',
      payload: { text: 'A side overall' },
      baseVector: {},
    });
    await B.log.appendClient({
      clientEventId: 'b-verdict',
      aggregateId: 'thread_multi',
      type: 'review-draft.verdict.set',
      payload: { value: 'partial' },
      baseVector: {},
    });

    await syncLogs(A, B);
    await syncLogs(B, A);

    // Project on each side — both slots resolved, both values
    // present, no conflict in either field.
    const projectionA = projectReviewDraft(
      'thread_multi',
      '',
      await A.log.readByAggregate('thread_multi'),
    );
    const projectionB = projectReviewDraft(
      'thread_multi',
      '',
      await B.log.readByAggregate('thread_multi'),
    );
    expect(projectionA.overall).toMatchObject({ status: 'resolved', value: 'A side overall' });
    expect(projectionA.verdict).toMatchObject({ status: 'resolved', value: 'partial' });
    expect(projectionB.overall).toMatchObject({ status: 'resolved', value: 'A side overall' });
    expect(projectionB.verdict).toMatchObject({ status: 'resolved', value: 'partial' });
  });
});

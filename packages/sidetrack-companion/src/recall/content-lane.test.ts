import { describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import {
  createDirtySourceQueue,
  foldGroupBEventIntoQueue,
} from './content-lane.js';
import { CAPTURE_RECORDED, RECALL_TOMBSTONE_TARGET } from './events.js';
import { CAPTURE_EXTRACTION_PRODUCED } from './extraction/events.js';

const makeEvent = (seq: number, type: string, payload: unknown): AcceptedEvent => ({
  clientEventId: `evt-${String(seq)}`,
  dot: { replicaId: 'replica-A', seq },
  deps: {},
  aggregateId: 'agg',
  type,
  payload,
  acceptedAtMs: 1_700_000_000_000 + seq * 1000,
});

describe('Stage 5.2 W7 — DirtySourceQueue', () => {
  it('markDirty is idempotent for the same source unit id', () => {
    const queue = createDirtySourceQueue();
    queue.markDirty('source-1');
    queue.markDirty('source-1');
    queue.markDirty('source-1');
    const snap = queue.snapshot();
    expect(snap.dirtySourceUnitIds).toEqual(['source-1']);
    expect(snap.tombstonedSourceUnitIds).toEqual([]);
  });

  it('markDirty ignores empty source unit ids', () => {
    const queue = createDirtySourceQueue();
    queue.markDirty('');
    expect(queue.snapshot().dirtySourceUnitIds).toEqual([]);
  });

  it('markTombstoned implies dirty (tombstoned units appear in both sets)', () => {
    const queue = createDirtySourceQueue();
    queue.markTombstoned('source-tomb');
    const snap = queue.snapshot();
    expect(snap.dirtySourceUnitIds).toEqual(['source-tomb']);
    expect(snap.tombstonedSourceUnitIds).toEqual(['source-tomb']);
  });

  it('recordLatestExtraction stores by source unit id, last-wins', () => {
    const queue = createDirtySourceQueue();
    queue.recordLatestExtraction('source-1', 'rev-1');
    queue.recordLatestExtraction('source-1', 'rev-2');
    expect(queue.snapshot().latestExtractionFor.get('source-1')).toBe('rev-2');
  });

  it('recordLatestExtraction ignores empty ids/revisions', () => {
    const queue = createDirtySourceQueue();
    queue.recordLatestExtraction('', 'rev-1');
    queue.recordLatestExtraction('source-1', '');
    expect(queue.snapshot().latestExtractionFor.size).toBe(0);
  });

  it('clear() removes dirty + tombstoned but retains latestExtraction', () => {
    const queue = createDirtySourceQueue();
    queue.markDirty('a');
    queue.markTombstoned('b');
    queue.recordLatestExtraction('a', 'rev-a');
    queue.clear(['a', 'b']);
    const snap = queue.snapshot();
    expect(snap.dirtySourceUnitIds).toEqual([]);
    expect(snap.tombstonedSourceUnitIds).toEqual([]);
    expect(snap.latestExtractionFor.get('a')).toBe('rev-a');
  });

  it('clearAll() resets everything (used on companion restart)', () => {
    const queue = createDirtySourceQueue();
    queue.markDirty('a');
    queue.markTombstoned('b');
    queue.recordLatestExtraction('a', 'rev-a');
    queue.clearAll();
    const snap = queue.snapshot();
    expect(snap.dirtySourceUnitIds).toEqual([]);
    expect(snap.tombstonedSourceUnitIds).toEqual([]);
    expect(snap.latestExtractionFor.size).toBe(0);
  });

  it('snapshot ids are sorted deterministically', () => {
    const queue = createDirtySourceQueue();
    queue.markDirty('z');
    queue.markDirty('a');
    queue.markDirty('m');
    expect(queue.snapshot().dirtySourceUnitIds).toEqual(['a', 'm', 'z']);
  });
});

describe('Stage 5.2 W7 — foldGroupBEventIntoQueue', () => {
  it('capture.recorded marks the sourceUnitId dirty', () => {
    const queue = createDirtySourceQueue();
    const handled = foldGroupBEventIntoQueue(
      queue,
      makeEvent(1, CAPTURE_RECORDED, { sourceUnitId: 'source-1', bac_id: 'bac-1' }),
    );
    expect(handled).toBe(true);
    expect(queue.snapshot().dirtySourceUnitIds).toEqual(['source-1']);
  });

  it('capture.extraction.produced marks dirty AND records the latest revision', () => {
    const queue = createDirtySourceQueue();
    const handled = foldGroupBEventIntoQueue(
      queue,
      makeEvent(1, CAPTURE_EXTRACTION_PRODUCED, {
        sourceUnitId: 'source-1',
        extractionRevisionId: 'rev-1',
      }),
    );
    expect(handled).toBe(true);
    const snap = queue.snapshot();
    expect(snap.dirtySourceUnitIds).toEqual(['source-1']);
    expect(snap.latestExtractionFor.get('source-1')).toBe('rev-1');
  });

  it('recall.tombstone.target marks tombstoned', () => {
    const queue = createDirtySourceQueue();
    const handled = foldGroupBEventIntoQueue(
      queue,
      makeEvent(1, RECALL_TOMBSTONE_TARGET, { sourceUnitId: 'source-1' }),
    );
    expect(handled).toBe(true);
    const snap = queue.snapshot();
    expect(snap.dirtySourceUnitIds).toEqual(['source-1']);
    expect(snap.tombstonedSourceUnitIds).toEqual(['source-1']);
  });

  it('returns true (handled) but no-ops when the Group B payload lacks sourceUnitId', () => {
    const queue = createDirtySourceQueue();
    expect(foldGroupBEventIntoQueue(queue, makeEvent(1, CAPTURE_RECORDED, {}))).toBe(true);
    expect(foldGroupBEventIntoQueue(queue, makeEvent(2, RECALL_TOMBSTONE_TARGET, {}))).toBe(true);
    expect(foldGroupBEventIntoQueue(queue, makeEvent(3, CAPTURE_EXTRACTION_PRODUCED, {}))).toBe(true);
    const snap = queue.snapshot();
    expect(snap.dirtySourceUnitIds).toEqual([]);
    expect(snap.tombstonedSourceUnitIds).toEqual([]);
    expect(snap.latestExtractionFor.size).toBe(0);
  });

  it('non-Group-B events return false (caller falls through)', () => {
    const queue = createDirtySourceQueue();
    const handled = foldGroupBEventIntoQueue(
      queue,
      makeEvent(1, 'unrelated.event', { whatever: 1 }),
    );
    expect(handled).toBe(false);
    expect(queue.snapshot().dirtySourceUnitIds).toEqual([]);
  });

  it('stream of mixed Group B events accumulates the right state', () => {
    const queue = createDirtySourceQueue();
    foldGroupBEventIntoQueue(
      queue,
      makeEvent(1, CAPTURE_RECORDED, { sourceUnitId: 's1' }),
    );
    foldGroupBEventIntoQueue(
      queue,
      makeEvent(2, CAPTURE_EXTRACTION_PRODUCED, {
        sourceUnitId: 's1',
        extractionRevisionId: 'rev-a',
      }),
    );
    foldGroupBEventIntoQueue(
      queue,
      makeEvent(3, CAPTURE_EXTRACTION_PRODUCED, {
        sourceUnitId: 's1',
        extractionRevisionId: 'rev-b', // newer revision wins
      }),
    );
    foldGroupBEventIntoQueue(
      queue,
      makeEvent(4, CAPTURE_RECORDED, { sourceUnitId: 's2' }),
    );
    foldGroupBEventIntoQueue(
      queue,
      makeEvent(5, RECALL_TOMBSTONE_TARGET, { sourceUnitId: 's2' }),
    );
    const snap = queue.snapshot();
    expect(snap.dirtySourceUnitIds).toEqual(['s1', 's2']);
    expect(snap.tombstonedSourceUnitIds).toEqual(['s2']);
    expect(snap.latestExtractionFor.get('s1')).toBe('rev-b');
  });
});

// Stage 5.2 W7 — verify the connections materializer accumulates
// Group B events into its dirty-source queue on every accepted event
// and exposes them via getDirtySources(). Wiring-only test; no
// reconciler runs here.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConnectionsStore } from '../../connections/snapshot.js';
import { createTimelineStore } from '../../timeline/projection.js';
import { CAPTURE_RECORDED, RECALL_TOMBSTONE_TARGET } from '../../recall/events.js';
import { CAPTURE_EXTRACTION_PRODUCED } from '../../recall/extraction/events.js';
import type { AcceptedEvent } from '../causal.js';
import { createConnectionsMaterializer } from './connectionsMaterializer.js';

const buildEvent = (input: { seq: number; type: string; payload: unknown }): AcceptedEvent => ({
  clientEventId: `evt-${String(input.seq)}`,
  dot: { replicaId: 'replica-A', seq: input.seq },
  deps: {},
  aggregateId: 'agg',
  type: input.type,
  payload: input.payload,
  acceptedAtMs: 1_700_000_000_000 + input.seq * 1000,
});

describe('Stage 5.2 W7 — connectionsMaterializer dirty-source queue wiring', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-w7-wiring-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const createMat = (): ReturnType<typeof createConnectionsMaterializer> =>
    createConnectionsMaterializer({
      vaultRoot,
      // The dirty-queue wiring lives in onAccepted before any I/O —
      // tests only need the materializer surface, not a working
      // eventLog / timelineStore / store. Pass minimal stubs that
      // satisfy the type but never get hit.
      eventLog: {
        appendClient: () => {
          throw new Error('unused');
        },
        readMerged: () => Promise.resolve([]),
        append: () => {
          throw new Error('unused');
        },
      } as any,
      timelineStore: createTimelineStore(vaultRoot),
      store: createConnectionsStore(vaultRoot),
    });

  it('capture.recorded accumulates the sourceUnitId into the dirty set', () => {
    const mat = createMat();
    mat.onAccepted(
      buildEvent({ seq: 1, type: CAPTURE_RECORDED, payload: { sourceUnitId: 'src-1' } }),
      { origin: 'local' },
    );
    expect(mat.getDirtySources().dirtySourceUnitIds).toEqual(['src-1']);
  });

  it('capture.extraction.produced records the latest extractionRevisionId', () => {
    const mat = createMat();
    mat.onAccepted(
      buildEvent({
        seq: 1,
        type: CAPTURE_EXTRACTION_PRODUCED,
        payload: {
          sourceUnitId: 'src-1',
          extractionRevisionId: 'rev-1',
          extractorId: 'extractor',
          extractorVersion: '1',
          extractionSchemaVersion: 1,
          content: {},
        },
      }),
      { origin: 'local' },
    );
    mat.onAccepted(
      buildEvent({
        seq: 2,
        type: CAPTURE_EXTRACTION_PRODUCED,
        payload: {
          sourceUnitId: 'src-1',
          extractionRevisionId: 'rev-2',
          extractorId: 'extractor',
          extractorVersion: '1',
          extractionSchemaVersion: 1,
          content: {},
        },
      }),
      { origin: 'local' },
    );
    const snap = mat.getDirtySources();
    expect(snap.dirtySourceUnitIds).toEqual(['src-1']);
    expect(snap.latestExtractionFor.get('src-1')).toBe('rev-2');
  });

  it('recall.tombstone.target marks sources tombstoned (and dirty)', () => {
    const mat = createMat();
    mat.onAccepted(
      buildEvent({
        seq: 1,
        type: RECALL_TOMBSTONE_TARGET,
        payload: { sourceUnitId: 'src-tomb' },
      }),
      { origin: 'local' },
    );
    const snap = mat.getDirtySources();
    expect(snap.dirtySourceUnitIds).toEqual(['src-tomb']);
    expect(snap.tombstonedSourceUnitIds).toEqual(['src-tomb']);
  });

  it('clearDirtySources drains specific entries (retains latest revisions)', () => {
    const mat = createMat();
    mat.onAccepted(
      buildEvent({ seq: 1, type: CAPTURE_RECORDED, payload: { sourceUnitId: 'src-1' } }),
      { origin: 'local' },
    );
    mat.onAccepted(
      buildEvent({
        seq: 2,
        type: CAPTURE_EXTRACTION_PRODUCED,
        payload: {
          sourceUnitId: 'src-1',
          extractionRevisionId: 'rev-1',
          extractorId: 'extractor',
          extractorVersion: '1',
          extractionSchemaVersion: 1,
          content: {},
        },
      }),
      { origin: 'local' },
    );
    mat.onAccepted(
      buildEvent({ seq: 3, type: CAPTURE_RECORDED, payload: { sourceUnitId: 'src-2' } }),
      { origin: 'local' },
    );
    mat.clearDirtySources(['src-1']);
    const snap = mat.getDirtySources();
    expect(snap.dirtySourceUnitIds).toEqual(['src-2']);
    // latestExtractionFor is intentionally retained across clears so
    // the next dirty cycle for src-1 still has a known revision.
    expect(snap.latestExtractionFor.get('src-1')).toBe('rev-1');
  });

  it('non-Group-B events do not touch the queue', () => {
    const mat = createMat();
    mat.onAccepted(buildEvent({ seq: 1, type: 'unrelated.event', payload: {} }), {
      origin: 'local',
    });
    const snap = mat.getDirtySources();
    expect(snap.dirtySourceUnitIds).toEqual([]);
    expect(snap.tombstonedSourceUnitIds).toEqual([]);
    expect(snap.latestExtractionFor.size).toBe(0);
  });
});

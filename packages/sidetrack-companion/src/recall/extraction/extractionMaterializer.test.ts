import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../../sync/causal.js';
import { wrapCaptureAsLegacyRevisions } from './legacyExtractor.js';
import { createExtractionStore } from './store.js';

// Lane 2 stage 3 — extraction store + legacy capture wrap.
//
// Asserts:
//   - Same input → same extractionRevisionId (idempotent identity).
//   - Putting + reading a revision round-trips.
//   - Source state pointer split (latest vs indexed) drives
//     "stale" → "current" transitions.
//   - Gate L2-G6 (legacy capture migration is no-op for behavior;
//     existing recall returns the same chunks pre/post Stage E3 —
//     we cover the data side here; behavioral parity is asserted
//     by the existing recall unit tests still passing after
//     extractionMaterializer wires in).

const captureEvent = (turns: { text: string; ordinal: number }[]): AcceptedEvent => ({
  clientEventId: 'cap-1',
  dot: { replicaId: 'peer-A', seq: 1 },
  deps: {},
  aggregateId: 'thread-1',
  type: 'capture.recorded',
  payload: {
    bac_id: 'thread-1',
    threadUrl: 'https://chatgpt.com/c/thread-1',
    provider: 'chatgpt',
    title: 'Capture probe',
    capturedAt: '2026-05-07T00:00:00.000Z',
    turns: turns.map((t) => ({ ordinal: t.ordinal, role: 'user' as const, text: t.text })),
  },
  acceptedAtMs: 1,
});

describe('extraction store + legacy capture wrap', () => {
  let vault: string;
  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'sidetrack-l2-extract-'));
  });
  afterEach(async () => {
    await rm(vault, { recursive: true, force: true });
  });

  it('wrapCaptureAsLegacyRevisions emits one revision per turn; ids deterministic', () => {
    const evt = captureEvent([
      { text: 'first turn', ordinal: 0 },
      { text: 'second turn', ordinal: 1 },
    ]);
    const a = wrapCaptureAsLegacyRevisions(evt);
    const b = wrapCaptureAsLegacyRevisions(evt);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    expect(a[0]?.extractionRevisionId).toBe(b[0]?.extractionRevisionId);
    expect(a[1]?.extractionRevisionId).toBe(b[1]?.extractionRevisionId);
    // Different turns produce different sourceUnitIds (per-turn unit).
    expect(a[0]?.sourceUnitId).not.toBe(a[1]?.sourceUnitId);
  });

  it('extraction store round-trips a revision + source state', async () => {
    const store = createExtractionStore(vault);
    const evt = captureEvent([{ text: 'hi', ordinal: 0 }]);
    const [revision] = wrapCaptureAsLegacyRevisions(evt);
    expect(revision).toBeDefined();
    await store.putRevision(revision!);
    const readBack = await store.readRevision(revision!.extractionRevisionId);
    expect(readBack?.extractionRevisionId).toBe(revision!.extractionRevisionId);

    await store.putSourceState({
      sourceUnitId: revision!.sourceUnitId,
      sourceBacId: revision!.sourceBacId,
      latestExtractionRevision: revision!.extractionRevisionId,
      status: 'stale',
      history: [
        {
          extractionRevisionId: revision!.extractionRevisionId,
          extractorId: revision!.extractorId,
          extractorVersion: revision!.extractorVersion,
          createdAt: revision!.createdAt,
        },
      ],
    });
    const state = await store.readSourceState(revision!.sourceUnitId);
    expect(state?.status).toBe('stale');
    expect(state?.latestExtractionRevision).toBe(revision!.extractionRevisionId);
  });

  it('markIndexed flips status to current when indexed=latest; stays stale otherwise', async () => {
    const store = createExtractionStore(vault);
    const evt = captureEvent([{ text: 'hi', ordinal: 0 }]);
    const [revision] = wrapCaptureAsLegacyRevisions(evt);
    expect(revision).toBeDefined();
    await store.putSourceState({
      sourceUnitId: revision!.sourceUnitId,
      sourceBacId: revision!.sourceBacId,
      latestExtractionRevision: revision!.extractionRevisionId,
      status: 'stale',
      history: [],
    });
    await store.markIndexed(revision!.sourceUnitId, revision!.extractionRevisionId);
    const after = await store.readSourceState(revision!.sourceUnitId);
    expect(after?.status).toBe('current');
    expect(after?.indexedExtractionRevision).toBe(revision!.extractionRevisionId);

    // Indexing a stale older revision keeps status='stale' and
    // updates indexed pointer.
    await store.putSourceState({
      ...after!,
      latestExtractionRevision: 'extract_legacy_v1_newer',
      status: 'stale',
    });
    await store.markIndexed(revision!.sourceUnitId, revision!.extractionRevisionId);
    const after2 = await store.readSourceState(revision!.sourceUnitId);
    expect(after2?.status).toBe('stale');
    expect(after2?.indexedExtractionRevision).toBe(revision!.extractionRevisionId);
  });

  it('listStaleSources returns only sources whose status === stale', async () => {
    const store = createExtractionStore(vault);
    await store.putSourceState({
      sourceUnitId: 'src:A',
      sourceBacId: 't',
      latestExtractionRevision: 'rev-A',
      indexedExtractionRevision: 'rev-A',
      status: 'current',
      history: [],
    });
    await store.putSourceState({
      sourceUnitId: 'src:B',
      sourceBacId: 't',
      latestExtractionRevision: 'rev-B-v2',
      indexedExtractionRevision: 'rev-B-v1',
      status: 'stale',
      history: [],
    });
    const stale = await store.listStaleSources();
    expect(stale).toHaveLength(1);
    expect(stale[0]?.sourceUnitId).toBe('src:B');
  });
});

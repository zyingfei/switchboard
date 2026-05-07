import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CAPTURE_EXTRACTION_PRODUCED } from '../../recall/extraction/events.js';
import { createExtractionStore } from '../../recall/extraction/store.js';
import type { AcceptedEvent } from '../causal.js';
import { createEventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { createExtractionMaterializer } from './extractionMaterializer.js';

// Reviewer-flagged: concurrent extraction events for the SAME
// sourceUnitId must serialize through a per-source queue or the
// read-modify-write of source state racy → history entries lost.
// This test fires N events for the same source AND M events for
// a different source, then asserts every history entry survives.

describe('extraction materializer — per-source serialization (reviewer fix 3)', () => {
  let vaultRoot: string;
  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-l2-extract-conc-'));
  });
  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const event = (input: {
    seq: number;
    sourceUnitId: string;
    extractionRevisionId: string;
  }): AcceptedEvent => ({
    clientEventId: `evt-${String(input.seq)}`,
    dot: { replicaId: 'peer', seq: input.seq },
    deps: {},
    aggregateId: 'thread-conc',
    type: CAPTURE_EXTRACTION_PRODUCED,
    payload: {
      sourceUnitId: input.sourceUnitId,
      sourceBacId: 'thread-conc',
      extractionRevisionId: input.extractionRevisionId,
      extractorId: 'legacy',
      extractorVersion: '0.0.0',
      extractionSchemaVersion: 1,
      inputHash: 'h',
      outputHash: 'h',
      chunkerVersion: 'legacy',
      content: {
        turns: [{ ordinal: 0, role: 'user', text: `text for seq ${String(input.seq)}` }],
        capturedAt: '2026-05-07T00:00:00.000Z',
      },
    },
    acceptedAtMs: input.seq,
  });

  it('20 concurrent events on same sourceUnitId all survive — no lost history entries', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createExtractionStore(vaultRoot);
    const m = createExtractionMaterializer({ store, eventLog });

    // Fire 20 events for the SAME sourceUnitId in parallel; each
    // one does read → mutate → write of the source state file.
    // Without per-source serialization, later writes overwrite
    // earlier writes' history-append.
    const N = 20;
    for (let i = 1; i <= N; i += 1) {
      m.onAccepted(
        event({
          seq: i,
          sourceUnitId: 'src:CONC:turn-0',
          extractionRevisionId: `rev-${String(i)}`,
        }),
        { origin: 'peer' },
      );
    }
    await m.awaitIdle();

    const state = await store.readSourceState('src:CONC:turn-0');
    expect(state, 'state file written').not.toBeNull();
    const ids = state!.history.map((h) => h.extractionRevisionId).sort();
    // history is bounded to last 20 entries; here we sent exactly
    // 20, so all should be present.
    expect(ids).toHaveLength(N);
    for (let i = 1; i <= N; i += 1) {
      expect(ids).toContain(`rev-${String(i)}`);
    }
  });

  it('different sources run in parallel — no cross-source blocking', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createExtractionStore(vaultRoot);
    const m = createExtractionMaterializer({ store, eventLog });

    // 5 events to source A interleaved with 5 to source B.
    // Both sources should accumulate their full history.
    for (let i = 1; i <= 5; i += 1) {
      m.onAccepted(
        event({
          seq: i,
          sourceUnitId: 'src:A:turn-0',
          extractionRevisionId: `revA-${String(i)}`,
        }),
        { origin: 'peer' },
      );
      m.onAccepted(
        event({
          seq: 100 + i,
          sourceUnitId: 'src:B:turn-0',
          extractionRevisionId: `revB-${String(i)}`,
        }),
        { origin: 'peer' },
      );
    }
    await m.awaitIdle();

    const stateA = await store.readSourceState('src:A:turn-0');
    const stateB = await store.readSourceState('src:B:turn-0');
    expect(stateA?.history).toHaveLength(5);
    expect(stateB?.history).toHaveLength(5);
  });

  it('schema version + producer dot survive in history (reviewer fix 2)', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createExtractionStore(vaultRoot);
    const m = createExtractionMaterializer({ store, eventLog });

    m.onAccepted(
      event({ seq: 1, sourceUnitId: 'src:M:turn-0', extractionRevisionId: 'rev-meta' }),
      { origin: 'peer' },
    );
    await m.awaitIdle();

    const state = await store.readSourceState('src:M:turn-0');
    expect(state).not.toBeNull();
    expect(state!.history).toHaveLength(1);
    const entry = state!.history[0]!;
    expect(entry.extractionSchemaVersion).toBe(1);
    expect(entry.producerDot).toEqual({ replicaId: 'peer', seq: 1 });
  });
});

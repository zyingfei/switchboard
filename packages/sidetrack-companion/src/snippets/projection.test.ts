import { describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import { SELECTION_COPIED, SELECTION_PASTED } from './events.js';
import { projectSnippetLineage } from './projection.js';

const event = (input: {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
  readonly acceptedAtMs: number;
}): AcceptedEvent => ({
  clientEventId: `evt-${String(input.seq)}`,
  dot: { replicaId: 'replica-a', seq: input.seq },
  deps: {},
  aggregateId: 'selection',
  type: input.type,
  payload: input.payload,
  acceptedAtMs: input.acceptedAtMs,
});

const copiedPayload = (overrides: Record<string, unknown> = {}) => ({
  payloadVersion: 1,
  visitId: 'visit:a',
  selectionHash: 'hash-a',
  simhash64: 'AAAAAAAAAAA=',
  charCount: 10,
  lineCount: 1,
  contentKindHint: 'prose',
  rawTextStored: false,
  ...overrides,
});

const pastedPayload = (overrides: Record<string, unknown> = {}) => ({
  payloadVersion: 1,
  destinationKind: 'thread',
  destinationId: 'thread:b',
  selectionHash: 'hash-a',
  simhash64: 'AAAAAAAAAAA=',
  charCount: 10,
  rawTextStored: false,
  ...overrides,
});

describe('snippet lineage projection', () => {
  it('matches exact hashes within 24 hours', () => {
    const projection = projectSnippetLineage([
      event({ seq: 1, type: SELECTION_COPIED, payload: copiedPayload(), acceptedAtMs: 1_000 }),
      event({ seq: 2, type: SELECTION_PASTED, payload: pastedPayload(), acceptedAtMs: 2_000 }),
    ]);
    expect(projection.lineages).toHaveLength(1);
    expect(projection.lineages[0]?.match).toBe('exact');
    expect(projection.lineages[0]?.copiedVisitId).toBe('visit:a');
  });

  it('matches fuzzy simhash within hamming distance 3', () => {
    const projection = projectSnippetLineage([
      event({
        seq: 1,
        type: SELECTION_COPIED,
        payload: copiedPayload({ selectionHash: 'hash-a', simhash64: 'AAAAAAAAAAA=' }),
        acceptedAtMs: 1_000,
      }),
      event({
        seq: 2,
        type: SELECTION_PASTED,
        payload: pastedPayload({ selectionHash: 'hash-b', simhash64: 'AAAAAAAAAAE=' }),
        acceptedAtMs: 2_000,
      }),
    ]);
    expect(projection.lineages).toHaveLength(1);
    expect(projection.lineages[0]?.match).toBe('fuzzy');
  });

  it('does not match across the 24-hour window', () => {
    const projection = projectSnippetLineage([
      event({ seq: 1, type: SELECTION_COPIED, payload: copiedPayload(), acceptedAtMs: 1_000 }),
      event({
        seq: 2,
        type: SELECTION_PASTED,
        payload: pastedPayload(),
        acceptedAtMs: 1_000 + 24 * 60 * 60 * 1_000 + 1,
      }),
    ]);
    expect(projection.lineages).toHaveLength(0);
  });

  it('rejects payloads that try to store raw text', () => {
    const projection = projectSnippetLineage([
      event({
        seq: 1,
        type: SELECTION_COPIED,
        payload: copiedPayload({ rawTextStored: true }),
        acceptedAtMs: 1_000,
      }),
      event({ seq: 2, type: SELECTION_PASTED, payload: pastedPayload(), acceptedAtMs: 2_000 }),
    ]);
    expect(projection.lineages).toHaveLength(0);
  });
});

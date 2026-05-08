import { describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import { VISUAL_FINGERPRINT_OBSERVED } from './events.js';
import { projectVisualFingerprints } from './projection.js';

const event = (input: {
  readonly seq: number;
  readonly visitId: string;
  readonly domHash: string;
  readonly observedAt: string;
}): AcceptedEvent => ({
  clientEventId: `visual-${String(input.seq)}`,
  dot: { replicaId: 'replica-a', seq: input.seq },
  deps: {},
  aggregateId: input.visitId,
  type: VISUAL_FINGERPRINT_OBSERVED,
  payload: {
    payloadVersion: 1,
    visitId: input.visitId,
    domHash: input.domHash,
    observedAt: input.observedAt,
  },
  acceptedAtMs: Date.parse(input.observedAt),
});

describe('visual fingerprint projection', () => {
  it('keeps the latest DOM hash per visit deterministically', () => {
    const firstHash = 'a'.repeat(64);
    const secondHash = 'b'.repeat(64);
    const projection = projectVisualFingerprints([
      event({
        seq: 2,
        visitId: 'visit-a',
        domHash: secondHash,
        observedAt: '2026-05-08T12:01:00.000Z',
      }),
      event({
        seq: 1,
        visitId: 'visit-a',
        domHash: firstHash,
        observedAt: '2026-05-08T12:00:00.000Z',
      }),
    ]);

    expect(projection).toEqual({
      schemaVersion: 1,
      fingerprints: [
        {
          visitId: 'visit-a',
          domHash: secondHash,
          observedAt: '2026-05-08T12:01:00.000Z',
          replicaId: 'replica-a',
          seq: 2,
          acceptedAtMs: Date.parse('2026-05-08T12:01:00.000Z'),
        },
      ],
    });
  });
});

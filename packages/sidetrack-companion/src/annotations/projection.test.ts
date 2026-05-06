import { describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import {
  ANNOTATION_CREATED,
  ANNOTATION_DELETED,
  ANNOTATION_NOTE_SET,
} from './events.js';
import { projectAnnotations } from './projection.js';

const anchor = (exact: string) => ({
  textQuote: { exact, prefix: '', suffix: '' },
  textPosition: { start: 0, end: exact.length },
  cssSelector: 'main',
});

const event = (
  partial: {
    readonly type: string;
    readonly replicaId: string;
    readonly seq: number;
    readonly payload: Record<string, unknown>;
    readonly deps?: Record<string, number>;
  },
): AcceptedEvent => ({
  clientEventId: `${partial.replicaId}.${String(partial.seq)}`,
  dot: { replicaId: partial.replicaId, seq: partial.seq },
  deps: partial.deps ?? {},
  aggregateId: 'a',
  type: partial.type,
  payload: partial.payload,
  acceptedAtMs: 0,
});

describe('projectAnnotations', () => {
  it('projects a created annotation with its initial note', () => {
    const events = [
      event({
        type: ANNOTATION_CREATED,
        replicaId: 'A',
        seq: 1,
        payload: {
          bac_id: 'a-1',
          url: 'https://x',
          anchor: anchor('hi'),
          note: 'first',
        },
      }),
    ];
    const projection = projectAnnotations(events);
    expect(projection.entries).toHaveLength(1);
    expect(projection.entries[0]?.note).toMatchObject({ status: 'resolved', value: 'first' });
  });

  it('LWW note: a later note.set with deps observing the earlier wins', () => {
    const events = [
      event({
        type: ANNOTATION_CREATED,
        replicaId: 'A',
        seq: 1,
        payload: { bac_id: 'a-1', url: 'https://x', anchor: anchor('hi'), note: 'first' },
      }),
      event({
        type: ANNOTATION_NOTE_SET,
        replicaId: 'A',
        seq: 2,
        deps: { A: 1 },
        payload: { bac_id: 'a-1', note: 'second' },
      }),
    ];
    const projection = projectAnnotations(events);
    expect(projection.entries[0]?.note).toMatchObject({ status: 'resolved', value: 'second' });
  });

  it('concurrent note edits surface as a conflict', () => {
    const events = [
      event({
        type: ANNOTATION_CREATED,
        replicaId: 'A',
        seq: 1,
        payload: { bac_id: 'a-1', url: 'https://x', anchor: anchor('hi'), note: 'init' },
      }),
      event({
        type: ANNOTATION_NOTE_SET,
        replicaId: 'A',
        seq: 2,
        deps: { A: 1 },
        payload: { bac_id: 'a-1', note: 'A wrote' },
      }),
      event({
        type: ANNOTATION_NOTE_SET,
        replicaId: 'B',
        seq: 1,
        deps: { A: 1 },
        payload: { bac_id: 'a-1', note: 'B wrote' },
      }),
    ];
    const projection = projectAnnotations(events);
    expect(projection.entries[0]?.note.status).toBe('conflict');
  });

  it('soft delete tombstones the entry', () => {
    const events = [
      event({
        type: ANNOTATION_CREATED,
        replicaId: 'A',
        seq: 1,
        payload: { bac_id: 'a-1', url: 'https://x', anchor: anchor('hi'), note: 'init' },
      }),
      event({
        type: ANNOTATION_DELETED,
        replicaId: 'A',
        seq: 2,
        deps: { A: 1 },
        payload: { bac_id: 'a-1' },
      }),
    ];
    const projection = projectAnnotations(events);
    expect(projection.entries[0]?.deleted).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';

import {
  type AcceptedEvent,
  eventDominates,
  maxVector,
  mergeRegister,
  type RegisterProjection,
  sortAcceptedEvents,
  vectorCovers,
  vectorFromEvents,
} from './causal.js';

const accepted = (
  replicaId: string,
  seq: number,
  deps: Record<string, number> = {},
  payload: Record<string, unknown> = {},
  acceptedAtMs = 0,
): AcceptedEvent<Record<string, unknown>> => ({
  clientEventId: `${replicaId}.${String(seq)}.${String(Math.random())}`,
  dot: { replicaId, seq },
  deps,
  aggregateId: 'agg',
  type: 't',
  payload,
  acceptedAtMs,
});

describe('causal vector helpers', () => {
  it('vectorCovers compares per-replica seq', () => {
    expect(vectorCovers({}, { replicaId: 'A', seq: 1 })).toBe(false);
    expect(vectorCovers({ A: 0 }, { replicaId: 'A', seq: 1 })).toBe(false);
    expect(vectorCovers({ A: 1 }, { replicaId: 'A', seq: 1 })).toBe(true);
    expect(vectorCovers({ A: 5 }, { replicaId: 'A', seq: 3 })).toBe(true);
    expect(vectorCovers({ B: 5 }, { replicaId: 'A', seq: 1 })).toBe(false);
  });

  it('maxVector takes per-replica maxima', () => {
    expect(maxVector({ A: 1, B: 2 }, { A: 5, C: 7 })).toEqual({ A: 5, B: 2, C: 7 });
  });

  it('vectorFromEvents collects highest seq per replica', () => {
    const events = [
      accepted('A', 1),
      accepted('A', 2),
      accepted('B', 7),
    ];
    expect(vectorFromEvents(events)).toEqual({ A: 2, B: 7 });
  });
});

describe('eventDominates', () => {
  it('says newer dominates older when deps cover older.dot', () => {
    const older = accepted('A', 1);
    const newer = accepted('B', 1, { A: 1 });
    expect(eventDominates(newer, older)).toBe(true);
    expect(eventDominates(older, newer)).toBe(false);
  });

  it('returns false for two events that have not observed each other', () => {
    const a = accepted('A', 1);
    const b = accepted('B', 1);
    expect(eventDominates(a, b)).toBe(false);
    expect(eventDominates(b, a)).toBe(false);
  });

  it('returns false when comparing an event to itself', () => {
    const a = accepted('A', 1, { A: 0 });
    expect(eventDominates(a, a)).toBe(false);
  });
});

describe('mergeRegister', () => {
  const value = (
    label: string,
    replicaId: string,
    seq: number,
    deps: Record<string, number> = {},
    acceptedAtMs = 0,
  ) => ({
    value: label,
    event: accepted(replicaId, seq, deps, {}, acceptedAtMs),
  });

  it('returns a resolved-empty projection when there are no candidates', () => {
    const projection = mergeRegister<string>([]);
    expect(projection).toEqual<RegisterProjection<string>>({ status: 'resolved' });
  });

  it('a single candidate resolves directly', () => {
    const projection = mergeRegister([value('only', 'A', 3, {}, 100)]);
    expect(projection).toMatchObject({ status: 'resolved', value: 'only' });
  });

  it('a later edit that observed the earlier resolves to the later value', () => {
    const a = value('first', 'A', 1, {}, 100);
    const b = value('second', 'A', 2, { A: 1 }, 200);
    const projection = mergeRegister([a, b]);
    expect(projection).toMatchObject({ status: 'resolved', value: 'second' });
  });

  it('two concurrent edits surface as a conflict with sorted candidates', () => {
    const a = value('A wrote', 'A', 1, {}, 100);
    const b = value('B wrote', 'B', 1, {}, 200);
    const projection = mergeRegister([a, b]);
    expect(projection.status).toBe('conflict');
    if (projection.status !== 'conflict') return;
    expect(projection.candidates.map((c) => c.value)).toEqual(['A wrote', 'B wrote']);
  });

  it('a third edit that observed both candidates wins and resolves the conflict', () => {
    const a = value('A wrote', 'A', 1, {}, 100);
    const b = value('B wrote', 'B', 1, {}, 200);
    const c = value('merged', 'B', 2, { A: 1, B: 1 }, 300);
    const projection = mergeRegister([a, b, c]);
    expect(projection).toMatchObject({ status: 'resolved', value: 'merged' });
  });
});

describe('sortAcceptedEvents', () => {
  it('orders by (replicaId, seq) for deterministic projection builds', () => {
    const events = [accepted('B', 2), accepted('A', 1), accepted('A', 2)];
    const sorted = sortAcceptedEvents(events);
    expect(sorted.map((e) => `${e.dot.replicaId}.${String(e.dot.seq)}`)).toEqual([
      'A.1',
      'A.2',
      'B.2',
    ]);
  });
});

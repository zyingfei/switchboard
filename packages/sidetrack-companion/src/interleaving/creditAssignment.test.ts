import { describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import { RECALL_ACTION, type RecallActionPayload } from '../recall/events.js';
import {
  actionsForImpression,
  assignCredit,
  duelVerdict,
  mergeTallies,
  type InterleavedAction,
} from './creditAssignment.js';
import { teamDraftInterleave } from './teamDraft.js';

const strip = teamDraftInterleave(
  { producer: 'incumbent', items: ['i1', 'i2'] },
  { producer: 'candidate', items: ['c1', 'c2'] },
  7,
).items;

describe('assignCredit', () => {
  it('credits a winning action to the producer that drafted the item', () => {
    // Whatever the coin did, i1 belongs to incumbent and c1 to candidate.
    const actions: InterleavedAction[] = [
      { itemId: 'i1', actionKind: 'click' },
      { itemId: 'c1', actionKind: 'flow_confirm' },
      { itemId: 'c2', actionKind: 'open_new_tab' },
    ];
    const tally = assignCredit(strip, actions);
    expect(tally.wins.get('incumbent')).toBe(1);
    expect(tally.wins.get('candidate')).toBe(2);
    // Draft share (exposure) is 2 items each.
    expect(tally.shown.get('incumbent')).toBe(2);
    expect(tally.shown.get('candidate')).toBe(2);
  });

  it('ignores non-winning actions (reject / ignore)', () => {
    const tally = assignCredit(strip, [
      { itemId: 'i1', actionKind: 'reject' },
      { itemId: 'c1', actionKind: 'ignore' },
    ]);
    expect(tally.wins.get('incumbent') ?? 0).toBe(0);
    expect(tally.wins.get('candidate') ?? 0).toBe(0);
  });

  it('ignores actions on items not in this strip', () => {
    const tally = assignCredit(strip, [{ itemId: 'not-in-strip', actionKind: 'click' }]);
    expect(tally.wins.size).toBe(0);
  });

  it('applies inverse-propensity weights', () => {
    const tally = assignCredit(strip, [{ itemId: 'c1', actionKind: 'click', weight: 4 }]);
    expect(tally.wins.get('candidate')).toBe(4);
  });
});

describe('mergeTallies', () => {
  it('sums wins and exposure across impressions', () => {
    const t1 = assignCredit(strip, [{ itemId: 'i1', actionKind: 'click' }]);
    const t2 = assignCredit(strip, [{ itemId: 'i2', actionKind: 'click' }]);
    const merged = mergeTallies([t1, t2]);
    expect(merged.wins.get('incumbent')).toBe(2);
    expect(merged.shown.get('incumbent')).toBe(4); // 2 shown × 2 impressions
    expect(merged.shown.get('candidate')).toBe(4);
  });
});

describe('duelVerdict', () => {
  it('reports a positive preference when the candidate wins more', () => {
    const tally = assignCredit(strip, [
      { itemId: 'c1', actionKind: 'click' },
      { itemId: 'c2', actionKind: 'click' },
      { itemId: 'i1', actionKind: 'click' },
    ]);
    const verdict = duelVerdict(tally, 'incumbent', 'candidate');
    expect(verdict.candidateWins).toBe(2);
    expect(verdict.incumbentWins).toBe(1);
    // (2 - 1) / (2 + 1) = 1/3.
    expect(verdict.preference).toBeCloseTo(1 / 3, 12);
  });

  it('reports a tie (0) when neither producer won', () => {
    const tally = assignCredit(strip, []);
    expect(duelVerdict(tally, 'incumbent', 'candidate').preference).toBe(0);
  });

  it('reports a negative preference when the incumbent wins more', () => {
    const tally = assignCredit(strip, [
      { itemId: 'i1', actionKind: 'click' },
      { itemId: 'i2', actionKind: 'click' },
    ]);
    expect(duelVerdict(tally, 'incumbent', 'candidate').preference).toBe(-1);
  });
});

describe('actionsForImpression — reads logged events', () => {
  const event = (seq: number, payload: RecallActionPayload): AcceptedEvent => ({
    clientEventId: `evt-${String(seq)}`,
    dot: { replicaId: 'r', seq },
    deps: {},
    aggregateId: payload.servedContextId,
    type: RECALL_ACTION,
    payload,
    acceptedAtMs: 1000 + seq,
  });

  it('extracts only actions for the given impression', () => {
    const events: AcceptedEvent[] = [
      event(1, {
        payloadVersion: 1,
        servedContextId: 'ctx-1',
        entityId: 'i1',
        actionKind: 'click',
        actionAt: '2026-07-13T00:00:00.000Z',
      }),
      event(2, {
        payloadVersion: 1,
        servedContextId: 'ctx-2',
        entityId: 'c1',
        actionKind: 'click',
        actionAt: '2026-07-13T00:00:01.000Z',
      }),
    ];
    const actions = actionsForImpression('ctx-1', events);
    expect(actions.length).toBe(1);
    expect(actions[0]?.itemId).toBe('i1');
    // End-to-end: those actions feed assignCredit against the strip.
    const tally = assignCredit(strip, actions);
    expect(tally.wins.get('incumbent')).toBe(1);
  });

  it('ignores non-recall-action events', () => {
    const events: AcceptedEvent[] = [
      {
        clientEventId: 'x',
        dot: { replicaId: 'r', seq: 1 },
        deps: {},
        aggregateId: 'ctx-1',
        type: 'some.other.event',
        payload: {},
        acceptedAtMs: 1,
      },
    ];
    expect(actionsForImpression('ctx-1', events).length).toBe(0);
  });
});

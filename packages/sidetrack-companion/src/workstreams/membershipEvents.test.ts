import { describe, expect, it } from 'bun:test';

import {
  activeMembershipRows,
  foldWorkstreamMembership,
  isWorkstreamMembershipRemovedPayload,
  isWorkstreamMembershipSetPayload,
  primaryMembershipRow,
  WORKSTREAM_MEMBERSHIP_REMOVED,
  WORKSTREAM_MEMBERSHIP_SET,
  type WorkstreamMembershipRemovedPayload,
  type WorkstreamMembershipSetPayload,
} from './membershipEvents.js';
import type { AcceptedEvent } from '../sync/causal.js';

let seqCounter = 0;

const setEvent = (
  over: Partial<WorkstreamMembershipSetPayload> & { readonly workstreamId: string },
  opts: { readonly atMs?: number; readonly replicaId?: string; readonly seq?: number } = {},
): AcceptedEvent => {
  seqCounter += 1;
  const payload: WorkstreamMembershipSetPayload = {
    payloadVersion: 1,
    subjectKind: 'canonical-url',
    subjectId: 'https://a.test/x',
    role: 'secondary',
    provenance: 'user-filed',
    ...over,
  };
  return {
    clientEventId: `c${seqCounter}`,
    dot: { replicaId: opts.replicaId ?? 'r1', seq: opts.seq ?? seqCounter },
    deps: {},
    aggregateId: `agg-${payload.workstreamId}`,
    type: WORKSTREAM_MEMBERSHIP_SET,
    payload,
    acceptedAtMs: opts.atMs ?? seqCounter * 1000,
  };
};

const removedEvent = (
  over: Partial<WorkstreamMembershipRemovedPayload> & { readonly workstreamId: string },
  opts: { readonly atMs?: number; readonly replicaId?: string; readonly seq?: number } = {},
): AcceptedEvent => {
  seqCounter += 1;
  const payload: WorkstreamMembershipRemovedPayload = {
    payloadVersion: 1,
    subjectKind: 'canonical-url',
    subjectId: 'https://a.test/x',
    reason: 'user-removed',
    ...over,
  };
  return {
    clientEventId: `c${seqCounter}`,
    dot: { replicaId: opts.replicaId ?? 'r1', seq: opts.seq ?? seqCounter },
    deps: {},
    aggregateId: `agg-${payload.workstreamId}`,
    type: WORKSTREAM_MEMBERSHIP_REMOVED,
    payload,
    acceptedAtMs: opts.atMs ?? seqCounter * 1000,
  };
};

describe('workstream membership payload guards', () => {
  it('accepts a well-formed SET payload and rejects garbage', () => {
    expect(
      isWorkstreamMembershipSetPayload({
        payloadVersion: 1,
        subjectKind: 'canonical-url',
        subjectId: 'https://a.test/x',
        workstreamId: 'ws-1',
        role: 'primary',
        provenance: 'user-filed',
      }),
    ).toBe(true);
    expect(isWorkstreamMembershipSetPayload({ subjectKind: 'canonical-url' })).toBe(false);
    expect(
      isWorkstreamMembershipSetPayload({
        payloadVersion: 1,
        subjectKind: 'not-a-kind',
        subjectId: 'x',
        workstreamId: 'ws-1',
        role: 'primary',
        provenance: 'user-filed',
      }),
    ).toBe(false);
  });

  it('accepts a well-formed REMOVED payload and rejects garbage', () => {
    expect(
      isWorkstreamMembershipRemovedPayload({
        payloadVersion: 1,
        subjectKind: 'thread',
        subjectId: 'bac_1',
        workstreamId: 'ws-1',
        reason: 'user-declined',
      }),
    ).toBe(true);
    expect(isWorkstreamMembershipRemovedPayload({})).toBe(false);
  });
});

describe('foldWorkstreamMembership — set/remove/latest-wins', () => {
  it('a bare SET produces one active secondary row', () => {
    const rows = foldWorkstreamMembership('canonical-url', 'https://a.test/x', [
      setEvent({ workstreamId: 'ws-1', role: 'secondary' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workstreamId: 'ws-1', role: 'secondary', deleted: false });
  });

  it('a later REMOVED wins over an earlier SET for the same pair', () => {
    const rows = foldWorkstreamMembership('canonical-url', 'https://a.test/x', [
      setEvent({ workstreamId: 'ws-1' }, { atMs: 1_000 }),
      removedEvent({ workstreamId: 'ws-1' }, { atMs: 2_000 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deleted).toBe(true);
    expect(activeMembershipRows(rows)).toHaveLength(0);
  });

  it('a later SET revives a previously removed pair (deps-free latest-wins)', () => {
    const rows = foldWorkstreamMembership('canonical-url', 'https://a.test/x', [
      setEvent({ workstreamId: 'ws-1' }, { atMs: 1_000 }),
      removedEvent({ workstreamId: 'ws-1' }, { atMs: 2_000 }),
      setEvent({ workstreamId: 'ws-1', role: 'secondary' }, { atMs: 3_000 }),
    ]);
    expect(activeMembershipRows(rows)).toHaveLength(1);
    expect(rows.find((r) => r.workstreamId === 'ws-1')?.deleted).toBe(false);
  });

  it('ties break on (acceptedAtMs, replicaId, seq) — order-independent', () => {
    const events = [
      setEvent({ workstreamId: 'ws-1', role: 'secondary' }, { atMs: 5_000, replicaId: 'rA', seq: 1 }),
      setEvent({ workstreamId: 'ws-1', role: 'secondary', provenance: 'ai-suggested-accepted' }, { atMs: 5_000, replicaId: 'rB', seq: 1 }),
    ];
    const forward = foldWorkstreamMembership('canonical-url', 'https://a.test/x', events);
    const reversed = foldWorkstreamMembership('canonical-url', 'https://a.test/x', [...events].reverse());
    expect(forward).toEqual(reversed);
    // rB > rA lexicographically, so rB's event should win.
    expect(forward[0]?.provenance).toBe('ai-suggested-accepted');
  });

  it('multiple workstreams per subject all surface as independent rows', () => {
    const rows = foldWorkstreamMembership('canonical-url', 'https://a.test/x', [
      setEvent({ workstreamId: 'ws-1', role: 'primary' }, { atMs: 1_000 }),
      setEvent({ workstreamId: 'ws-2', role: 'secondary' }, { atMs: 2_000 }),
      setEvent({ workstreamId: 'ws-3', role: 'secondary' }, { atMs: 3_000 }),
    ]);
    expect(activeMembershipRows(rows).map((r) => r.workstreamId)).toEqual(['ws-1', 'ws-2', 'ws-3']);
    expect(primaryMembershipRow(rows)?.workstreamId).toBe('ws-1');
  });

  it('unrelated subjects/workstream events are ignored', () => {
    const rows = foldWorkstreamMembership('canonical-url', 'https://a.test/x', [
      setEvent(
        { workstreamId: 'ws-1', subjectId: 'https://other.test/y' },
        { atMs: 1_000 },
      ),
    ]);
    expect(rows).toHaveLength(0);
  });
});

describe('foldWorkstreamMembership — primary-demotion invariant', () => {
  it('setting a new primary demotes the prior primary to secondary', () => {
    const rows = foldWorkstreamMembership('canonical-url', 'https://a.test/x', [
      setEvent({ workstreamId: 'ws-1', role: 'primary' }, { atMs: 1_000 }),
      setEvent({ workstreamId: 'ws-2', role: 'primary' }, { atMs: 2_000 }),
    ]);
    expect(primaryMembershipRow(rows)?.workstreamId).toBe('ws-2');
    expect(rows.find((r) => r.workstreamId === 'ws-1')?.role).toBe('secondary');
    expect(rows.find((r) => r.workstreamId === 'ws-1')?.deleted).toBe(false);
  });

  it('is order-independent: an out-of-order OLDER primary SET for a new pair never wins', () => {
    const forwardEvents = [
      setEvent({ workstreamId: 'ws-1', role: 'primary' }, { atMs: 1_000 }),
      setEvent({ workstreamId: 'ws-2', role: 'primary' }, { atMs: 2_000 }),
    ];
    const forward = foldWorkstreamMembership('canonical-url', 'https://a.test/x', forwardEvents);
    const outOfOrder = foldWorkstreamMembership(
      'canonical-url',
      'https://a.test/x',
      [...forwardEvents].reverse(),
    );
    expect(forward).toEqual(outOfOrder);
    expect(primaryMembershipRow(outOfOrder)?.workstreamId).toBe('ws-2');
  });

  it('at most one primary survives across three concurrent claims', () => {
    const rows = foldWorkstreamMembership('canonical-url', 'https://a.test/x', [
      setEvent({ workstreamId: 'ws-1', role: 'primary' }, { atMs: 1_000, replicaId: 'r1' }),
      setEvent({ workstreamId: 'ws-2', role: 'primary' }, { atMs: 1_000, replicaId: 'r2' }),
      setEvent({ workstreamId: 'ws-3', role: 'primary' }, { atMs: 1_000, replicaId: 'r0' }),
    ]);
    const primaries = activeMembershipRows(rows).filter((r) => r.role === 'primary');
    expect(primaries).toHaveLength(1);
    // r2 > r1 > r0 lexicographically, so ws-2 (replicaId r2) wins the tie.
    expect(primaries[0]?.workstreamId).toBe('ws-2');
  });

  it('removing the primary leaves zero primaries, not a silent promotion', () => {
    const rows = foldWorkstreamMembership('canonical-url', 'https://a.test/x', [
      setEvent({ workstreamId: 'ws-1', role: 'primary' }, { atMs: 1_000 }),
      setEvent({ workstreamId: 'ws-2', role: 'secondary' }, { atMs: 2_000 }),
      removedEvent({ workstreamId: 'ws-1' }, { atMs: 3_000 }),
    ]);
    expect(primaryMembershipRow(rows)).toBeUndefined();
    expect(activeMembershipRows(rows).map((r) => r.workstreamId)).toEqual(['ws-2']);
  });
});

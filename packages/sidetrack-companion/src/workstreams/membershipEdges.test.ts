import { describe, expect, it } from 'bun:test';

import { visitInWorkstreamEdgesFromMembership } from './membershipEdges.js';
import type { WorkstreamMembershipRow } from './membershipEvents.js';

const row = (over: Partial<WorkstreamMembershipRow>): WorkstreamMembershipRow => ({
  subjectKind: 'canonical-url',
  subjectId: 'https://a.test/x',
  workstreamId: 'ws-1',
  role: 'primary',
  provenance: 'user-filed',
  deleted: false,
  acceptedAtMs: 1_000,
  dot: { replicaId: 'r1', seq: 1 },
  ...over,
});

describe('visitInWorkstreamEdgesFromMembership', () => {
  it('mints one edge per active row, none for deleted rows', () => {
    const edges = visitInWorkstreamEdgesFromMembership([
      row({ workstreamId: 'ws-1', role: 'primary' }),
      row({ workstreamId: 'ws-2', role: 'secondary' }),
      row({ workstreamId: 'ws-3', deleted: true }),
    ]);
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.kind === 'visit_in_workstream')).toBe(true);
  });

  it('user-filed rows are asserted; ai/prototype rows are inferred', () => {
    const [userFiled, aiSuggested] = visitInWorkstreamEdgesFromMembership([
      row({ workstreamId: 'ws-1', provenance: 'user-filed' }),
      row({ workstreamId: 'ws-2', provenance: 'ai-suggested-accepted' }),
    ]);
    expect(userFiled?.confidence).toBe('asserted');
    expect(aiSuggested?.confidence).toBe('inferred');
  });

  it('maps subjectKind to the right node id prefix', () => {
    const [urlEdge] = visitInWorkstreamEdgesFromMembership([
      row({ subjectKind: 'canonical-url', subjectId: 'https://a.test/x' }),
    ]);
    expect(urlEdge?.fromNodeId).toBe('timeline-visit:https://a.test/x');

    const [threadEdge] = visitInWorkstreamEdgesFromMembership([
      row({ subjectKind: 'thread', subjectId: 'bac_1' }),
    ]);
    expect(threadEdge?.fromNodeId).toBe('thread:bac_1');

    const [tabEdge] = visitInWorkstreamEdgesFromMembership([
      row({ subjectKind: 'tab-session', subjectId: 'tses_1' }),
    ]);
    expect(tabEdge?.fromNodeId).toBe('tab-session:tses_1');
  });

  it('produces deterministic, dedupe-safe edge ids', () => {
    const rows = [row({ workstreamId: 'ws-1' })];
    const first = visitInWorkstreamEdgesFromMembership(rows);
    const second = visitInWorkstreamEdgesFromMembership(rows);
    expect(first[0]?.id).toBe(second[0]?.id);
  });
});

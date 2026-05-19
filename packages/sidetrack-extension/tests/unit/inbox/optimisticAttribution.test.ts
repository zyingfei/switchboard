import { describe, expect, it } from 'vitest';

import {
  clearOptimisticDecision,
  hasOptimisticDecision,
  isReconciled,
  setOptimisticDecision,
  withOptimisticAttribution,
  type AttributableRecord,
  type OptimisticDecision,
} from '../../../src/sidepanel/inbox/optimisticAttribution';

const rec = (r: AttributableRecord = {}): AttributableRecord => r;

const NOW = '2026-05-18T10:00:00.000Z';
const ws: OptimisticDecision = { kind: 'workstream', workstreamId: 'WS_AI' };

describe('optimisticAttribution store', () => {
  it('set / clear / has', () => {
    let m = setOptimisticDecision({}, 'u', ws);
    expect(hasOptimisticDecision(m, 'u')).toBe(true);
    expect(hasOptimisticDecision(m, undefined)).toBe(false);
    m = clearOptimisticDecision(m, 'u');
    expect(hasOptimisticDecision(m, 'u')).toBe(false);
    expect(clearOptimisticDecision(m, 'missing')).toBe(m); // stable
  });

  it('withOptimisticAttribution returns the SAME object when no decision', () => {
    const r = rec({ currentAttribution: { workstreamId: 'X' } });
    expect(withOptimisticAttribution(r, undefined, NOW)).toBe(r);
  });

  it('a workstream pick wins over the projection immediately', () => {
    const r = rec(); // no attribution yet (still in inbox)
    const out = withOptimisticAttribution(r, ws, NOW);
    expect(out.currentAttribution).toEqual({
      workstreamId: 'WS_AI',
      source: 'user_asserted',
      observedAt: NOW,
      clientEventId: 'optimistic',
    });
  });

  it('"not in any stream" → workstreamId null', () => {
    const out = withOptimisticAttribution(rec(), { kind: 'none' }, NOW);
    expect(out.currentAttribution).toMatchObject({ workstreamId: null, source: 'user_asserted' });
  });

  it('ignore sets currentIgnored', () => {
    const out = withOptimisticAttribution(rec(), { kind: 'ignored', reason: 'noise' }, NOW);
    expect(out.currentIgnored).toEqual({
      reason: 'noise',
      observedAt: NOW,
      clientEventId: 'optimistic',
    });
  });

  it('a workstream pick supersedes a prior ignore (no stale ignore left)', () => {
    const r = rec({ currentIgnored: { reason: 'noise' } });
    const out = withOptimisticAttribution(r, ws, NOW);
    expect(out.currentIgnored).toBeUndefined();
    expect(out.currentAttribution).toMatchObject({ workstreamId: 'WS_AI' });
  });

  it('isReconciled: true once the server record reflects the same decision', () => {
    expect(isReconciled(undefined, ws)).toBe(false);
    expect(isReconciled(rec(), ws)).toBe(false);
    expect(isReconciled({ currentAttribution: { workstreamId: 'OTHER' } }, ws)).toBe(false);
    expect(isReconciled({ currentAttribution: { workstreamId: 'WS_AI' } }, ws)).toBe(true);
    expect(
      isReconciled({ currentAttribution: { workstreamId: null } }, { kind: 'none' }),
    ).toBe(true);
    expect(
      isReconciled({ currentIgnored: { reason: 'noise' } }, { kind: 'ignored', reason: 'noise' }),
    ).toBe(true);
  });
});

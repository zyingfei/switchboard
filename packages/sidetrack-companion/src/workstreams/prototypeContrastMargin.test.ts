import { describe, expect, it } from 'bun:test';

import {
  applyContrastMargin,
  CONTRAST_MARGIN_MIN,
  contrastMarginEmptyReason,
} from './prototypeContrastMargin.js';

describe('applyContrastMargin — near-tie honest-empty vs. clear-winner', () => {
  it('day-one bug, reproduced: a three-way tie at ~0.82 is an honest empty, not three confident candidates', () => {
    const result = applyContrastMargin([
      { workstreamId: 'ws-a', score: 0.82 },
      { workstreamId: 'ws-b', score: 0.81 },
      { workstreamId: 'ws-c', score: 0.8 },
    ]);
    expect(result.kept).toEqual([]);
    expect(result.margin).toBeLessThan(CONTRAST_MARGIN_MIN);
    // Raw values stay available for a transparent why-string even though no
    // candidate is surfaced.
    expect(result.topScore).toBeCloseTo(0.82, 5);
  });

  it('a clear winner clears the margin and is returned, sorted first', () => {
    const result = applyContrastMargin([
      { workstreamId: 'ws-a', score: 0.35 },
      { workstreamId: 'ws-b', score: 0.32 },
      { workstreamId: 'ws-winner', score: 0.9 },
    ]);
    expect(result.kept.length).toBe(3);
    expect(result.kept[0]!.workstreamId).toBe('ws-winner');
    expect(result.margin).toBeGreaterThanOrEqual(CONTRAST_MARGIN_MIN);
  });

  it('a solitary candidate always passes — nothing to contrast against', () => {
    const result = applyContrastMargin([{ workstreamId: 'ws-only', score: 0.4 }]);
    expect(result.kept).toEqual([{ workstreamId: 'ws-only', score: 0.4 }]);
    expect(result.margin).toBe(Infinity);
  });

  it('an empty candidate list returns an empty, zeroed result without throwing', () => {
    const result = applyContrastMargin([]);
    expect(result.kept).toEqual([]);
    expect(result.margin).toBe(0);
  });

  it('deterministic tie-break by workstreamId ascending when scores are equal', () => {
    const result = applyContrastMargin([
      { workstreamId: 'ws-z', score: 0.5 },
      { workstreamId: 'ws-a', score: 0.9 },
      { workstreamId: 'ws-m', score: 0.9 },
    ]);
    // ws-a and ws-m tie at the top; ws-a must sort first.
    expect(result.kept[0]!.workstreamId).toBe('ws-a');
  });

  it('a margin exactly at the threshold passes (>= not >)', () => {
    const result = applyContrastMargin([
      { workstreamId: 'ws-a', score: CONTRAST_MARGIN_MIN * 2 },
      { workstreamId: 'ws-b', score: 0 },
    ]);
    // mean = CONTRAST_MARGIN_MIN, top = 2*CONTRAST_MARGIN_MIN, margin = CONTRAST_MARGIN_MIN exactly.
    expect(result.margin).toBeCloseTo(CONTRAST_MARGIN_MIN, 10);
    expect(result.kept.length).toBe(2);
  });
});

describe('contrastMarginEmptyReason — transparency in the honest-empty case', () => {
  it('carries the raw top/mean/margin numbers in the string', () => {
    const result = applyContrastMargin([
      { workstreamId: 'ws-a', score: 0.82 },
      { workstreamId: 'ws-b', score: 0.81 },
    ]);
    const reason = contrastMarginEmptyReason(result);
    expect(reason).toContain('0.82');
    expect(reason).toContain('no clearly closer workstream');
  });
});

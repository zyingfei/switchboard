import { describe, expect, it } from 'vitest';

import {
  addDotsToIntervals,
  frontierFromIntervals,
  intervalsContainDot,
} from './materializerProgress.js';

const dot = (replicaId: string, seq: number) => ({ replicaId, seq });

describe('materializerProgress', () => {
  it('checks interval containment with gaps', () => {
    const intervals = addDotsToIntervals({}, [dot('A', 1), dot('A', 3), dot('A', 4)]);

    expect(intervalsContainDot(intervals, dot('A', 1))).toBe(true);
    expect(intervalsContainDot(intervals, dot('A', 2))).toBe(false);
    expect(intervalsContainDot(intervals, dot('A', 3))).toBe(true);
    expect(intervalsContainDot(intervals, dot('A', 4))).toBe(true);
    expect(intervalsContainDot(intervals, dot('A', 5))).toBe(false);
  });

  it('tracks per-replica intervals independently', () => {
    const intervals = addDotsToIntervals({}, [dot('A', 1), dot('A', 2), dot('B', 1), dot('A', 4)]);

    expect(intervals).toEqual({
      A: [
        [1, 2],
        [4, 4],
      ],
      B: [[1, 1]],
    });
    expect(intervalsContainDot(intervals, dot('A', 3))).toBe(false);
  });

  it('merges adjacent dots', () => {
    const intervals = addDotsToIntervals({}, [dot('A', 1), dot('A', 2), dot('A', 3)]);

    expect(intervals).toEqual({ A: [[1, 3]] });
  });

  it('derives contiguous frontier from intervals', () => {
    const intervals = addDotsToIntervals({}, [dot('A', 1), dot('A', 2), dot('B', 1), dot('A', 4)]);

    expect(frontierFromIntervals(intervals)).toEqual({ A: 2, B: 1 });
  });
});

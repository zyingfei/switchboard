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

  it('freezes the frontier just below a permanent gap until it is sealed', () => {
    // Models the dogfood permanent gap: [1,187920] applied, seq 187921 never
    // arrives, [187922,200000] applied. The frontier is stuck at 187920.
    const gappy: Record<string, ReadonlyArray<readonly [number, number]>> = {
      A: [
        [1, 187920],
        [187922, 200000],
      ],
    };
    expect(frontierFromIntervals(gappy)).toEqual({ A: 187920 });

    // Sealing = adding a tombstone Dot at the gap seq closes the hole, so
    // addDotsToIntervals merges all three intervals and the frontier advances.
    const sealed = addDotsToIntervals(gappy, [dot('A', 187921)]);
    expect(sealed).toEqual({ A: [[1, 200000]] });
    expect(frontierFromIntervals(sealed)).toEqual({ A: 200000 });
  });
});

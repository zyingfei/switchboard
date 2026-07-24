import { describe, expect, it } from 'vitest';

import {
  EMPTY_SIMILARITY_FLOOR_STATE,
  SIMILARITY_FLOOR_HEALTH_RECOVERY_CLEAN_DRAINS,
  SIMILARITY_FLOOR_SUSTAINED_COLLAPSE_DRAINS,
  foldSimilarityFloorDrain,
  parseSimilarityFloorState,
  purgeResetPending,
  similarityFloorHealthFlapping,
  similarityFloorLowCountBand,
  similarityFloorSustainedCollapseReached,
  type SimilarityFloorState,
} from './similarityFloorState.js';

const cleanDrain = {
  suppressed: false as const,
  builtEdgeCount: 51_000,
  nowMs: 1_000,
  purgeObservedThisDrain: false,
  resetConsumedThisDrain: false,
  sustainedCollapseAccepted: false,
  servedModelRevision: 'r1',
};

const suppressedDrain = {
  suppressed: true as const,
  builtEdgeCount: 0,
  nowMs: 2_000,
  purgeObservedThisDrain: false,
  resetConsumedThisDrain: false,
  sustainedCollapseAccepted: false,
  servedModelRevision: 'r1',
};

describe('parseSimilarityFloorState', () => {
  it('returns empty state for a non-record', () => {
    expect(parseSimilarityFloorState(null)).toEqual(EMPTY_SIMILARITY_FLOOR_STATE);
    expect(parseSimilarityFloorState('x')).toEqual(EMPTY_SIMILARITY_FLOOR_STATE);
    expect(parseSimilarityFloorState([1, 2])).toEqual(EMPTY_SIMILARITY_FLOOR_STATE);
  });

  it('coerces bad field types to safe defaults (boundary validation)', () => {
    const parsed = parseSimilarityFloorState({
      suppressedCollapseCount: -5,
      lastSuppressedAtMs: 'nope',
      consecutiveCleanDrains: 3.5,
      purgeResetArmedEpoch: NaN,
      servedModelRevision: '',
    });
    expect(parsed.suppressedCollapseCount).toBe(0);
    expect(parsed.lastSuppressedAtMs).toBeNull();
    expect(parsed.consecutiveCleanDrains).toBe(3.5);
    expect(parsed.purgeResetArmedEpoch).toBe(0);
    expect(parsed.servedModelRevision).toBeNull();
  });

  it('round-trips a full valid record', () => {
    const state: SimilarityFloorState = {
      schemaVersion: 1,
      suppressedCollapseCount: 7,
      lastSuppressedAtMs: 123,
      consecutiveCleanDrains: 2,
      lastSuppressedBuiltBand: 0,
      consecutiveSuppressionsInBand: 1,
      purgeResetArmedEpoch: 3,
      purgeResetConsumedEpoch: 2,
      servedModelRevision: 'r9',
      servedCorpusConfigSignature: 'legacy-skeleton|title-corpus',
    };
    expect(parseSimilarityFloorState(state)).toEqual(state);
  });
});

describe('similarityFloorLowCountBand', () => {
  it('buckets by log10 order of magnitude', () => {
    expect(similarityFloorLowCountBand(0)).toBe(0);
    expect(similarityFloorLowCountBand(1)).toBe(1);
    expect(similarityFloorLowCountBand(9)).toBe(1);
    expect(similarityFloorLowCountBand(10)).toBe(2);
    expect(similarityFloorLowCountBand(999)).toBe(3);
    expect(similarityFloorLowCountBand(51_000)).toBe(5);
  });
});

describe('foldSimilarityFloorDrain', () => {
  it('a clean drain advances consecutiveCleanDrains and clears the band run', () => {
    const s1 = foldSimilarityFloorDrain(EMPTY_SIMILARITY_FLOOR_STATE, suppressedDrain);
    expect(s1.suppressedCollapseCount).toBe(1);
    expect(s1.consecutiveSuppressionsInBand).toBe(1);
    const s2 = foldSimilarityFloorDrain(s1, cleanDrain);
    expect(s2.consecutiveCleanDrains).toBe(1);
    expect(s2.lastSuppressedBuiltBand).toBeNull();
    expect(s2.consecutiveSuppressionsInBand).toBe(0);
    // Lifetime count is monotonic — a clean drain does NOT decrement it.
    expect(s2.suppressedCollapseCount).toBe(1);
  });

  it('a flap (alternating suppress/clean) keeps the band run at 1', () => {
    let s = EMPTY_SIMILARITY_FLOOR_STATE;
    for (let i = 0; i < 10; i += 1) {
      s = foldSimilarityFloorDrain(s, { ...suppressedDrain, nowMs: i * 2 });
      expect(s.consecutiveSuppressionsInBand).toBe(1); // reset each clean drain below
      s = foldSimilarityFloorDrain(s, { ...cleanDrain, nowMs: i * 2 + 1 });
    }
    // 10 flaps → lifetime count 10, but never a sustained run.
    expect(s.suppressedCollapseCount).toBe(10);
  });

  it('a sustained low count accumulates the band run', () => {
    let s = EMPTY_SIMILARITY_FLOOR_STATE;
    for (let i = 0; i < 3; i += 1) {
      s = foldSimilarityFloorDrain(s, { ...suppressedDrain, nowMs: i });
    }
    expect(s.consecutiveSuppressionsInBand).toBe(3);
  });

  it('sustainedCollapseAccepted resets the run without counting a suppression', () => {
    let s = foldSimilarityFloorDrain(EMPTY_SIMILARITY_FLOOR_STATE, suppressedDrain);
    s = foldSimilarityFloorDrain(s, {
      ...suppressedDrain,
      suppressed: true,
      sustainedCollapseAccepted: true,
    });
    // Accepted → treated as a clean drain: run cleared, count NOT bumped.
    expect(s.consecutiveSuppressionsInBand).toBe(0);
    expect(s.suppressedCollapseCount).toBe(1);
    expect(s.consecutiveCleanDrains).toBe(1);
  });

  it('records servedModelRevision when provided, keeps prior when null', () => {
    const s1 = foldSimilarityFloorDrain(EMPTY_SIMILARITY_FLOOR_STATE, {
      ...cleanDrain,
      servedModelRevision: 'r-new',
    });
    expect(s1.servedModelRevision).toBe('r-new');
    const s2 = foldSimilarityFloorDrain(s1, { ...cleanDrain, servedModelRevision: null });
    expect(s2.servedModelRevision).toBe('r-new');
  });

  it('records servedCorpusConfigSignature on a fresh publish, keeps prior when null/absent', () => {
    // Findings B4/B5: the recorded signature is how the corpus-config reset
    // fires exactly ONCE. A genuine publish records the live signature; a
    // carry-forward / reuse (which serves the OLD-corpus revision) passes null
    // and MUST leave the recorded value unchanged.
    const s1 = foldSimilarityFloorDrain(EMPTY_SIMILARITY_FLOOR_STATE, {
      ...cleanDrain,
      servedCorpusConfigSignature: 'clean-title-only|title-corpus',
    });
    expect(s1.servedCorpusConfigSignature).toBe('clean-title-only|title-corpus');
    // null (carry-forward / reuse) leaves it unchanged.
    const s2 = foldSimilarityFloorDrain(s1, {
      ...cleanDrain,
      servedCorpusConfigSignature: null,
    });
    expect(s2.servedCorpusConfigSignature).toBe('clean-title-only|title-corpus');
    // absent (older call site) also leaves it unchanged.
    const s3 = foldSimilarityFloorDrain(s2, cleanDrain);
    expect(s3.servedCorpusConfigSignature).toBe('clean-title-only|title-corpus');
  });
});

describe('privacy-purge reset epoch', () => {
  it('arms on observation and stays pending until consumed', () => {
    let s = foldSimilarityFloorDrain(EMPTY_SIMILARITY_FLOOR_STATE, {
      ...cleanDrain,
      purgeObservedThisDrain: true,
    });
    expect(purgeResetPending(s)).toBe(true);
    // A later drain with no tombstone in-window still sees it pending.
    s = foldSimilarityFloorDrain(s, cleanDrain);
    expect(purgeResetPending(s)).toBe(true);
    // Consumed once a reset (full rebuild / allowed collapse) recomputes.
    s = foldSimilarityFloorDrain(s, { ...cleanDrain, resetConsumedThisDrain: true });
    expect(purgeResetPending(s)).toBe(false);
  });
});

describe('similarityFloorHealthFlapping', () => {
  it('is false before any suppression', () => {
    expect(similarityFloorHealthFlapping(EMPTY_SIMILARITY_FLOOR_STATE)).toBe(false);
  });

  it('is true right after a suppression and recovers after N clean drains', () => {
    let s = foldSimilarityFloorDrain(EMPTY_SIMILARITY_FLOOR_STATE, suppressedDrain);
    expect(similarityFloorHealthFlapping(s)).toBe(true);
    for (let i = 0; i < SIMILARITY_FLOOR_HEALTH_RECOVERY_CLEAN_DRAINS; i += 1) {
      expect(similarityFloorHealthFlapping(s)).toBe(true);
      s = foldSimilarityFloorDrain(s, cleanDrain);
    }
    // After the recovery run of clean drains the health surface returns ok.
    expect(similarityFloorHealthFlapping(s)).toBe(false);
    // The lifetime count is still visible as a metric.
    expect(s.suppressedCollapseCount).toBe(1);
  });
});

describe('similarityFloorSustainedCollapseReached', () => {
  it('trips only after N consecutive suppressions of the same band', () => {
    let s = EMPTY_SIMILARITY_FLOOR_STATE;
    for (let i = 0; i < SIMILARITY_FLOOR_SUSTAINED_COLLAPSE_DRAINS - 1; i += 1) {
      expect(similarityFloorSustainedCollapseReached(s, 0)).toBe(false);
      s = foldSimilarityFloorDrain(s, { ...suppressedDrain, nowMs: i });
    }
    // The Nth drain (inclusive) reaches the threshold.
    expect(similarityFloorSustainedCollapseReached(s, 0)).toBe(true);
  });

  it('does not trip when the built band differs from the run band', () => {
    let s = EMPTY_SIMILARITY_FLOOR_STATE;
    for (let i = 0; i < SIMILARITY_FLOOR_SUSTAINED_COLLAPSE_DRAINS; i += 1) {
      s = foldSimilarityFloorDrain(s, { ...suppressedDrain, builtEdgeCount: 0, nowMs: i });
    }
    // A different (higher) band this drain — this is a flap back up, not a
    // sustained collapse in the SAME band.
    expect(similarityFloorSustainedCollapseReached(s, 5_000)).toBe(false);
  });
});

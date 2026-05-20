import { describe, expect, it } from 'vitest';

import {
  confidenceLevelFromProbability,
  confidenceLevelLabel,
  isActionableLevel,
  probabilityFromLogit,
  TIED_MARGIN_THRESHOLD,
} from '../../../src/sidepanel/suggestion/confidence';

describe('probabilityFromLogit', () => {
  it('maps 0 → 0.5 and is monotone', () => {
    expect(probabilityFromLogit(0)).toBeCloseTo(0.5, 6);
    expect(probabilityFromLogit(1.355)).toBeCloseTo(0.7949, 3); // dogfood-observed
    expect(probabilityFromLogit(5)).toBeGreaterThan(0.99);
    expect(probabilityFromLogit(-5)).toBeLessThan(0.01);
  });
});

describe('confidenceLevelFromProbability', () => {
  it('buckets the curve at 0.2 / 0.4 / 0.6 / 0.8', () => {
    expect(confidenceLevelFromProbability(0.85)).toBe('highly-likely');
    expect(confidenceLevelFromProbability(0.7)).toBe('likely');
    expect(confidenceLevelFromProbability(0.5)).toBe('possible');
    expect(confidenceLevelFromProbability(0.3)).toBe('unlikely');
    expect(confidenceLevelFromProbability(0.05)).toBe('not-likely');
  });

  it('promotes to "no-clear-pick" when margin is below the tie threshold — even for a high probability', () => {
    // Dogfood-observed: top-1 0.7948 with margin 0.0016 ⇒ near-tied
    // with 8PYM6HCZND1KTGR0 (0.7946). The label MUST NOT be
    // "Highly likely"; the model has no real winner.
    expect(
      confidenceLevelFromProbability(0.7948, { margin: 0.0016 }),
    ).toBe('no-clear-pick');
    expect(confidenceLevelFromProbability(0.95, { margin: 0.01 })).toBe('no-clear-pick');
  });

  it('a meaningful margin keeps the underlying bucket', () => {
    expect(confidenceLevelFromProbability(0.85, { margin: 0.2 })).toBe('highly-likely');
    expect(
      confidenceLevelFromProbability(0.85, { margin: TIED_MARGIN_THRESHOLD }),
    ).toBe('highly-likely');
  });

  it('omitting margin is treated as not-tied (back-compat for surfaces that do not know the margin yet)', () => {
    expect(confidenceLevelFromProbability(0.85)).toBe('highly-likely');
  });
});

describe('confidenceLevelLabel', () => {
  it('every level has a human label', () => {
    const levels = [
      'highly-likely',
      'likely',
      'possible',
      'unlikely',
      'not-likely',
      'no-clear-pick',
    ] as const;
    for (const l of levels) expect(confidenceLevelLabel(l).length).toBeGreaterThan(0);
    expect(confidenceLevelLabel('no-clear-pick')).toBe('No clear pick');
    expect(confidenceLevelLabel('highly-likely')).toBe('Highly likely');
  });
});

describe('isActionableLevel', () => {
  it('only confident levels are actionable; ties and not-likely suppress "Accept"', () => {
    expect(isActionableLevel('highly-likely')).toBe(true);
    expect(isActionableLevel('likely')).toBe(true);
    expect(isActionableLevel('possible')).toBe(true);
    expect(isActionableLevel('unlikely')).toBe(true);
    expect(isActionableLevel('no-clear-pick')).toBe(false);
    expect(isActionableLevel('not-likely')).toBe(false);
  });
});

describe('unification contract — same number, same surface', () => {
  it('a thread-suggestion score (already 0–1) and an inbox logit + sigmoid produce the same level for the same point', () => {
    // The resolver behind both surfaces is one model. Demonstrate:
    // given the SAME confidence (whether arrived at via logit→sigmoid
    // or pre-sigmoided score), and the SAME margin, the level — and
    // therefore the label — is identical. This is the property that
    // made layer-1 unification possible; the only remaining axis
    // both surfaces must obey is the tie gate (layer 2).
    const logit = 1.355344746524402; // dogfood-observed rawFusionLogit
    const score = 0.7948783146011416; // dogfood-observed pre-sigmoid score for the same row
    const margin = 0.0016649028380166797;
    const fromInbox = confidenceLevelFromProbability(probabilityFromLogit(logit), { margin });
    const fromAllThreads = confidenceLevelFromProbability(score, { margin });
    expect(fromInbox).toBe(fromAllThreads);
    expect(fromInbox).toBe('no-clear-pick');
  });
});

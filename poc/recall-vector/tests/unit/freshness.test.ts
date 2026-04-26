import { describe, expect, it } from 'vitest';
import { classifyRecencyBucket, freshnessBoost } from '../../src/recall/freshness';

describe('freshness weighting', () => {
  it('prefers fresher hits for the short recency window', () => {
    expect(freshnessBoost('3d', 2)).toBeGreaterThan(freshnessBoost('3d', 45));
    expect(classifyRecencyBucket(2)).toBe('0-3d');
    expect(classifyRecencyBucket(45)).toBe('22-90d');
  });

  it('allows warm archive hits to compete in longer windows', () => {
    expect(freshnessBoost('3m', 45)).toBeGreaterThan(freshnessBoost('3m', 2));
    expect(freshnessBoost('3y', 400)).toBeGreaterThan(freshnessBoost('3y', 2));
  });
});

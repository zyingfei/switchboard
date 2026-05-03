import { describe, expect, it } from 'vitest';

import { cosine, meanNormalized } from './centroid.js';

describe('suggestion centroids', () => {
  it('returns null for empty vectors', () => {
    expect(meanNormalized([])).toBeNull();
  });

  it('means and normalizes vectors', () => {
    const vector = meanNormalized([Float32Array.from([1, 0]), Float32Array.from([1, 0])]);

    expect(vector?.[0]).toBe(1);
    expect(cosine(vector ?? new Float32Array(), Float32Array.from([1, 0]))).toBe(1);
  });
});

import { beforeEach, describe, expect, it } from 'bun:test';

import {
  getDrainDegradation,
  recordSimilarityFullRebuildFallback,
  resetDrainDegradation,
} from './drainDegradation.js';

// The counter exists because the degradation it tracks was INVISIBLE: the
// HNSW delta path throwing sent the drain into a full-corpus re-embed
// (measured live: ~100% CPU for 11+ minutes, resolve p95 17.5s against the
// extension's 15s timeout) while health reported nothing, because the only
// signal was a phase mark that is off by default.

describe('drain degradation counters', () => {
  beforeEach(() => {
    resetDrainDegradation();
  });

  it('starts at zero with no error (absent == zero, never "unknown")', () => {
    const snap = getDrainDegradation();
    expect(snap.similarityFullRebuildFallbacks).toBe(0);
    expect(snap.lastFallbackError).toBeUndefined();
    expect(snap.lastFallbackAtMs).toBeUndefined();
  });

  it('counts each fallback and keeps the most recent error + timestamp', () => {
    recordSimilarityFullRebuildFallback(new Error('usearch index corrupt'), 1_000);
    recordSimilarityFullRebuildFallback(new Error('dimension mismatch 384 vs 768'), 2_000);
    const snap = getDrainDegradation();
    expect(snap.similarityFullRebuildFallbacks).toBe(2);
    expect(snap.lastFallbackError).toBe('dimension mismatch 384 vs 768');
    expect(snap.lastFallbackAtMs).toBe(2_000);
  });

  it('accepts non-Error throws without losing the count', () => {
    recordSimilarityFullRebuildFallback('plain string failure', 5_000);
    const snap = getDrainDegradation();
    expect(snap.similarityFullRebuildFallbacks).toBe(1);
    expect(snap.lastFallbackError).toBe('plain string failure');
  });

  it('truncates a huge error so health payloads stay bounded', () => {
    recordSimilarityFullRebuildFallback(new Error('x'.repeat(5_000)), 9_000);
    const snap = getDrainDegradation();
    expect((snap.lastFallbackError ?? '').length).toBeLessThanOrEqual(240);
  });
});

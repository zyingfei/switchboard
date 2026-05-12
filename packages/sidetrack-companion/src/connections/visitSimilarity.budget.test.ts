// Stage 5.2 W3 — budget gate tests.

import { describe, expect, it } from 'vitest';

import {
  createEmbedderWarmthTracker,
  decideHotPathEmbed,
  DEFAULT_W3_MAX_CORPUS_SIZE,
} from './visitSimilarity.budget.js';

describe('Stage 5.2 W3 — decideHotPathEmbed', () => {
  it('rejects when corpus size exceeds default budget', () => {
    const decision = decideHotPathEmbed({
      corpusSize: DEFAULT_W3_MAX_CORPUS_SIZE + 1,
      embedderWarmUntilMs: Date.now() + 60_000,
    });
    expect(decision.shouldEmbedOnHotPath).toBe(false);
    expect(decision.reason).toBe('corpus-too-large');
  });

  it('rejects when embedder warmth is unknown (cold start)', () => {
    const decision = decideHotPathEmbed({ corpusSize: 100 });
    expect(decision.shouldEmbedOnHotPath).toBe(false);
    expect(decision.reason).toBe('embedder-warmth-unknown');
  });

  it('rejects when embedder warmth TTL has lapsed', () => {
    const decision = decideHotPathEmbed({
      corpusSize: 100,
      embedderWarmUntilMs: 1_000,
      nowMs: 2_000,
    });
    expect(decision.shouldEmbedOnHotPath).toBe(false);
    expect(decision.reason).toBe('embedder-cold');
  });

  it('rejects when recent p99 latency exceeds budget', () => {
    const decision = decideHotPathEmbed({
      corpusSize: 100,
      embedderWarmUntilMs: 1_000_000,
      nowMs: 1_000,
      recentEmbedP99Ms: 200,
      maxRecentEmbedP99Ms: 50,
    });
    expect(decision.shouldEmbedOnHotPath).toBe(false);
    expect(decision.reason).toBe('embedder-slow');
  });

  it('accepts when corpus is small, embedder warm, and p99 within budget', () => {
    const decision = decideHotPathEmbed({
      corpusSize: 100,
      embedderWarmUntilMs: 1_000_000,
      nowMs: 1_000,
      recentEmbedP99Ms: 20,
    });
    expect(decision.shouldEmbedOnHotPath).toBe(true);
    expect(decision.reason).toBeUndefined();
  });
});

describe('Stage 5.2 W3 — EmbedderWarmthTracker', () => {
  it('warmth is unknown until the first recordEmbed', () => {
    const tracker = createEmbedderWarmthTracker({ nowMs: () => 0 });
    const budget = tracker.snapshot(0);
    expect(budget.embedderWarmUntilMs).toBeUndefined();
    expect(decideHotPathEmbed(budget).shouldEmbedOnHotPath).toBe(false);
  });

  it('recordEmbed marks the embedder warm for warmTtlMs', () => {
    let now = 1_000;
    const tracker = createEmbedderWarmthTracker({
      warmTtlMs: 5_000,
      nowMs: () => now,
    });
    tracker.recordEmbed(20);
    const budget = tracker.snapshot(0);
    expect(budget.embedderWarmUntilMs).toBe(6_000);
    expect(decideHotPathEmbed(budget).shouldEmbedOnHotPath).toBe(true);
    // Advance past TTL.
    now = 7_000;
    expect(decideHotPathEmbed(tracker.snapshot(0)).reason).toBe('embedder-cold');
  });

  it('recentEmbedP99Ms reflects the rolling window', () => {
    const tracker = createEmbedderWarmthTracker({ nowMs: () => 1_000, p99Window: 4 });
    for (const ms of [10, 20, 15, 100]) tracker.recordEmbed(ms);
    const budget = tracker.snapshot(0);
    // p99 of [10, 15, 20, 100] sorted: idx = floor(4 * 0.99) = 3 → 100
    expect(budget.recentEmbedP99Ms).toBe(100);
  });
});

import { describe, expect, it } from 'vitest';

import {
  cleanThreadTitle,
  DEFAULT_SELF_NOMINATION_MIN_VISITS,
  evaluateThreadSelfNomination,
  type ThreadSelfNominationSignals,
} from './selfNomination.js';

const recurring = (
  overrides: Partial<ThreadSelfNominationSignals> = {},
): ThreadSelfNominationSignals => ({
  title: 'Phantom与Shadow v2架构',
  provider: 'chatgpt',
  visitCount: 3,
  distinctDays: 2,
  hasWorkstream: false,
  hasSuggestionAboveThreshold: false,
  isIgnored: false,
  ...overrides,
});

describe('cleanThreadTitle', () => {
  it('strips a trailing provider tag', () => {
    expect(cleanThreadTitle('Phantom与Shadow v2架构 - ChatGPT')).toBe('Phantom与Shadow v2架构');
    expect(cleanThreadTitle('Retrieval eval plan | Claude')).toBe('Retrieval eval plan');
    expect(cleanThreadTitle('Roadmap · Gemini')).toBe('Roadmap');
  });

  it('strips a leading provider tag', () => {
    expect(cleanThreadTitle('ChatGPT - Phantom v2')).toBe('Phantom v2');
    expect(cleanThreadTitle('Claude | design review')).toBe('design review');
  });

  it('leaves a provider name mid-sentence untouched (no separator segment)', () => {
    expect(cleanThreadTitle('How ChatGPT ranks results')).toBe('How ChatGPT ranks results');
  });

  it('never collapses a provider-only title to empty (falls back to original)', () => {
    // A bare provider name has no separator segment to strip, so it
    // survives untouched rather than becoming empty.
    expect(cleanThreadTitle('ChatGPT')).toBe('ChatGPT');
    // "ChatGPT -" IS a strippable trailing segment; stripping it would
    // leave nothing, so the cleaner falls back to the original.
    expect(cleanThreadTitle('ChatGPT -')).toBe('ChatGPT -');
  });

  it('trims stray separators and whitespace', () => {
    expect(cleanThreadTitle('  Deep dive:  ')).toBe('Deep dive');
  });
});

describe('evaluateThreadSelfNomination', () => {
  it('nominates a recurring, home-less, un-suggested thread', () => {
    const result = evaluateThreadSelfNomination(recurring());
    expect(result.eligible).toBe(true);
    expect(result.visitCount).toBe(3);
    expect(result.distinctDays).toBe(2);
    expect(result.suggestedTitle).toBe('Phantom与Shadow v2架构');
    expect(result.reason).toBeUndefined();
  });

  it('abstains when the thread already has a workstream', () => {
    const result = evaluateThreadSelfNomination(recurring({ hasWorkstream: true }));
    expect(result).toMatchObject({ eligible: false, reason: 'already-filed' });
  });

  it('abstains for an ignored thread even when recurring', () => {
    const result = evaluateThreadSelfNomination(recurring({ isIgnored: true }));
    expect(result).toMatchObject({ eligible: false, reason: 'ignored' });
  });

  it('abstains when a real suggestion already exists', () => {
    const result = evaluateThreadSelfNomination(recurring({ hasSuggestionAboveThreshold: true }));
    expect(result).toMatchObject({ eligible: false, reason: 'has-suggestion' });
  });

  it('abstains below the visit-count floor', () => {
    const result = evaluateThreadSelfNomination(recurring({ visitCount: 1, distinctDays: 1 }));
    expect(result).toMatchObject({ eligible: false, reason: 'below-visit-threshold' });
  });

  it('abstains when all visits fall in one day', () => {
    const result = evaluateThreadSelfNomination(recurring({ visitCount: 5, distinctDays: 1 }));
    expect(result).toMatchObject({ eligible: false, reason: 'below-day-threshold' });
  });

  it('honors an env-tuned minimum visit override', () => {
    // Same signals, but a higher floor makes a 3-visit thread ineligible.
    const result = evaluateThreadSelfNomination(recurring({ minVisits: 5 }));
    expect(result).toMatchObject({ eligible: false, reason: 'below-visit-threshold' });
  });

  it('defaults the visit floor to DEFAULT_SELF_NOMINATION_MIN_VISITS', () => {
    const atFloor = evaluateThreadSelfNomination(
      recurring({ visitCount: DEFAULT_SELF_NOMINATION_MIN_VISITS }),
    );
    expect(atFloor.eligible).toBe(true);
    const belowFloor = evaluateThreadSelfNomination(
      recurring({ visitCount: DEFAULT_SELF_NOMINATION_MIN_VISITS - 1, distinctDays: 2 }),
    );
    expect(belowFloor.eligible).toBe(false);
  });
});

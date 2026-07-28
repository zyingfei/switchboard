import { describe, expect, it } from 'vitest';

import {
  groundednessScore,
  validateGeneration,
} from '../../src/sidepanel/nano/validateGeneration';

// REPORTED LIVE, 2026-07-28. An arXiv paper page — "[2510.26692] Kimi Linear:
// An Expressive, Efficient Attention Architecture" — was gisted from METADATA
// ONLY ("gist from page features (no full text indexed)") and produced:
//
//   "Subject matter: Hacker News. Hacker News is a platform where users
//    discuss and share news, articles, and links related to technology ...
//    The site is hosted on the arXiv.org website"
//
// That is not a summary of anything. It was SAVED and fed to retrieval. Every
// existing rule passed it: fluent, non-repetitive, single-language, correct
// shape, no prompt echo. They all check the output's FORM.
//
// The same page, once its text was actually indexed, produced an accurate
// paragraph about Kimi Delta Attention, KV-cache reduction and decode
// throughput. So the pipeline is fine — what was missing is a rule asking
// whether the gist is MADE OF the source at all.

const KIMI_SOURCE = [
  'Kimi Linear: An Expressive, Efficient Attention Architecture.',
  'Kimi Linear is a hybrid linear attention architecture that outperforms full',
  'attention across short-context, long-context and reinforcement learning',
  'scaling regimes. It introduces Kimi Delta Attention, an expressive linear',
  'attention module, with a bespoke chunkwise algorithm for hardware efficiency.',
  'The model is pretrained with 3B activated parameters and 48B total parameters,',
  'reducing KV cache usage by up to 75% and achieving up to 6 times decoding',
  'throughput for a 1M context.',
].join(' ');

const GOOD_GIST =
  'Kimi Linear is a hybrid linear attention architecture that outperforms full attention ' +
  'across short-context and long-context regimes, using Kimi Delta Attention to reduce KV ' +
  'cache usage and raise decoding throughput.';

const INVENTED_GIST =
  'Hacker News is a platform where users discuss and share news, articles, and links ' +
  'related to technology, programming, and other tech-related topics. The site features ' +
  'a variety of content, including news posts, blog entries, and discussion threads.';

describe('groundedness — is the gist made of the source, or invented?', () => {
  it('scores a faithful summary far above an invented one', () => {
    const good = groundednessScore(GOOD_GIST, KIMI_SOURCE);
    const bad = groundednessScore(INVENTED_GIST, KIMI_SOURCE);
    expect(good).not.toBeNull();
    expect(bad).not.toBeNull();
    expect(good ?? 0).toBeGreaterThan(0.5);
    expect(bad ?? 1).toBeLessThan(0.2);
    // The populations must not merely differ — they must be far apart, or the
    // threshold is riding on noise.
    expect((good ?? 0) - (bad ?? 0)).toBeGreaterThan(0.4);
  });

  it('REJECTS the invented gist that actually shipped', () => {
    const verdict = validateGeneration(INVENTED_GIST, {
      kind: 'gist',
      language: 'en',
      source: KIMI_SOURCE,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? null : verdict.reason).toBe('ungrounded');
  });

  it('ACCEPTS the faithful gist from the same page', () => {
    const verdict = validateGeneration(GOOD_GIST, {
      kind: 'gist',
      language: 'en',
      source: KIMI_SOURCE,
    });
    expect(verdict.ok).toBe(true);
  });

  it('abstains rather than rejecting when there is too little to judge', () => {
    // A rule that fires on thin evidence would reject legitimate short output.
    expect(groundednessScore('Short one.', KIMI_SOURCE)).toBeNull();
    expect(groundednessScore(GOOD_GIST, '')).toBeNull();
  });

  it('is skipped entirely when the caller passes no source', () => {
    // Optional by design: a missing source must mean "cannot check", never
    // "assume the worst".
    const verdict = validateGeneration(INVENTED_GIST, { kind: 'gist', language: 'en' });
    expect(verdict.ok).toBe(true);
  });

  it('does not punish a summary for compressing — reuse is what grounding IS', () => {
    // Guard against the opposite failure: a terse, heavily-abstracted summary
    // that still uses the source's own terms must survive.
    const terse = 'Kimi Delta Attention reduces KV cache usage and raises decoding throughput.';
    const verdict = validateGeneration(terse, {
      kind: 'gist',
      language: 'en',
      source: KIMI_SOURCE,
    });
    expect(verdict.ok).toBe(true);
  });
});

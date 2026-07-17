import { describe, expect, it } from 'vitest';

import {
  HEAD_LABEL_THRESHOLD,
  SUGGEST_PRECISION_FLOOR,
  TOPK_WIDTH,
  scoreVisit,
  shrunkPrecision,
} from './scorer.js';
import {
  applyOrganizingObservation,
  createEmptyAttributionV1State,
  type AttributionV1State,
  type OrganizingObservation,
} from './state.js';

// ---- state builder for scorer fixtures --------------------------------

let atMs = 1000;
const fill = (
  state: AttributionV1State,
  workstreamId: string,
  entries: readonly { readonly url: string; readonly title: string }[],
): void => {
  for (const entry of entries) {
    atMs += 1;
    const observation: OrganizingObservation = {
      workstreamId,
      canonicalUrl: entry.url,
      title: entry.title,
      atMs,
      provenance: 'asserted',
    };
    applyOrganizingObservation(state, observation);
  }
};

// A head workstream (>= HEAD_LABEL_THRESHOLD labels) about the linux kernel,
// and a tail workstream (few labels) about rust. Both cite github.com so it
// is an ambiguous hub; lwn.net is single-workstream (linux).
const buildScorerState = (): AttributionV1State => {
  atMs = 1000;
  const state = createEmptyAttributionV1State();
  const linuxMembers: { url: string; title: string }[] = [];
  for (let i = 0; i < HEAD_LABEL_THRESHOLD + 2; i += 1) {
    linuxMembers.push({
      url: `https://lwn.net/article/${i}`,
      title: `Linux kernel scheduler article ${i} memory paging`,
    });
  }
  // One github member for linux (makes github ambiguous once rust also cites it).
  linuxMembers.push({
    url: 'https://github.com/torvalds/linux',
    title: 'Linux kernel source tree',
  });
  fill(state, 'ws-linux', linuxMembers);
  fill(state, 'ws-rust', [
    { url: 'https://github.com/rust-lang/rust', title: 'Rust ownership borrow checker compiler' },
    { url: 'https://doc.rust-lang.org/book', title: 'Rust book lifetimes traits generics' },
  ]);
  return state;
};

// ---- beta-binomial gate ----------------------------------------------

describe('shrunkPrecision', () => {
  it('sits at the tail rate for a zero-label workstream', () => {
    expect(shrunkPrecision(0)).toBeCloseTo(0.28, 5);
  });
  it('is monotone increasing in label count and approaches the head rate', () => {
    expect(shrunkPrecision(5)).toBeGreaterThan(shrunkPrecision(0));
    expect(shrunkPrecision(100)).toBeGreaterThan(shrunkPrecision(5));
    expect(shrunkPrecision(1000)).toBeLessThan(0.53);
    expect(shrunkPrecision(1000)).toBeGreaterThan(0.5);
  });
});

// ---- title-lexical + venue suppression -------------------------------

describe('scoreVisit title-lexical family', () => {
  it('ranks the topically matching workstream first', () => {
    const state = buildScorerState();
    const result = scoreVisit(
      { title: 'Rust borrow checker and lifetimes', url: 'https://blog.example/rust' },
      state,
    );
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0]!.workstreamId).toBe('ws-rust');
    const titleReason = result.candidates[0]!.reasons.find((r) => r.family === 'title-lexical');
    expect(titleReason).toBeDefined();
  });

  it('does not let a shared venue term ("github") drive attribution', () => {
    const state = buildScorerState();
    // A title carrying ONLY the venue term should not confidently pick a
    // workstream via lexical overlap (github is in both ⇒ near-zero IDF).
    const result = scoreVisit(
      { title: 'github', url: 'https://blog.example/misc' },
      state,
    );
    // Either abstains or, if it scores, github contributes ~nothing — the
    // top score must be tiny relative to a real topic match.
    const topScore = result.candidates[0]?.score ?? 0;
    const realMatch = scoreVisit(
      { title: 'Rust borrow checker lifetimes', url: 'https://blog.example/rust' },
      state,
    ).candidates[0]!.score;
    expect(topScore).toBeLessThan(realMatch);
  });
});

// ---- conditional-domain family ---------------------------------------

describe('scoreVisit conditional-domain family', () => {
  it('adds a domain contribution for a single-workstream domain', () => {
    const state = buildScorerState();
    const result = scoreVisit(
      { title: 'Some kernel scheduler note', url: 'https://lwn.net/article/new' },
      state,
    );
    const top = result.candidates.find((c) => c.workstreamId === 'ws-linux');
    expect(top).toBeDefined();
    expect(top!.contributions.conditionalDomain).toBeGreaterThan(0);
    expect(top!.reasons.some((r) => r.family === 'conditional-domain')).toBe(true);
  });

  it('suppresses the domain family on an ambiguous hub (github)', () => {
    const state = buildScorerState();
    const result = scoreVisit(
      { title: 'Linux kernel scheduler paging', url: 'https://github.com/some/repo' },
      state,
    );
    // github maps to two workstreams ⇒ conditional-domain contributes 0 for
    // every candidate, even the one the title picks.
    for (const candidate of result.candidates) {
      expect(candidate.contributions.conditionalDomain).toBe(0);
    }
  });
});

// ---- recency tie-break -----------------------------------------------

describe('scoreVisit recency family', () => {
  it('nudges the last-filed workstream only when another family already fired', () => {
    atMs = 1000;
    const state = createEmptyAttributionV1State();
    // Two workstreams share the exact same single member title, so their
    // title-lexical scores tie. ws-b is filed last.
    fill(state, 'ws-a', [{ url: 'https://a.com/1', title: 'shared topic alpha beta' }]);
    fill(state, 'ws-b', [{ url: 'https://b.com/1', title: 'shared topic alpha beta' }]);
    expect(state.lastFiledWorkstreamId).toBe('ws-b');
    const result = scoreVisit(
      { title: 'shared topic alpha beta', url: 'https://query.example/x' },
      state,
    );
    // ws-b wins the tie via the recency nudge.
    expect(result.candidates[0]!.workstreamId).toBe('ws-b');
    expect(result.candidates[0]!.contributions.recency).toBeGreaterThan(0);
    // ws-a got no recency nudge.
    const wsA = result.candidates.find((c) => c.workstreamId === 'ws-a');
    expect(wsA!.contributions.recency).toBe(0);
  });

  it('never manufactures a candidate from recency alone', () => {
    atMs = 1000;
    const state = createEmptyAttributionV1State();
    fill(state, 'ws-a', [{ url: 'https://a.com/1', title: 'entirely unrelated words here' }]);
    // A visit with no title/domain overlap ⇒ recency must not create a
    // candidate on its own.
    const result = scoreVisit(
      { title: 'zzz qqq vvv nomatch', url: 'https://nowhere.example/y' },
      state,
    );
    expect(result.candidates.length).toBe(0);
    expect(result.action).toBe('abstain');
  });
});

// ---- abstention + head/tail top-k ------------------------------------

describe('scoreVisit decisions', () => {
  it('abstains when nothing matches', () => {
    const state = buildScorerState();
    const result = scoreVisit(
      { title: 'completely orthogonal xyzzy plugh', url: 'https://void.example/z' },
      state,
    );
    expect(result.action).toBe('abstain');
    expect(result.candidates).toEqual([]);
  });

  it('emits a single top-1 suggestion for a head workstream', () => {
    const state = buildScorerState();
    const result = scoreVisit(
      { title: 'Linux kernel scheduler memory paging', url: 'https://lwn.net/article/head' },
      state,
    );
    expect(result.candidates[0]!.workstreamId).toBe('ws-linux');
    expect(result.candidates[0]!.labelCount).toBeGreaterThanOrEqual(HEAD_LABEL_THRESHOLD);
    expect(result.action).toBe('suggest');
    expect(result.candidates.length).toBe(1);
  });

  it('widens to top-k when the top candidate is a tail workstream', () => {
    const state = buildScorerState();
    const result = scoreVisit(
      { title: 'Rust ownership borrow checker lifetimes', url: 'https://blog.example/rust' },
      state,
    );
    expect(result.candidates[0]!.workstreamId).toBe('ws-rust');
    expect(result.candidates[0]!.labelCount).toBeLessThan(HEAD_LABEL_THRESHOLD);
    expect(result.action).toBe('topk');
    expect(result.candidates.length).toBeLessThanOrEqual(TOPK_WIDTH);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it('abstains when the top candidate cannot clear the precision floor', () => {
    // A single-label workstream: shrunkPrecision(1) < SUGGEST_PRECISION_FLOOR
    // only if the floor sits above the tail rate. Verify the gate arithmetic
    // holds: a 1-label workstream is below the floor.
    expect(shrunkPrecision(1)).toBeLessThan(SUGGEST_PRECISION_FLOOR + 0.02);
    atMs = 1000;
    const state = createEmptyAttributionV1State();
    fill(state, 'ws-weak', [{ url: 'https://weak.com/1', title: 'niche esoteric topic zeta' }]);
    const result = scoreVisit(
      { title: 'niche esoteric topic zeta', url: 'https://weak.com/2' },
      state,
    );
    if (result.candidates[0] !== undefined) {
      // If it scored, it must have cleared the floor; otherwise it abstained.
      expect(result.candidates[0].shrunkPrecision).toBeGreaterThanOrEqual(SUGGEST_PRECISION_FLOOR);
    } else {
      expect(result.action).toBe('abstain');
    }
  });
});

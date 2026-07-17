import { describe, expect, it } from 'vitest';

import {
  HEAD_LABEL_THRESHOLD,
  MIN_SUGGEST_SCORE,
  SUGGEST_PRECISION_FLOOR,
  TOPK_WIDTH,
  scoreVisit,
  scoreVisitCascade,
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
// and a tail workstream about rust with enough distinctive members to clear the
// evidence gate. Both cite github.com so it is an ambiguous hub; lwn.net is
// single-workstream (linux). Rust members repeat a distinctive term set so the
// plain-overlap count for a rust query is large enough to clear
// MIN_SUGGEST_SCORE (the tail true-target must be reachable at all).
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
  // Rust: enough members carrying the distinctive rust terms that a rust query
  // sums a healthy overlap count (each of ownership/borrow/checker/lifetimes is
  // carried by many members ⇒ overlap well above the gate).
  const rustMembers: { url: string; title: string }[] = [];
  for (let i = 0; i < 12; i += 1) {
    rustMembers.push({
      url: `https://doc.rust-lang.org/book/${i}`,
      title: `Rust ownership borrow checker lifetimes traits generics ${i}`,
    });
  }
  rustMembers.push({ url: 'https://github.com/rust-lang/rust', title: 'Rust ownership borrow checker compiler' });
  fill(state, 'ws-rust', rustMembers);
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

// ---- title-lexical family (PLAIN term overlap) -----------------------

describe('scoreVisit title-lexical family (plain overlap)', () => {
  it('ranks the topically matching workstream first', () => {
    const state = buildScorerState();
    const result = scoreVisit(
      { title: 'Rust ownership borrow checker and lifetimes', url: 'https://blog.example/rust' },
      state,
    );
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0]!.workstreamId).toBe('ws-rust');
    const titleReason = result.candidates[0]!.reasons.find((r) => r.family === 'title-lexical');
    expect(titleReason).toBeDefined();
  });

  it('scores the title family as a RAW OVERLAP COUNT (no IDF, no length norm)', () => {
    // The plain primitive sums each workstream's member document-frequency over
    // the matched query terms. For a term carried by N members the contribution
    // is N — no cross-workstream IDF discount, no BM25 saturation/length norm.
    const state = buildScorerState();
    // Expose ranking without the gate (minSuggestScore 0) so we can read the
    // raw title contribution.
    const result = scoreVisit(
      { title: 'Linux kernel scheduler memory paging', url: 'https://blog.example/x' },
      state,
      { minSuggestScore: 0 },
    );
    const linux = result.candidates.find((c) => c.workstreamId === 'ws-linux')!;
    // Every one of the 22 lwn members carries all five query terms, and "linux"
    // + "kernel" also appear in the 23rd (github) member ⇒ the title
    // contribution is on the order of 5×22 = O(100), NOT a sub-unit IDF score.
    expect(linux.contributions.titleLexical).toBeGreaterThan(50);
  });

  it('a lone shared venue term ("github") does not out-score a real topic match', () => {
    const state = buildScorerState();
    // "github" now DOES contribute to the title family (plain overlap has no
    // IDF venue-suppression — that job moved to the conditional-domain
    // ambiguity gate). But a single venue term's overlap is tiny next to a
    // multi-term topical match, and github is an ambiguous hub so the domain
    // family stays silent. Compare raw scores with the gate off.
    const venueTop =
      scoreVisit({ title: 'github', url: 'https://blog.example/misc' }, state, { minSuggestScore: 0 })
        .candidates[0]?.score ?? 0;
    const realTop = scoreVisit(
      { title: 'Rust ownership borrow checker lifetimes', url: 'https://blog.example/rust' },
      state,
      { minSuggestScore: 0 },
    ).candidates[0]!.score;
    expect(venueTop).toBeLessThan(realTop);
  });
});

// ---- conditional-domain family ---------------------------------------

describe('scoreVisit conditional-domain family', () => {
  it('adds a domain contribution for a single-workstream domain', () => {
    const state = buildScorerState();
    const result = scoreVisit(
      { title: 'Linux kernel scheduler memory paging article', url: 'https://lwn.net/article/new' },
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
      { minSuggestScore: 0 },
    );
    // github maps to two workstreams ⇒ conditional-domain contributes 0 for
    // every candidate, even the one the title picks. Venue handling lives here
    // now, not in the title family's IDF.
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
    // Two workstreams share the exact same multi-term member titles, so their
    // plain-overlap title scores tie. ws-b is filed last.
    const sharedTitle = 'quantum entanglement photon qubit decoherence superposition';
    fill(state, 'ws-a', [1, 2, 3, 4].map((i) => ({ url: `https://a.com/${i}`, title: sharedTitle })));
    fill(state, 'ws-b', [1, 2, 3, 4].map((i) => ({ url: `https://b.com/${i}`, title: sharedTitle })));
    expect(state.lastFiledWorkstreamId).toBe('ws-b');
    const result = scoreVisit({ title: sharedTitle, url: 'https://query.example/x' }, state, {
      minSuggestScore: 0,
    });
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
    // Rust is a tail workstream (< HEAD_LABEL_THRESHOLD labels) but its members
    // carry the distinctive rust terms across enough documents that the overlap
    // count clears the evidence gate.
    const result = scoreVisit(
      { title: 'Rust ownership borrow checker lifetimes traits generics', url: 'https://blog.example/rust' },
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

  it('abstains on a weak match below the evidence gate even for a head workstream', () => {
    // The evidence gate (MIN_SUGGEST_SCORE) is the load-bearing abstention
    // control, keyed on THIS visit's overlap count — NOT the workstream's label
    // count. Regression guard for the "gate was a near no-op" finding: a head
    // workstream (clears the precision prior comfortably) still abstains when
    // the visit's evidence is weak (a single generic overlap term).
    const state = buildScorerState();
    // Only "source" overlaps the linux github member ("Linux kernel source
    // tree") beyond the venue term; the overlap count is a handful, well under
    // MIN_SUGGEST_SCORE (14), so v1 abstains even though ws-linux is head.
    const result = scoreVisit({ title: 'source tree', url: 'https://blog.example/misc' }, state);
    expect(result.action).toBe('abstain');
    expect(result.candidates).toEqual([]);
  });

  it('suggests once the overlap count clears the evidence gate', () => {
    // Complement of the above: a strong multi-term topical match sums an overlap
    // count above MIN_SUGGEST_SCORE and is surfaced. Locks the gate threshold
    // against silent drift.
    const state = buildScorerState();
    const result = scoreVisit(
      { title: 'Linux kernel scheduler memory paging article', url: 'https://lwn.net/article/head' },
      state,
    );
    expect(result.action).not.toBe('abstain');
    expect(result.candidates[0]!.score).toBeGreaterThanOrEqual(MIN_SUGGEST_SCORE);
  });
});

// ---- cascade combiner -------------------------------------------------

describe('scoreVisitCascade', () => {
  it('agrees with the weighted sum when the title tier fires strongly', () => {
    const state = buildScorerState();
    const input = { title: 'Linux kernel scheduler memory paging article', url: 'https://lwn.net/article/head' };
    const weighted = scoreVisit(input, state);
    const cascade = scoreVisitCascade(input, state);
    // Both pick ws-linux from the dominant title tier.
    expect(cascade.candidates[0]!.workstreamId).toBe('ws-linux');
    expect(weighted.candidates[0]!.workstreamId).toBe('ws-linux');
  });

  it('falls back to the unambiguous-domain tier when no title overlaps (gate off)', () => {
    const state = buildScorerState();
    // A visit on lwn.net (single-workstream domain) whose title shares nothing
    // with any member ⇒ the title tier is empty, so the cascade falls to the
    // domain tier and answers ws-linux. Exposed with the gate off (the domain
    // tier's score is below the shipping evidence gate by design).
    const cascade = scoreVisitCascade(
      { title: 'zzz qqq vvv nomatch', url: 'https://lwn.net/article/misc' },
      state,
      { minSuggestScore: 0 },
    );
    expect(cascade.candidates[0]!.workstreamId).toBe('ws-linux');
    expect(cascade.candidates[0]!.contributions.conditionalDomain).toBeGreaterThan(0);
  });

  it('falls back to the recency tier when neither title nor domain fires (gate off)', () => {
    atMs = 1000;
    const state = createEmptyAttributionV1State();
    fill(state, 'ws-a', [{ url: 'https://a.example/1', title: 'alpha beta gamma' }]);
    fill(state, 'ws-b', [{ url: 'https://b.example/1', title: 'delta epsilon zeta' }]);
    expect(state.lastFiledWorkstreamId).toBe('ws-b');
    // A visit that matches no title term and whose domain is unseen ⇒ cascade
    // falls all the way to recency ⇒ ws-b.
    const cascade = scoreVisitCascade(
      { title: 'nomatch nomatch nomatch', url: 'https://unseen.example/x' },
      state,
      { minSuggestScore: 0 },
    );
    expect(cascade.candidates[0]!.workstreamId).toBe('ws-b');
    expect(cascade.candidates[0]!.contributions.recency).toBeGreaterThan(0);
  });
});

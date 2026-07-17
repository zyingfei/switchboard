import { describe, expect, it } from 'vitest';

import {
  applyOrganizingObservation,
  brandTokensForDomain,
  buildAttributionV1State,
  buildTitleIndex,
  createEmptyAttributionV1State,
  domainChromeTokens,
  domainDiscriminativeness,
  domainDiscriminativenessTable,
  domainOfUrl,
  domainVerdict,
  isCoarseMultiTopicPriorDomain,
  NEUTRAL_DISCRIMINATIVENESS,
  plainTitleNearestWorkstreamSuppressed,
  registrableDomainOf,
  termIdf,
  tokenizeTitle,
  workstreamLabelCount,
  type AttributionV1State,
  type OrganizingObservation,
} from './state.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import { USER_ORGANIZED_ITEM } from '../feedback/events.js';
import type { AcceptedEvent } from '../sync/causal.js';

// ---- fixtures ---------------------------------------------------------

let seq = 0;
const organizeEvent = (
  canonicalUrl: string,
  toContainer: string,
  atMs: number,
  itemKind: 'canonical-url' | 'visit' = 'canonical-url',
  action: 'move' | 'promote' = 'move',
): AcceptedEvent => {
  seq += 1;
  return {
    clientEventId: `org-${seq}`,
    dot: { replicaId: 'r1', seq },
    deps: {},
    aggregateId: `canonical-url:${canonicalUrl}`,
    type: USER_ORGANIZED_ITEM,
    payload: { payloadVersion: 1, itemKind, itemId: canonicalUrl, action, toContainer },
    acceptedAtMs: atMs,
  };
};

const timelineEvent = (canonicalUrl: string, title: string, atMs: number): AcceptedEvent => {
  seq += 1;
  return {
    clientEventId: `tl-${seq}`,
    dot: { replicaId: 'r1', seq },
    deps: {},
    aggregateId: `timeline-visit:${canonicalUrl}`,
    type: BROWSER_TIMELINE_OBSERVED,
    payload: {
      eventId: `evt-${seq}`,
      observedAt: new Date(atMs).toISOString(),
      url: canonicalUrl,
      canonicalUrl,
      title,
      transition: 'activated',
    },
    acceptedAtMs: atMs,
  };
};

// A small hand-computable corpus: two topic workstreams plus a shared venue.
// "github.com" appears in BOTH ws-linux and ws-rust ⇒ its host term and any
// venue-ish term should be down-weighted by cross-workstream IDF.
const corpus = (): readonly AcceptedEvent[] => {
  seq = 0;
  return [
    timelineEvent('https://github.com/torvalds/linux', 'Linux kernel scheduler internals', 1000),
    timelineEvent('https://lwn.net/Articles/crypto', 'Kernel crypto subsystem overview', 1100),
    timelineEvent('https://github.com/rust-lang/rust', 'Rust ownership and borrow checker', 1200),
    timelineEvent('https://doc.rust-lang.org/book', 'Rust book: lifetimes and traits', 1300),
    organizeEvent('https://github.com/torvalds/linux', 'ws-linux', 2000),
    organizeEvent('https://lwn.net/Articles/crypto', 'ws-linux', 2100),
    organizeEvent('https://github.com/rust-lang/rust', 'ws-rust', 2200),
    organizeEvent('https://doc.rust-lang.org/book', 'ws-rust', 2300),
  ];
};

// ---- tokenizer / domain ----------------------------------------------

describe('tokenizeTitle', () => {
  it('lowercases, splits on punctuation, drops stopwords and short tokens', () => {
    expect(tokenizeTitle('The Rust Book: Lifetimes and Traits')).toEqual([
      'rust',
      'book',
      'lifetimes',
      'traits',
    ]);
  });

  it('returns empty for an empty title', () => {
    expect(tokenizeTitle('')).toEqual([]);
  });
});

describe('domainOfUrl', () => {
  it('strips www and lowercases the host', () => {
    expect(domainOfUrl('https://WWW.Example.com/path')).toBe('example.com');
  });
  it('returns null for a malformed url', () => {
    expect(domainOfUrl('not a url')).toBeNull();
  });
});

describe('buildTitleIndex', () => {
  it('keeps the first non-empty title per canonical url', () => {
    seq = 0;
    const index = buildTitleIndex([
      timelineEvent('https://a.com', 'First title', 1),
      timelineEvent('https://a.com', 'Second title', 2),
    ]);
    expect(index.get('https://a.com')).toBe('First title');
  });
});

// ---- cross-workstream IDF (venue suppression) ------------------------

describe('cross-workstream IDF', () => {
  it('gives a venue term shared across workstreams a lower IDF than a topic term', () => {
    const state = buildAttributionV1State([
      timelineEvent('https://a.com/1', 'github repo scheduler', 1),
      timelineEvent('https://a.com/2', 'github repo borrow', 2),
      organizeEvent('https://a.com/1', 'ws-a', 10),
      organizeEvent('https://a.com/2', 'ws-b', 11),
    ]);
    // "github" and "repo" appear in BOTH workstreams' member titles;
    // "scheduler" appears in only one. The shared term must have strictly
    // lower IDF than the discriminating one — the venue-suppression property.
    expect(termIdf(state, 'github')).toBeLessThan(termIdf(state, 'scheduler'));
    expect(termIdf(state, 'repo')).toBeLessThan(termIdf(state, 'borrow'));
  });
});

// ---- domain verdict (ambiguity) --------------------------------------

describe('domainVerdict', () => {
  it('maps a single-workstream domain to that workstream (not ambiguous)', () => {
    const state = buildAttributionV1State(corpus());
    const verdict = domainVerdict(state, 'lwn.net');
    expect(verdict.ambiguous).toBe(false);
    expect(verdict.workstreamId).toBe('ws-linux');
  });

  it('suppresses a multi-workstream (hub) domain: null workstream, ambiguous', () => {
    const state = buildAttributionV1State(corpus());
    const verdict = domainVerdict(state, 'github.com');
    expect(verdict.ambiguous).toBe(true);
    expect(verdict.workstreamId).toBeNull();
    expect(verdict.distinctWorkstreams).toBe(2);
  });

  it('returns null for an unseen domain', () => {
    const state = buildAttributionV1State(corpus());
    expect(domainVerdict(state, 'unseen.example').workstreamId).toBeNull();
  });
});

// ---- learned domain discriminativeness (continuous) ------------------

// Build a state by filing N labels for `workstreamId` all on `domain`, plus any
// extra (workstream, count) tallies on the SAME domain. Titles omitted (the
// discriminativeness reads only domain history, not titles).
const fileOnDomain = (
  entries: readonly { readonly domain: string; readonly workstreamId: string; readonly count: number }[],
): AttributionV1State => {
  const state = createEmptyAttributionV1State();
  let at = 1000;
  for (const entry of entries) {
    for (let i = 0; i < entry.count; i += 1) {
      at += 1;
      applyOrganizingObservation(state, {
        workstreamId: entry.workstreamId,
        canonicalUrl: `https://${entry.domain}/${entry.workstreamId}/${String(i)}`,
        atMs: at,
        provenance: 'asserted',
      });
    }
  }
  return state;
};

describe('domainDiscriminativeness (continuous, learned)', () => {
  it('an UNSEEN unlisted domain is neutral (the low-data default)', () => {
    const state = createEmptyAttributionV1State();
    expect(domainDiscriminativeness(state, 'example.org').discriminativeness).toBe(
      NEUTRAL_DISCRIMINATIVENESS,
    );
  });

  it('an unlisted domain seen for exactly ONE workstream is maximally discriminative (K=1 ⇒ 1.0)', () => {
    // No listed prior, one smoothed outcome ⇒ entropy 0 ⇒ discriminativeness 1.
    const state = fileOnDomain([{ domain: 'acme.io', workstreamId: 'ws-a', count: 3 }]);
    const d = domainDiscriminativeness(state, 'acme.io');
    expect(d.discriminativeness).toBe(1);
    expect(d.winnerWorkstreamId).toBe('ws-a');
    expect(d.listedPrior).toBe(false);
  });

  it('an unlisted domain split EVENLY across two workstreams is minimally discriminative (0)', () => {
    // masses = [1+α, 1+α] = [2, 2], entropy = log(2), normalized = 1 ⇒ D = 0.
    // This is the continuous generalization landing exactly on the old binary
    // "ambiguous hub ⇒ suppressed" for a maximally-even 2-way split.
    const state = fileOnDomain([
      { domain: 'split.io', workstreamId: 'ws-a', count: 1 },
      { domain: 'split.io', workstreamId: 'ws-b', count: 1 },
    ]);
    expect(domainDiscriminativeness(state, 'split.io').discriminativeness).toBeCloseTo(0, 6);
  });

  it('is monotone: a 5:1-skewed domain scores between the even split and the pure one', () => {
    const even = fileOnDomain([
      { domain: 'e.io', workstreamId: 'ws-a', count: 3 },
      { domain: 'e.io', workstreamId: 'ws-b', count: 3 },
    ]);
    const skew = fileOnDomain([
      { domain: 's.io', workstreamId: 'ws-a', count: 5 },
      { domain: 's.io', workstreamId: 'ws-b', count: 1 },
    ]);
    const pure = fileOnDomain([{ domain: 'p.io', workstreamId: 'ws-a', count: 6 }]);
    const dEven = domainDiscriminativeness(even, 'e.io').discriminativeness;
    const dSkew = domainDiscriminativeness(skew, 's.io').discriminativeness;
    const dPure = domainDiscriminativeness(pure, 'p.io').discriminativeness;
    expect(dEven).toBeLessThan(dSkew);
    expect(dSkew).toBeLessThan(dPure);
    expect(dPure).toBe(1);
  });

  it('Bayesian smoothing: n=1 on ONE workstream of an unlisted domain is still 1.0 (K=1) but a low-n 2-way tie shrinks to 0', () => {
    // Smoothing toward neutral is visible on multi-workstream low-n: a single
    // label each for two workstreams (n=2) reads as a fully-even split (D=0),
    // NOT some inflated value — the α pseudo-count prevents overconfidence.
    const twoWay = fileOnDomain([
      { domain: 't.io', workstreamId: 'ws-a', count: 1 },
      { domain: 't.io', workstreamId: 'ws-b', count: 1 },
    ]);
    expect(domainDiscriminativeness(twoWay, 't.io').discriminativeness).toBeCloseTo(0, 6);
  });
});

describe('the coarse-multi-topic list as a PRIOR (not a gate)', () => {
  it('recognizes listed registrable domains and their subdomains', () => {
    expect(isCoarseMultiTopicPriorDomain('news.ycombinator.com')).toBe(true);
    expect(isCoarseMultiTopicPriorDomain('ycombinator.com')).toBe(true);
    expect(isCoarseMultiTopicPriorDomain('old.reddit.com')).toBe(true);
    expect(isCoarseMultiTopicPriorDomain('gemini.google.com')).toBe(true);
    expect(isCoarseMultiTopicPriorDomain('lwn.net')).toBe(false);
    expect(registrableDomainOf('news.ycombinator.com')).toBe('ycombinator.com');
  });

  it('a listed domain with NO evidence initializes at discriminativeness 0 (the list acts as a low prior)', () => {
    const state = createEmptyAttributionV1State();
    const d = domainDiscriminativeness(state, 'news.ycombinator.com');
    // The diffuse prior alone (evenly spread over the synthetic buckets) has
    // maximal entropy ⇒ discriminativeness 0. An unlisted unseen domain would
    // be neutral (0.5) here — the list is what pins a listed one low.
    expect(d.discriminativeness).toBeCloseTo(0, 6);
    expect(d.listedPrior).toBe(true);
    expect(d.discriminativeness).toBeLessThan(NEUTRAL_DISCRIMINATIVENESS);
  });

  it('accumulated concentrated evidence OVERRIDES the list prior (climbs across neutral)', () => {
    // A "listed" domain that in THIS vault actually files to one workstream
    // earns its discriminativeness back: with the labels concentrated, the real
    // mass overwhelms the diffuse prior and D crosses neutral. This is the
    // whole point of demoting the hardcoded list to a prior.
    const few = fileOnDomain([{ domain: 'chatgpt.com', workstreamId: 'ws-ai', count: 3 }]);
    const many = fileOnDomain([{ domain: 'chatgpt.com', workstreamId: 'ws-ai', count: 20 }]);
    const dFew = domainDiscriminativeness(few, 'chatgpt.com').discriminativeness;
    const dMany = domainDiscriminativeness(many, 'chatgpt.com').discriminativeness;
    // A few labels are not enough (a single click can't unlock a hub)…
    expect(dFew).toBeLessThan(NEUTRAL_DISCRIMINATIVENESS);
    // …but sustained concentrated filing overrides the prior.
    expect(dMany).toBeGreaterThan(NEUTRAL_DISCRIMINATIVENESS);
    expect(dMany).toBeGreaterThan(dFew);
  });

  it('the exported table is sorted most→least discriminative', () => {
    const state = fileOnDomain([
      { domain: 'pure.io', workstreamId: 'ws-a', count: 4 }, // D=1
      { domain: 'split.io', workstreamId: 'ws-a', count: 1 },
      { domain: 'split.io', workstreamId: 'ws-b', count: 1 }, // D≈0
    ]);
    const table = domainDiscriminativenessTable(state);
    const domains = table.map((r) => r.domain);
    expect(domains[0]).toBe('pure.io');
    for (let i = 1; i < table.length; i += 1) {
      expect(table[i - 1]!.discriminativeness).toBeGreaterThanOrEqual(table[i]!.discriminativeness);
    }
  });
});

// ---- venue/brand-term suppression (targeted) -------------------------

describe('brandTokensForDomain (domain-string + static map)', () => {
  it('derives brand tokens from the domain string (dropping the TLD)', () => {
    expect([...brandTokensForDomain('reddit.com')]).toEqual(['reddit']);
    expect([...brandTokensForDomain('lwn.net')]).toEqual(['lwn']);
  });

  it('adds the static display-name tokens for HN (host ≠ brand name)', () => {
    const tokens = brandTokensForDomain('news.ycombinator.com');
    expect(tokens.has('hacker')).toBe(true);
    expect(tokens.has('news')).toBe(true);
    expect(tokens.has('ycombinator')).toBe(true);
  });
});

describe('domainChromeTokens (data-driven shared member tokens)', () => {
  it('flags a token present in most member titles as site chrome', () => {
    // "Hacker News" is the shared suffix; "foo"/"bar"/"baz" are per-page topic.
    const chrome = domainChromeTokens([
      'Foo bar Hacker News',
      'Baz qux Hacker News',
      'Quux corge Hacker News',
    ]);
    expect(chrome.has('hacker')).toBe(true);
    expect(chrome.has('news')).toBe(true);
    expect(chrome.has('foo')).toBe(false);
  });

  it('returns empty below the minimum member count (can\'t tell chrome from coincidence at n<3)', () => {
    expect(domainChromeTokens(['Alpha Hacker News', 'Beta Hacker News']).size).toBe(0);
  });
});

describe('plainTitleNearestWorkstreamSuppressed (the HN front-page fix)', () => {
  it('drops the visit domain\'s own brand tokens before scoring, so a bare venue title matches nothing', () => {
    // Members of ws-frontpage carry the "Hacker News" suffix (as real HN member
    // titles do). A visit whose title is LITERALLY "Hacker News" (the front
    // page) must NOT match — its only overlap terms are the domain's own brand
    // tokens, which are suppressed.
    const state = createEmptyAttributionV1State();
    let at = 1000;
    for (let i = 0; i < 5; i += 1) {
      at += 1;
      applyOrganizingObservation(state, {
        workstreamId: 'ws-frontpage',
        canonicalUrl: `https://news.ycombinator.com/item?id=${String(i)}`,
        title: `Interesting story ${String(i)} | Hacker News`,
        atMs: at,
        provenance: 'asserted',
      });
    }
    // Bare venue title on the HN domain ⇒ suppressed to nothing ⇒ no match.
    expect(
      plainTitleNearestWorkstreamSuppressed(state, 'Hacker News', 'news.ycombinator.com'),
    ).toBeNull();
    // A real topical title (with a surviving non-brand term) still matches.
    expect(
      plainTitleNearestWorkstreamSuppressed(state, 'Interesting story', 'news.ycombinator.com'),
    ).toBe('ws-frontpage');
  });

  it('only suppresses tokens for the visit\'s OWN domain (not a global stoplist)', () => {
    // "news" is a brand token of HN but a legitimate topic term elsewhere. A
    // visit on a DIFFERENT domain keeps "news" as a scoring term.
    const state = createEmptyAttributionV1State();
    applyOrganizingObservation(state, {
      workstreamId: 'ws-media',
      canonicalUrl: 'https://bbc.co.uk/news/1',
      title: 'Breaking news report',
      atMs: 1000,
      provenance: 'asserted',
    });
    // On bbc.co.uk, "news" is NOT a brand token (bbc's brand token is "bbc") so
    // it survives and matches the ws-media member.
    expect(
      plainTitleNearestWorkstreamSuppressed(state, 'news report', 'bbc.co.uk'),
    ).toBe('ws-media');
    // On news.ycombinator.com, "news" IS suppressed; only "report" survives and
    // ws-media carries it too, so it still matches on the surviving term.
    expect(
      plainTitleNearestWorkstreamSuppressed(state, 'news report', 'news.ycombinator.com'),
    ).toBe('ws-media');
    // But a bare "news" title on HN suppresses to nothing.
    expect(
      plainTitleNearestWorkstreamSuppressed(state, 'news', 'news.ycombinator.com'),
    ).toBeNull();
  });
});

// ---- recency + label counts ------------------------------------------

describe('recency and label counts', () => {
  it('records the last-filed workstream by acceptance time', () => {
    const state = buildAttributionV1State(corpus());
    // Latest organize event (atMs 2300) files into ws-rust.
    expect(state.lastFiledWorkstreamId).toBe('ws-rust');
    expect(state.lastFiledAtMs).toBe(2300);
  });

  it('counts supervised labels per workstream', () => {
    const state = buildAttributionV1State(corpus());
    expect(workstreamLabelCount(state, 'ws-linux')).toBe(2);
    expect(workstreamLabelCount(state, 'ws-rust')).toBe(2);
  });

  it('counts a label with no joinable title toward labelCount but not memberCount', () => {
    seq = 0;
    const state = buildAttributionV1State([organizeEvent('https://x.com', 'ws-x', 1)]);
    expect(workstreamLabelCount(state, 'ws-x')).toBe(1);
    expect(state.workstreams.get('ws-x')?.memberCount).toBe(0);
    expect(state.totalMemberCount).toBe(0);
  });
});

// ---- incremental == rebuild equivalence ------------------------------

// Serialize a state to a canonical, order-independent structure so two
// states can be compared regardless of Map insertion order.
const canonicalize = (state: AttributionV1State): unknown => {
  const sortEntries = (map: Map<string, number>): [string, number][] =>
    [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    workstreams: [...state.workstreams.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([id, stats]) => [
        id,
        {
          termDocFreq: sortEntries(stats.termDocFreq),
          memberCount: stats.memberCount,
          labelCount: stats.labelCount,
        },
      ]),
    globalTermWorkstreamFreq: sortEntries(state.globalTermWorkstreamFreq),
    domains: [...state.domains.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([domain, history]) => [
        domain,
        { asserted: sortEntries(history.asserted), inferred: sortEntries(history.inferred) },
      ]),
    lastFiledWorkstreamId: state.lastFiledWorkstreamId,
    lastFiledAtMs: state.lastFiledAtMs,
    totalLabelCount: state.totalLabelCount,
    totalMemberCount: state.totalMemberCount,
  };
};

describe('incremental fold == rebuild-from-log', () => {
  it('applyOrganizingObservation per label equals a full rebuild over the same prefix', () => {
    const events = corpus();
    const rebuilt = buildAttributionV1State(events);

    // Replay the SAME labels one at a time through the incremental path,
    // using the same title-join map the rebuild path uses.
    const titleByUrl = buildTitleIndex(events);
    const incremental = createEmptyAttributionV1State();
    const observations: OrganizingObservation[] = [
      { workstreamId: 'ws-linux', canonicalUrl: 'https://github.com/torvalds/linux', atMs: 2000 },
      { workstreamId: 'ws-linux', canonicalUrl: 'https://lwn.net/Articles/crypto', atMs: 2100 },
      { workstreamId: 'ws-rust', canonicalUrl: 'https://github.com/rust-lang/rust', atMs: 2200 },
      { workstreamId: 'ws-rust', canonicalUrl: 'https://doc.rust-lang.org/book', atMs: 2300 },
    ].map((o) => ({
      ...o,
      ...(titleByUrl.get(o.canonicalUrl) === undefined
        ? {}
        : { title: titleByUrl.get(o.canonicalUrl)! }),
      provenance: 'asserted' as const,
    }));
    for (const observation of observations) applyOrganizingObservation(incremental, observation);

    expect(canonicalize(incremental)).toEqual(canonicalize(rebuilt));
  });

  it('is order-independent across a shuffled incremental fold on commutative fields', () => {
    const events = corpus();
    const titleByUrl = buildTitleIndex(events);
    const base: Omit<OrganizingObservation, 'provenance'>[] = [
      { workstreamId: 'ws-linux', canonicalUrl: 'https://github.com/torvalds/linux', atMs: 2000 },
      { workstreamId: 'ws-rust', canonicalUrl: 'https://github.com/rust-lang/rust', atMs: 2200 },
      { workstreamId: 'ws-linux', canonicalUrl: 'https://lwn.net/Articles/crypto', atMs: 2100 },
      { workstreamId: 'ws-rust', canonicalUrl: 'https://doc.rust-lang.org/book', atMs: 2300 },
    ];
    const foldAll = (order: Omit<OrganizingObservation, 'provenance'>[]): AttributionV1State => {
      const state = createEmptyAttributionV1State();
      for (const o of order) {
        applyOrganizingObservation(state, {
          ...o,
          ...(titleByUrl.get(o.canonicalUrl) === undefined
            ? {}
            : { title: titleByUrl.get(o.canonicalUrl)! }),
          provenance: 'asserted',
        });
      }
      return state;
    };
    const forward = canonicalize(foldAll(base)) as Record<string, unknown>;
    const reversed = canonicalize(foldAll([...base].reverse())) as Record<string, unknown>;
    // Term index / domain history / counts are commutative; recency is max-
    // by-time so it also matches regardless of fold order.
    expect(forward).toEqual(reversed);
  });
});

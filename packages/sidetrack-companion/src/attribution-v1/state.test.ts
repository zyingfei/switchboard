import { describe, expect, it } from 'vitest';

import {
  applyOrganizingObservation,
  buildAttributionV1State,
  buildTitleIndex,
  createEmptyAttributionV1State,
  domainOfUrl,
  domainVerdict,
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

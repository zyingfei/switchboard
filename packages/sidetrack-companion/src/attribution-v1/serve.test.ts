import { describe, expect, it } from 'vitest';

import {
  ATTRIBUTION_ARM_ENV,
  DEFAULT_ATTRIBUTION_ARM,
  VOTE3_AUTO_APPLY_MIN_VOTES,
  VOTE3_SUGGEST_MIN_VOTES,
  attributionArm,
  resolveUrlAttributionVote3,
} from './serve.js';
import { buildAttributionV1State } from './state.js';
import { scoreVisit } from './scorer.js';
import { inferredUrlAttributionPayloadFromResolution } from '../tabsession/resolver.js';
import { USER_ORGANIZED_ITEM } from '../feedback/events.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import type { AcceptedEvent } from '../sync/causal.js';

// ---- fixture builders (asserted labels + titles) ----------------------

let seq = 0;
const organize = (url: string, ws: string, atMs: number): AcceptedEvent => {
  seq += 1;
  return {
    clientEventId: `org-${seq}`,
    dot: { replicaId: 'r1', seq },
    deps: {},
    aggregateId: `canonical-url:${url}`,
    type: USER_ORGANIZED_ITEM,
    payload: { payloadVersion: 1, itemKind: 'canonical-url', itemId: url, action: 'move', toContainer: ws },
    acceptedAtMs: atMs,
  };
};
const timeline = (url: string, title: string, atMs: number): AcceptedEvent => {
  seq += 1;
  return {
    clientEventId: `tl-${seq}`,
    dot: { replicaId: 'r1', seq },
    deps: {},
    aggregateId: `timeline-visit:${url}`,
    type: BROWSER_TIMELINE_OBSERVED,
    payload: {
      eventId: `evt-${seq}`,
      observedAt: new Date(atMs).toISOString(),
      url,
      canonicalUrl: url,
      title,
      transition: 'activated',
    },
    acceptedAtMs: atMs,
  };
};

describe('attributionArm — flag parsing', () => {
  const withEnv = <T>(value: string | undefined, fn: () => T): T => {
    const prev = process.env[ATTRIBUTION_ARM_ENV];
    if (value === undefined) delete process.env[ATTRIBUTION_ARM_ENV];
    else process.env[ATTRIBUTION_ARM_ENV] = value;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env[ATTRIBUTION_ARM_ENV];
      else process.env[ATTRIBUTION_ARM_ENV] = prev;
    }
  };

  it('defaults to the vote arm (vote3) when unset', () => {
    expect(DEFAULT_ATTRIBUTION_ARM).toBe('vote3');
    withEnv(undefined, () => expect(attributionArm()).toBe('vote3'));
    withEnv('', () => expect(attributionArm()).toBe('vote3'));
  });

  it('accepts both vote3 and vote4 spellings for the vote arm', () => {
    withEnv('vote3', () => expect(attributionArm()).toBe('vote3'));
    withEnv('vote4', () => expect(attributionArm()).toBe('vote3'));
  });

  it('falls back to the incumbent on v1 / incumbent', () => {
    withEnv('v1', () => expect(attributionArm()).toBe('v1'));
    withEnv('incumbent', () => expect(attributionArm()).toBe('v1'));
  });

  it('unknown values fall back to the default (vote arm)', () => {
    withEnv('garbage', () => expect(attributionArm()).toBe('vote3'));
  });
});

describe('resolveUrlAttributionVote3 — the 0.088-vs-0.436 abstain case', () => {
  it('suggests where the incumbent v1 scorer abstains (fresh workstream-tied neighbor)', () => {
    // Build state so wsAlpha has strong recency + a domain history on a
    // single-workstream domain. A fresh visit on that domain (no title overlap
    // strong enough to clear the incumbent's MIN_SUGGEST_SCORE=14 evidence gate)
    // makes the incumbent scoreVisit ABSTAIN — the shipped-v1 86%-abstain
    // behaviour. The vote arm, keying off the domain vote + recency, SUGGESTS.
    seq = 0;
    const events: AcceptedEvent[] = [
      timeline('https://blog.rust-lang.org/a', 'rust release notes', 1),
      timeline('https://blog.rust-lang.org/b', 'rust async update', 2),
      organize('https://blog.rust-lang.org/a', 'wsRust', 10),
      organize('https://blog.rust-lang.org/b', 'wsRust', 11),
    ];
    const state = buildAttributionV1State(events);

    // A fresh visit on the SAME single-workstream domain, but a title with no
    // overlap against wsRust's stored member terms ⇒ the incumbent title family
    // scores 0 and abstains under the evidence gate.
    const freshUrl = 'https://blog.rust-lang.org/c';
    const freshTitle = 'completely unrelated headline words here';

    const incumbent = scoreVisit({ title: freshTitle, url: freshUrl }, state);
    expect(incumbent.action).toBe('abstain');

    // The vote arm: domain vote = wsRust (single-workstream, fully
    // discriminative ⇒ gate passes) + recency = wsRust ⇒ 2 votes ⇒ SUGGEST.
    const vote = resolveUrlAttributionVote3({ state, canonicalUrl: freshUrl, title: freshTitle });
    expect(vote.decision.action).toBe('suggest');
    expect(vote.decision.workstreamId).toBe('wsRust');
    expect(vote.fusedCandidates).toHaveLength(1);
    expect(vote.fusedCandidates[0]!.corroborationCount).toBe(2);
  });

  it('auto-applies only on unanimous 3-signal agreement', () => {
    // Title + domain + recency ALL point at wsRust ⇒ 3 votes ⇒ auto-apply, and
    // the inferred-payload builder produces a valid payload (dominantSource !=
    // none), so the round-guard/auto-apply path can commit it.
    seq = 0;
    const events: AcceptedEvent[] = [
      timeline('https://rust-lang.org/a', 'distributed consensus raft protocol', 1),
      timeline('https://rust-lang.org/b', 'distributed consensus raft log', 2),
      organize('https://rust-lang.org/a', 'wsRust', 10),
      organize('https://rust-lang.org/b', 'wsRust', 11),
    ];
    const state = buildAttributionV1State(events);
    const vote = resolveUrlAttributionVote3({
      state,
      canonicalUrl: 'https://rust-lang.org/c',
      title: 'distributed consensus raft protocol',
    });
    expect(vote.decision.action).toBe('auto-apply');
    expect(vote.decision.workstreamId).toBe('wsRust');
    expect(vote.fusedCandidates[0]!.corroborationCount).toBe(VOTE3_AUTO_APPLY_MIN_VOTES);
    // The auto-apply payload builder accepts this result (non-'none' source).
    const payload = inferredUrlAttributionPayloadFromResolution(vote);
    expect(payload).not.toBeNull();
    expect(payload!.workstreamId).toBe('wsRust');
  });

  it('abstains (inbox) when no signal votes', () => {
    // Empty state ⇒ no title match, no domain, no recency ⇒ 0 votes ⇒ inbox.
    const state = buildAttributionV1State([]);
    const vote = resolveUrlAttributionVote3({
      state,
      canonicalUrl: 'https://example.com/x',
      title: 'anything',
    });
    expect(vote.decision.action).toBe('inbox');
    expect(vote.fusedCandidates).toHaveLength(0);
    expect(inferredUrlAttributionPayloadFromResolution(vote)).toBeNull();
  });

  it('the aggregator false-friend hub is NOT suggested via the domain channel', () => {
    // A dispersed aggregator hub (news.ycombinator.com, listed-prior) whose
    // domain argmax is wsHubHeavy. A fresh hub visit with NO title overlap gets
    // NO domain vote (gate withholds it on the below-neutral hub) and NO recency
    // pointing at the hub ⇒ the vote arm abstains rather than mis-filing the hub
    // page. This is the servable analogue of the B1/B4 aggregator suppression:
    // the vote arm never rode the resemblance-edge similarity channel the
    // false-friend used, and its domain vote is hub-gated.
    seq = 0;
    const events: AcceptedEvent[] = [
      timeline('https://news.ycombinator.com/item?id=1', 'thread one', 1),
      timeline('https://news.ycombinator.com/item?id=2', 'thread two', 2),
      timeline('https://news.ycombinator.com/item?id=3', 'thread three', 3),
      organize('https://news.ycombinator.com/item?id=1', 'wsHubHeavy', 10),
      organize('https://news.ycombinator.com/item?id=2', 'wsHubHeavy', 11),
      organize('https://news.ycombinator.com/item?id=3', 'wsOther', 12),
      // A separate workstream filed LAST so recency points away from the hub.
      timeline('https://other.example/x', 'gardening compost soil', 13),
      organize('https://other.example/x', 'wsGarden', 20),
    ];
    const state = buildAttributionV1State(events);
    const vote = resolveUrlAttributionVote3({
      state,
      canonicalUrl: 'https://news.ycombinator.com/item?id=fresh',
      // Title with no overlap against any stored member titles.
      title: 'brand new headline nobody filed before',
    });
    // The hub domain vote is withheld; the only vote would be recency = wsGarden
    // (1 vote), which is the honest "last-filed" fallback, NOT a hub mis-file.
    // Critically the hub workstream (wsHubHeavy) is NEVER suggested.
    expect(vote.decision.workstreamId).not.toBe('wsHubHeavy');
    expect(vote.decision.workstreamId).not.toBe('wsOther');
  });
});

describe('resolveUrlAttributionVote3 — thresholds', () => {
  it('exposes the documented vote-count ladder', () => {
    expect(VOTE3_SUGGEST_MIN_VOTES).toBe(1);
    expect(VOTE3_AUTO_APPLY_MIN_VOTES).toBe(3);
  });
});

// ---- domain-tombstone privacy gate (F1) -------------------------------
//
// The vote arm is a NEW serve boundary reading the raw-event-folded state,
// which carries no tombstone filtering. The gate must be applied at serve so a
// purged URL is never voted on (the incumbent returns nothing for it) and a
// purged domain does not cast its domain vote for sibling pages.

// A minimal Vote3TombstoneGate that matches a fixed set of tombstoned
// registrable domains (family scope) — mirrors buildDomainTombstoneSet's
// matchesPage/matchesDomain semantics for the test without the full store.
const tombstoneGate = (domains: readonly string[]) => {
  const set = new Set(domains);
  const registrable = (host: string): string => {
    const labels = host.toLowerCase().replace(/^www\./u, '').split('.');
    return labels.length <= 2 ? labels.join('.') : labels.slice(-2).join('.');
  };
  const domainOfHref = (url: string): string => {
    try {
      return registrable(new URL(url).hostname);
    } catch {
      return '';
    }
  };
  return {
    matchesPage: (page: { url?: string; title?: string }): boolean =>
      page.url !== undefined && set.has(domainOfHref(page.url)),
    matchesDomain: (domain: string): boolean => set.has(registrable(domain)),
  };
};

describe('resolveUrlAttributionVote3 — domain-tombstone gate', () => {
  it('abstains (inbox) on a tombstoned URL even when signals would vote', () => {
    // wsBank has strong recency + a single-workstream domain, so an ungated
    // resolve would SUGGEST. Purging mybank.com must make the resolve abstain —
    // the purged URL is never voted on (matching the incumbent, whose node the
    // snapshot no longer carries).
    seq = 0;
    const events: AcceptedEvent[] = [
      timeline('https://mybank.com/a', 'statement summary', 1),
      timeline('https://mybank.com/b', 'statement detail', 2),
      organize('https://mybank.com/a', 'wsBank', 10),
      organize('https://mybank.com/b', 'wsBank', 11),
    ];
    const state = buildAttributionV1State(events);
    const url = 'https://mybank.com/statement?id=fresh';

    // Ungated: title + domain + recency all point at wsBank ⇒ a NON-inbox
    // decision (the purged page WOULD be attributed without the gate).
    const ungated = resolveUrlAttributionVote3({ state, canonicalUrl: url, title: 'statement summary' });
    expect(ungated.decision.action).not.toBe('inbox');
    expect(ungated.decision.workstreamId).toBe('wsBank');

    // Gated by a mybank.com tombstone ⇒ inbox, no candidate cites the purged page.
    const gated = resolveUrlAttributionVote3({
      state,
      canonicalUrl: url,
      title: 'statement summary',
      tombstones: tombstoneGate(['mybank.com']),
    });
    expect(gated.decision.action).toBe('inbox');
    expect(gated.fusedCandidates).toHaveLength(0);
    expect(gated.decision.workstreamId).toBeUndefined();
  });

  it('withholds a tombstoned domain’s vote (purged labels do not contribute)', () => {
    // A purged domain whose labels populate its domain history must NOT cast its
    // learned domain vote once tombstoned. Here the ONLY vote for a fresh
    // purged-domain URL (empty title, no recency toward it) is the domain vote;
    // withholding it drops the resolve to inbox rather than voting off purged
    // data.
    seq = 0;
    const events: AcceptedEvent[] = [
      timeline('https://purged.example/a', 'alpha alpha alpha', 1),
      timeline('https://purged.example/b', 'beta beta beta', 2),
      organize('https://purged.example/a', 'wsPurged', 10),
      organize('https://purged.example/b', 'wsPurged', 11),
      // A LAST filing on a different domain so recency points away from wsPurged.
      timeline('https://other.example/x', 'gardening compost', 13),
      organize('https://other.example/x', 'wsGarden', 20),
    ];
    const state = buildAttributionV1State(events);
    const url = 'https://purged.example/c';

    // Ungated: the single-workstream purged domain casts a vote ⇒ wsPurged in
    // the candidate set (suggest or better).
    const ungated = resolveUrlAttributionVote3({
      state,
      canonicalUrl: url,
      title: 'no overlap headline here',
    });
    expect(ungated.decision.workstreamId).toBe('wsPurged');

    // Gated: the tombstoned domain's vote is withheld. The only remaining vote
    // is recency = wsGarden — so the resolve NEVER cites the purged workstream.
    const gated = resolveUrlAttributionVote3({
      state,
      canonicalUrl: url,
      title: 'no overlap headline here',
      tombstones: tombstoneGate(['purged.example']),
    });
    expect(gated.decision.workstreamId).not.toBe('wsPurged');
  });
});

describe('resolveUrlAttributionVote3 — aggregator false-friend with a RICH topical title', () => {
  it('does NOT reconstruct the 2026-07-10 HN→linux-security false-friend through any vote channel', () => {
    // The real case: an HN item with a RICH topical title
    // ("AI-generated videos to maximally drive a target brain region") was
    // mis-filed to linux-security @82% via a 0.65 same_repo_or_domain edge +
    // same_title_path_tokens. Walk it through the vote arm:
    //   - a `brain` workstream carries the topical title tokens;
    //   - a `linux-security` workstream carries UNRELATED tokens but shares the
    //     hub domain history (some HN items were filed to it);
    //   - the hub (news.ycombinator.com) is dispersed ⇒ domain vote WITHHELD;
    //   - the venue brand tokens (hacker/news/ycombinator) are suppressed from
    //     the title vote, and the topical title tokens point at `brain`.
    // The vote arm must land on `brain` (or abstain) — NEVER linux-security,
    // which is the token-overlapping-but-wrong workstream the 0.65 edge produced.
    seq = 0;
    const events: AcceptedEvent[] = [
      // brain workstream: HN items with the topical title.
      timeline('https://news.ycombinator.com/item?id=b1', 'ai generated videos drive target brain region', 1),
      timeline('https://news.ycombinator.com/item?id=b2', 'brain region stimulation deep learning', 2),
      organize('https://news.ycombinator.com/item?id=b1', 'wsBrain', 10),
      organize('https://news.ycombinator.com/item?id=b2', 'wsBrain', 11),
      // linux-security workstream: also fed from HN (so the hub is dispersed),
      // unrelated tokens.
      timeline('https://news.ycombinator.com/item?id=l1', 'kernel exploit privilege escalation cve', 3),
      timeline('https://news.ycombinator.com/item?id=l2', 'sandbox escape hardening patch', 4),
      organize('https://news.ycombinator.com/item?id=l1', 'wsLinuxSecurity', 12),
      organize('https://news.ycombinator.com/item?id=l2', 'wsLinuxSecurity', 13),
    ];
    const state = buildAttributionV1State(events);

    // The PROBE: a fresh HN item with the RICH topical brain title.
    const vote = resolveUrlAttributionVote3({
      state,
      canonicalUrl: 'https://news.ycombinator.com/item?id=probe',
      title: 'ai generated videos drive target brain region',
    });
    // Whatever it decides, it must NOT be the token-overlapping wrong workstream.
    expect(vote.decision.workstreamId).not.toBe('wsLinuxSecurity');
    // The domain vote is withheld (dispersed hub), so linux-security cannot win
    // on the domain channel; the title vote — if it fires — lands on wsBrain.
    if (vote.decision.workstreamId !== undefined) {
      expect(vote.decision.workstreamId).toBe('wsBrain');
    }
  });
});

import { describe, expect, it } from 'vitest';

import {
  ATTRIBUTION_PREQUENTIAL_ARMS,
  HEAD_WORKSTREAM_LABEL_THRESHOLD,
  buildPrequentialVerdict,
  gatedDomainWorkstream,
  runAttributionPrequential,
  runV1ThresholdCurve,
  runVote3VoteCountCurve,
  tallyVote3,
  type ArmMetrics,
  type AttributionPrequentialArm,
} from './prequential.js';
import { VOTE3_AUTO_APPLY_MIN_VOTES, VOTE3_SUGGEST_MIN_VOTES } from '../serve.js';
import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import { USER_ORGANIZED_ITEM } from '../../feedback/events.js';
import type { AcceptedEvent } from '../../sync/causal.js';
import {
  buildAttributionV1State,
  domainDiscriminativeness,
  NEUTRAL_DISCRIMINATIVENESS,
} from '../state.js';

// ---- synthetic vault fixture builders ---------------------------------

let seq = 0;
const resetSeq = (): void => {
  seq = 0;
};

const timelineEvent = (
  url: string,
  title: string,
  atMs: number,
  sessionId?: string,
): AcceptedEvent => {
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
      ...(sessionId === undefined ? {} : { tabSessionId: sessionId }),
    },
    acceptedAtMs: atMs,
  };
};

const organizeEvent = (url: string, ws: string, atMs: number): AcceptedEvent => {
  seq += 1;
  return {
    clientEventId: `org-${seq}`,
    dot: { replicaId: 'r1', seq },
    deps: {},
    aggregateId: `canonical-url:${url}`,
    type: USER_ORGANIZED_ITEM,
    payload: {
      payloadVersion: 1,
      itemKind: 'canonical-url',
      itemId: url,
      action: 'move',
      toContainer: ws,
    },
    acceptedAtMs: atMs,
  };
};

const armOf = (arms: readonly ArmMetrics[], arm: AttributionPrequentialArm): ArmMetrics => {
  const found = arms.find((a) => a.arm === arm);
  if (found === undefined) throw new Error(`missing arm ${arm}`);
  return found;
};

// ---- the hand-computable fixture --------------------------------------
//
// Four labels over two workstreams (both tail: wsX has 3, wsY has 1, both
// < HEAD_WORKSTREAM_LABEL_THRESHOLD). Titles/sessions arrive as timeline
// events BEFORE the labels. Traced by hand in the design notes:
//
//   L1 A→wsX  : empty prior ⇒ every arm predicts NOTHING (abstain/miss)
//   L2 B→wsX  : prior={A→wsX,"alpha alpha topic",s1} ⇒
//               recency=wsX HIT · majority=wsX HIT · title=wsX HIT ·
//               vote4=wsX HIT · v1=wsX HIT
//   L3 C→wsY  : "beta beta subject", no overlap/session with prior ⇒
//               recency=wsX MISS · majority=wsX MISS · title=abstain MISS ·
//               vote4=wsX(recency-only) MISS · v1=abstain MISS
//   L4 D→wsX  : "alpha alpha topic", s1 ⇒
//               recency=wsY MISS · majority=wsX HIT · title=wsX HIT ·
//               vote4=wsX HIT · v1=wsX HIT
//
// Tally (n=4):
//   v1       : top1 2/4, abstain 2/4 (L1,L3), prec@sug 2/2=1.0
//   title    : top1 2/4, abstain 2/4 (L1,L3), prec@sug 2/2=1.0
//   recency  : top1 1/4 (L2), abstain 1/4 (L1), prec@sug 1/3
//   majority : top1 2/4 (L2,L4), abstain 1/4 (L1), prec@sug 2/3
//   vote4    : top1 2/4 (L2,L4), abstain 1/4 (L1), prec@sug 2/3
const handComputableEvents = (): readonly AcceptedEvent[] => {
  resetSeq();
  return [
    timelineEvent('https://a.example/1', 'alpha alpha topic', 1, 's1'),
    timelineEvent('https://b.example/1', 'alpha alpha topic', 2, 's1'),
    timelineEvent('https://c.example/1', 'beta beta subject', 3, 's2'),
    timelineEvent('https://d.example/1', 'alpha alpha topic', 4, 's1'),
    organizeEvent('https://a.example/1', 'wsX', 10),
    organizeEvent('https://b.example/1', 'wsX', 11),
    organizeEvent('https://c.example/1', 'wsY', 12),
    organizeEvent('https://d.example/1', 'wsX', 13),
  ];
};

describe('runAttributionPrequential — hand-computable fixture', () => {
  it('re-derives the label set and buckets head/tail from final counts', () => {
    const report = runAttributionPrequential(handComputableEvents());
    expect(report.labelCount).toBe(4);
    expect(report.distinctWorkstreamCount).toBe(2);
    // Both workstreams are tail (< threshold).
    expect(report.headWorkstreamCount).toBe(0);
    expect(report.tailWorkstreamCount).toBe(2);
    expect(report.headLabelCount).toBe(0);
    expect(report.tailLabelCount).toBe(4);
    expect(report.arms.map((a) => a.arm)).toEqual([...ATTRIBUTION_PREQUENTIAL_ARMS]);
  });

  it('v1 abstains on this tiny corpus: the plain-overlap count is under the gate', () => {
    // With the score-based evidence gate (MIN_SUGGEST_SCORE = 14, calibrated to
    // the REAL ~33-workstream vault), the v1 arm's plain title-overlap COUNT
    // must clear the floor. On this fixture the only self-match ("alpha alpha
    // topic") sums an overlap of ~2 (two distinct terms carried by one prior
    // member), well under the floor, so v1 abstains on all four labels. This is
    // the correct consequence of the abstention-first gate, not a regression:
    // the simple arms below (which do NOT use the gate) still produce their
    // hand-traced numbers unchanged. A gate-clearing v1 trace on a realistically
    // -scaled corpus is exercised in the head-with-distractors test and, at full
    // scale, the prequential CLI. Both v1 combiners (weighted-sum and cascade)
    // abstain identically here — the cascade's domain/recency fallback tiers are
    // also below the gate on this corpus.
    const report = runAttributionPrequential(handComputableEvents());
    for (const armName of ['v1', 'v1-cascade'] as const) {
      const arm = armOf(report.arms, armName);
      expect(arm.top1Hits).toBe(0);
      expect(arm.abstentions).toBe(4);
      expect(arm.abstainRate).toBeCloseTo(1.0, 10);
      // All labels are tail.
      expect(arm.tailLabelCount).toBe(4);
      expect(arm.headLabelCount).toBe(0);
    }
  });

  it('scores title-lexical alone: 2/4 top-1, 2/4 abstain, 100% precision', () => {
    const report = runAttributionPrequential(handComputableEvents());
    const arm = armOf(report.arms, 'title-lexical');
    expect(arm.top1Hits).toBe(2);
    expect(arm.abstentions).toBe(2);
    expect(arm.precisionWhenSuggesting).toBeCloseTo(1.0, 10);
  });

  it('scores recency alone: 1/4 top-1, 1/4 abstain', () => {
    const report = runAttributionPrequential(handComputableEvents());
    const arm = armOf(report.arms, 'recency');
    expect(arm.top1Hits).toBe(1);
    expect(arm.abstentions).toBe(1);
    expect(arm.precisionWhenSuggesting).toBeCloseTo(1 / 3, 6);
  });

  it('scores majority-class: 2/4 top-1, 1/4 abstain', () => {
    const report = runAttributionPrequential(handComputableEvents());
    const arm = armOf(report.arms, 'majority');
    expect(arm.top1Hits).toBe(2);
    expect(arm.abstentions).toBe(1);
    expect(arm.precisionWhenSuggesting).toBeCloseTo(2 / 3, 6);
  });

  it('scores the 4-signal vote baseline: 2/4 top-1, 1/4 abstain', () => {
    const report = runAttributionPrequential(handComputableEvents());
    const arm = armOf(report.arms, 'vote4');
    expect(arm.top1Hits).toBe(2);
    expect(arm.abstentions).toBe(1);
    expect(arm.precisionWhenSuggesting).toBeCloseTo(2 / 3, 6);
  });

  it('vote3 (servable) matches vote4 on this hub-free fixture', () => {
    // No aggregator-hub domains here (a/b/c/d.example are single-workstream on
    // asserted labels ⇒ high discriminativeness), so the gated domain vote
    // votes identically to vote4's unconditional one, and dropping the session
    // vote changes nothing on this trace. vote3 must reproduce vote4 exactly.
    const report = runAttributionPrequential(handComputableEvents());
    const vote3 = armOf(report.arms, 'vote3');
    const vote4 = armOf(report.arms, 'vote4');
    expect(vote3.top1Hits).toBe(vote4.top1Hits);
    expect(vote3.abstentions).toBe(vote4.abstentions);
    expect(vote3.top1Hits).toBe(2);
    expect(vote3.abstentions).toBe(1);
  });
});

// ---- no-peeking guarantee ---------------------------------------------

describe('runAttributionPrequential — no peeking', () => {
  it('a title that only appears AFTER a label is not used to score that label', () => {
    // Label L happens at t=10; the title for its URL is only observed at
    // t=20. The prequential title join must NOT see that late title, so v1
    // must score with no title (⇒ abstain), not with the leaked title.
    resetSeq();
    const events: AcceptedEvent[] = [
      // Give wsX a prior member so v1 COULD match a title if it leaked.
      timelineEvent('https://seed.example/1', 'quantum entanglement physics', 1, 'sSeed'),
      organizeEvent('https://seed.example/1', 'wsX', 5),
      // The label under test at t=10 — its title arrives only at t=20.
      organizeEvent('https://late.example/1', 'wsX', 10),
      timelineEvent('https://late.example/1', 'quantum entanglement physics', 20, 'sLate'),
    ];
    // Must not throw the no-peeking assertion.
    const report = runAttributionPrequential(events);
    // L(seed) at t=5: empty prior ⇒ v1 abstains. L(late) at t=10: title not
    // yet observed ⇒ v1 sees no title ⇒ no lexical match ⇒ abstains too.
    const v1 = armOf(report.arms, 'v1');
    expect(v1.labelCount).toBe(2);
    // Both abstain (seed: empty prior; late: no title-at-time ⇒ no signal).
    expect(v1.abstentions).toBe(2);
    expect(v1.top1Hits).toBe(0);
  });

  it('folds strictly in acceptance-time order regardless of input order', () => {
    // Shuffle the fixture; the report must be identical to the sorted run
    // because the harness sorts by acceptance time internally.
    const ordered = runAttributionPrequential(handComputableEvents());
    const shuffled = [...handComputableEvents()].reverse();
    const shuffledReport = runAttributionPrequential(shuffled);
    expect(shuffledReport.arms.map((a) => a.top1Hits)).toEqual(
      ordered.arms.map((a) => a.top1Hits),
    );
    expect(shuffledReport.labelCount).toBe(ordered.labelCount);
  });
});

// ---- head/tail bucketing ----------------------------------------------

describe('runAttributionPrequential — head/tail bucketing', () => {
  it('routes labels of a >=threshold workstream into the head bucket', () => {
    resetSeq();
    const events: AcceptedEvent[] = [];
    let t = 1;
    // Distractor workstreams (one member each, disjoint junk terms) filed
    // first. They give the head workstream's title terms real cross-workstream
    // IDF so the v1 evidence gate (MIN_SUGGEST_SCORE) can be cleared — on a
    // single-workstream corpus every term's IDF collapses and v1 would abstain
    // regardless of head/tail. This mirrors the real ~33-workstream vault the
    // gate is calibrated against.
    const distractorCount = 8;
    for (let d = 0; d < distractorCount; d += 1) {
      events.push(
        timelineEvent(
          `https://dd${d}.example/1`,
          `distractorword${d} fillerword${d} junktoken${d}`,
          t,
          `sd${d}`,
        ),
      );
      t += 1;
    }
    // A head workstream: HEAD_WORKSTREAM_LABEL_THRESHOLD + 1 labels, each with
    // a shared distinctive title so title-lexical keeps matching.
    const headCount = HEAD_WORKSTREAM_LABEL_THRESHOLD + 1;
    for (let i = 0; i < headCount; i += 1) {
      const url = `https://head.example/${i}`;
      events.push(timelineEvent(url, 'distributed consensus raft protocol', t, `sh${i}`));
      t += 1;
    }
    // One tail label with an unrelated title.
    events.push(timelineEvent('https://tail.example/1', 'gardening compost soil', t, 'st'));
    t += 1;
    // Now the labels, in order, at increasing times.
    for (let d = 0; d < distractorCount; d += 1) {
      events.push(organizeEvent(`https://dd${d}.example/1`, `wsd${d}`, t));
      t += 1;
    }
    for (let i = 0; i < headCount; i += 1) {
      events.push(organizeEvent(`https://head.example/${i}`, 'wsHead', t));
      t += 1;
    }
    events.push(organizeEvent('https://tail.example/1', 'wsTail', t));

    const report = runAttributionPrequential(events);
    // wsHead is the only >=threshold workstream; the distractors + wsTail are
    // all single-label tail workstreams.
    expect(report.headWorkstreamCount).toBe(1);
    expect(report.tailWorkstreamCount).toBe(distractorCount + 1);
    expect(report.headLabelCount).toBe(headCount);
    expect(report.tailLabelCount).toBe(distractorCount + 1);
    const v1 = armOf(report.arms, 'v1');
    expect(v1.headLabelCount).toBe(headCount);
    expect(v1.tailLabelCount).toBe(distractorCount + 1);
    // Once the head workstream has accumulated enough members carrying the
    // shared "distributed consensus raft protocol" terms, the plain-overlap
    // COUNT for a matching visit clears the evidence gate — so head top-1 must
    // be strictly positive.
    expect(v1.head).toBeGreaterThan(0);
  });
});

// ---- evidence-gate threshold curve ------------------------------------

describe('runV1ThresholdCurve', () => {
  it('trades top-1 coverage for abstention as the gate rises (monotone)', () => {
    // Build a small realistically-shaped corpus: a head workstream whose
    // members repeat a distinctive multi-term title, filed first with
    // distractors, then queried by a matching self-title. At a low gate the
    // scorer suggests (some top-1); at a very high gate it abstains on
    // everything. The curve must be monotone non-increasing in top-1 and
    // non-decreasing in abstention.
    resetSeq();
    const events: AcceptedEvent[] = [];
    let t = 1;
    for (let d = 0; d < 6; d += 1) {
      events.push(timelineEvent(`https://z${d}.example/1`, `junk${d} filler${d} token${d}`, t, `sz${d}`));
      t += 1;
    }
    const n = HEAD_WORKSTREAM_LABEL_THRESHOLD + 3;
    for (let i = 0; i < n; i += 1) {
      events.push(timelineEvent(`https://h.example/${i}`, 'distributed consensus raft protocol log', t, `sh${i}`));
      t += 1;
    }
    for (let d = 0; d < 6; d += 1) {
      events.push(organizeEvent(`https://z${d}.example/1`, `wsz${d}`, t));
      t += 1;
    }
    for (let i = 0; i < n; i += 1) {
      events.push(organizeEvent(`https://h.example/${i}`, 'wsHead', t));
      t += 1;
    }

    const curve = runV1ThresholdCurve(events, [0, 5, 1000]);
    expect(curve).toHaveLength(3);
    // Monotone non-increasing top-1, non-decreasing abstention.
    expect(curve[0]!.top1).toBeGreaterThanOrEqual(curve[1]!.top1);
    expect(curve[1]!.top1).toBeGreaterThanOrEqual(curve[2]!.top1);
    expect(curve[0]!.abstainRate).toBeLessThanOrEqual(curve[1]!.abstainRate);
    expect(curve[1]!.abstainRate).toBeLessThanOrEqual(curve[2]!.abstainRate);
    // A very high gate abstains on everything.
    expect(curve[2]!.abstainRate).toBeCloseTo(1.0, 6);
    expect(curve[2]!.top1).toBeCloseTo(0, 6);
  });
});

// ---- vote3: the SERVABLE arm (M6) -------------------------------------

describe('vote3 — servable arm equivalence + hub gating', () => {
  it('gatedDomainWorkstream withholds the domain vote on a below-neutral hub', () => {
    // Build a state where an aggregator hub (news.ycombinator.com — in the
    // coarse-multi-topic listed-prior set) has filed labels spread across two
    // workstreams, so its learned discriminativeness sits below neutral. The
    // gated domain vote must return null there (B1/B4 firing on the serve path),
    // even though a raw domain-majority argmax would return a workstream.
    resetSeq();
    const events: AcceptedEvent[] = [
      timelineEvent('https://news.ycombinator.com/item?id=1', 'thread one', 1, 's1'),
      timelineEvent('https://news.ycombinator.com/item?id=2', 'thread two', 2, 's2'),
      organizeEvent('https://news.ycombinator.com/item?id=1', 'wsAlpha', 10),
      organizeEvent('https://news.ycombinator.com/item?id=2', 'wsBeta', 11),
    ];
    const state = buildAttributionV1State(events);
    // The hub is below neutral discriminativeness (listed-prior + 2-way spread).
    const discrim = domainDiscriminativeness(state, 'news.ycombinator.com');
    expect(discrim.discriminativeness).toBeLessThan(NEUTRAL_DISCRIMINATIVENESS);
    // So the gated domain vote is WITHHELD — the aggregator hub cannot cast a
    // domain vote even though a raw argmax (wsAlpha, the lexicographically-first
    // of the tied pair) exists.
    expect(gatedDomainWorkstream(state, 'news.ycombinator.com')).toBeNull();
    // A single-workstream domain, by contrast, is fully discriminative and DOES
    // cast its vote.
    const single = buildAttributionV1State([
      organizeEvent('https://rust-lang.org/a', 'wsRust', 20),
      organizeEvent('https://rust-lang.org/b', 'wsRust', 21),
    ]);
    expect(gatedDomainWorkstream(single, 'rust-lang.org')).toBe('wsRust');
  });

  it('vote3 beats vote4 when the hub domain vote is a wrong vote (gate suppresses it)', () => {
    // The scenario the gated domain vote fixes: a dispersed aggregator hub whose
    // domain-majority argmax points at the WRONG workstream for a fresh visit
    // whose TITLE clearly matches the right one. At the probe:
    //   - title vote  = wsRust     (its member carries the probe's terms)
    //   - domain vote = wsHubHeavy  (the hub's ungated argmax — WRONG)
    //   - recency     = wsHubHeavy  (the last label before the probe was a hub
    //                                label ⇒ recency also points at the hub)
    // vote4 (ungated) tallies wsHubHeavy 2 : wsRust 1 ⇒ WRONG. vote3 withholds
    // the hub domain vote, leaving wsRust 1 : wsHubHeavy 1 (recency) — tie broken
    // by priority title > recency ⇒ wsRust ⇒ RIGHT. So vote3 gets the probe that
    // vote4 misses.
    resetSeq();
    const events: AcceptedEvent[] = [];
    let t = 1;
    // Seed distractor workstreams so title terms have cross-workstream context.
    for (let d = 0; d < 4; d += 1) {
      events.push(timelineEvent(`https://d${d}.example/1`, `junk${d} filler${d}`, t, `sd${d}`));
      t += 1;
    }
    // wsRust member whose title carries the probe's terms (observed early, so a
    // later hub visit with the same title matches wsRust on the title vote).
    events.push(timelineEvent('https://d0.example/2', 'distributed consensus raft', t, 'sr'));
    t += 1;
    // The hub: labels concentrated on wsHubHeavy (the argmax) plus one on
    // wsOther, so the hub is dispersed (below-neutral) but its argmax is
    // wsHubHeavy. Observed before their labels.
    for (let i = 0; i < 4; i += 1) {
      events.push(
        timelineEvent(`https://news.ycombinator.com/item?id=h${i}`, `hubword${i}`, t, `sh${i}`),
      );
      t += 1;
    }
    events.push(
      timelineEvent('https://news.ycombinator.com/item?id=o1', 'other topic here', t, 'so'),
    );
    t += 1;
    // The PROBE visit: a hub URL whose title matches wsRust, filed to wsRust.
    events.push(
      timelineEvent(
        'https://news.ycombinator.com/item?id=probe',
        'distributed consensus raft',
        t,
        'sp',
      ),
    );
    t += 1;

    // Labels, in time order. wsRust and wsOther first, then the hub-heavy block
    // LAST before the probe so recency points at wsHubHeavy at probe time.
    for (let d = 0; d < 4; d += 1) {
      events.push(organizeEvent(`https://d${d}.example/1`, `wsd${d}`, t));
      t += 1;
    }
    events.push(organizeEvent('https://d0.example/2', 'wsRust', t));
    t += 1;
    events.push(organizeEvent('https://news.ycombinator.com/item?id=o1', 'wsOther', t));
    t += 1;
    for (let i = 0; i < 4; i += 1) {
      events.push(organizeEvent(`https://news.ycombinator.com/item?id=h${i}`, 'wsHubHeavy', t));
      t += 1;
    }
    // The probe label: the true target is wsRust (title match), NOT the hub
    // argmax wsHubHeavy. Recency now points at wsHubHeavy (last label).
    events.push(
      organizeEvent('https://news.ycombinator.com/item?id=probe', 'wsRust', t),
    );

    const report = runAttributionPrequential(events);
    const vote3 = armOf(report.arms, 'vote3');
    const vote4 = armOf(report.arms, 'vote4');
    // vote3 must score at least as many top-1 as vote4 (the gate never hurts on
    // this fixture) AND strictly more (it gets the probe right where the hub
    // domain vote drags vote4 off the title-correct answer).
    expect(vote3.top1Hits).toBeGreaterThanOrEqual(vote4.top1Hits);
    expect(vote3.top1Hits).toBeGreaterThan(vote4.top1Hits);
  });

  it('tallyVote3 breaks ties by title > domain > recency then id', () => {
    // Three distinct single-vote signals ⇒ 3-way tie at 1 vote each; title wins
    // by priority.
    expect(tallyVote3({ title: 'wsT', domain: 'wsD', recency: 'wsR' })).toEqual({
      workstreamId: 'wsT',
      votes: 1,
    });
    // Two signals agree ⇒ that workstream wins with 2 votes (the >= 2 tier).
    expect(tallyVote3({ title: 'wsX', domain: 'wsX', recency: 'wsR' })).toEqual({
      workstreamId: 'wsX',
      votes: 2,
    });
    // Unanimous ⇒ 3 votes (the auto-apply tier).
    expect(tallyVote3({ title: 'wsX', domain: 'wsX', recency: 'wsX' })).toEqual({
      workstreamId: 'wsX',
      votes: 3,
    });
    // All null ⇒ no winner.
    expect(tallyVote3({ title: null, domain: null, recency: null })).toEqual({
      workstreamId: null,
      votes: 0,
    });
  });

  it('gatedDomainWorkstream returns null for a null domain', () => {
    // Sanity: no domain ⇒ no domain vote (used by serve.ts for un-parseable urls).
    expect(gatedDomainWorkstream(buildAttributionV1State([]), null)).toBeNull();
  });
});

// ---- vote3 SERVED numbers: the doctrine-rule-10 read-back (F2/F5) ------
//
// A synthetic label set exercising title+domain+recency agreement across enough
// labels to produce a STABLE top1 and a monotone vote-count precision curve.
// This is the in-test proof the serve.ts default-flip (default 'vote3', gated
// on ">= 0.40 top1 on the eval harness") and the auto-apply precision bar rest
// on — replacing the hand-run 45.9% live-vault number with a CI'd absolute
// floor on a fixture whose numbers the test itself asserts.
//
// Shape: WS_COUNT single-workstream domains, each accruing MEMBERS_PER_WS labels
// that share a distinctive per-workstream title. Every domain is fully
// discriminative (single workstream ⇒ gated domain vote fires), and after the
// first member of a workstream is filed, subsequent same-workstream labels get:
//   - title vote  (shared distinctive terms → that workstream)
//   - domain vote  (single-workstream domain → that workstream)
//   - recency vote  IF the previous label was the same workstream.
// We file each workstream's members in a contiguous block so within a block the
// recency vote aligns on the 2nd..Mth member ⇒ 3 votes (auto-apply tier). The
// FIRST member of each block has an empty/led-astray prior ⇒ fewer votes. This
// yields a high but not perfect top1 and a genuine >=3-vote precision tier.
const votedFixtureEvents = (
  wsCount: number,
  membersPerWs: number,
): readonly AcceptedEvent[] => {
  resetSeq();
  const events: AcceptedEvent[] = [];
  let t = 1;
  // Observe all titles first (timeline before labels), then file in blocks.
  const plan: { url: string; ws: string; domain: string; title: string }[] = [];
  for (let w = 0; w < wsCount; w += 1) {
    const domain = `ws${w}.example`;
    const ws = `wsN${w}`;
    const title = `topicword${w} subjectword${w} themeword${w}`;
    for (let m = 0; m < membersPerWs; m += 1) {
      plan.push({ url: `https://${domain}/${m}`, ws, domain, title });
    }
  }
  for (const p of plan) {
    events.push(timelineEvent(p.url, p.title, t, `s${t}`));
    t += 1;
  }
  // File each workstream's block contiguously so recency aligns within a block.
  for (const p of plan) {
    events.push(organizeEvent(p.url, p.ws, t));
    t += 1;
  }
  return events;
};

describe('vote3 SERVED numbers — eval read-back (F2/F5)', () => {
  it('reproduces >= 0.40 top1 on a fixture vault AND beats vote4 (the default-flip guard)', () => {
    // 6 workstreams × 6 members = 36 labels. Enough that the top1 is stable and
    // not an artifact of a 4-label hand trace. The vote arm should clear the
    // 0.40 bar the serve.ts default cites, and match-or-beat vote4 (the frozen
    // baseline the servable arm must not regress below).
    const report = runAttributionPrequential(votedFixtureEvents(6, 6));
    const vote3 = armOf(report.arms, 'vote3');
    const vote4 = armOf(report.arms, 'vote4');
    expect(report.labelCount).toBe(36);
    // The absolute floor the serve.ts default-flip comment claims (>= 40%).
    expect(vote3.top1).toBeGreaterThanOrEqual(0.4);
    // The servable arm must not regress below the frozen 4-signal baseline.
    expect(vote3.top1).toBeGreaterThanOrEqual(vote4.top1);
  });

  it('the vote-count curve backs the SERVED ladder: precision rises with votes, auto-apply tier is high-precision', () => {
    const curve = runVote3VoteCountCurve(votedFixtureEvents(6, 6));
    // One point per configured tier (1, 2, 3).
    expect(curve.map((p) => p.minVotes)).toEqual([1, 2, 3]);
    const at = (minVotes: number) => {
      const p = curve.find((c) => c.minVotes === minVotes);
      if (p === undefined) throw new Error(`missing curve point ${minVotes}`);
      return p;
    };
    // Coverage is monotone NON-INCREASING as the bar rises (a stricter tier can
    // only cover fewer labels).
    expect(at(1).coverage).toBeGreaterThanOrEqual(at(2).coverage);
    expect(at(2).coverage).toBeGreaterThanOrEqual(at(3).coverage);
    // Precision is monotone NON-DECREASING as the bar rises (more agreement =
    // more reliable) — the tradeoff the served ladder exploits.
    expect(at(1).precisionWhenSuggesting).toBeLessThanOrEqual(at(2).precisionWhenSuggesting);
    expect(at(2).precisionWhenSuggesting).toBeLessThanOrEqual(at(3).precisionWhenSuggesting);
    // The SUGGEST tier (>= VOTE3_SUGGEST_MIN_VOTES) is the coverage tier: it
    // covers (nearly) every label.
    expect(at(VOTE3_SUGGEST_MIN_VOTES).coverage).toBeGreaterThan(0.9);
    // The AUTO-APPLY tier (>= VOTE3_AUTO_APPLY_MIN_VOTES) is the high-precision
    // conservative tier the user's "don't be wrong" bar rides on. On this
    // clean single-workstream-domain fixture the unanimous tier is ~perfect;
    // assert it clears the ~0.6 auto-apply bar the serve.ts comment names.
    expect(at(VOTE3_AUTO_APPLY_MIN_VOTES).precisionWhenSuggesting).toBeGreaterThanOrEqual(0.6);
    // And the auto-apply tier actually fires on some labels (a non-empty tier —
    // the "file a neighbor, then the fresh visit auto-applies" behaviour).
    expect(at(VOTE3_AUTO_APPLY_MIN_VOTES).suggestedCount).toBeGreaterThan(0);
  });
});

// ---- verdict rule -----------------------------------------------------

describe('buildPrequentialVerdict', () => {
  const baseArm = (arm: AttributionPrequentialArm, over: Partial<ArmMetrics>): ArmMetrics => ({
    arm,
    top1: 0,
    top3: 0,
    head: 0,
    tail: 0,
    abstainRate: 0,
    precisionWhenSuggesting: 0,
    labelCount: 100,
    top1Hits: 0,
    top3Hits: 0,
    abstentions: 0,
    headLabelCount: 0,
    tailLabelCount: 0,
    ...over,
  });

  const reportWith = (v1: Partial<ArmMetrics>, vote: Partial<ArmMetrics>) => ({
    labelCount: 100,
    distinctWorkstreamCount: 10,
    headWorkstreamCount: 2,
    tailWorkstreamCount: 8,
    headLabelCount: 40,
    tailLabelCount: 60,
    headLabelTotal: 40,
    tailLabelTotal: 60,
    arms: [baseArm('v1', v1), baseArm('vote4', vote)],
  });

  it('beats-baseline when v1 top-1 exceeds vote by >= 2pts', () => {
    const v = buildPrequentialVerdict(reportWith({ top1: 0.5 }, { top1: 0.46 }) as never);
    expect(v.verdict).toBe('beats-baseline');
  });

  it('matches-baseline-better-abstention within 2pts at high precision + base-rate abstention', () => {
    const v = buildPrequentialVerdict(
      reportWith(
        { top1: 0.46, precisionWhenSuggesting: 0.65, abstainRate: 0.6 },
        { top1: 0.46 },
      ) as never,
    );
    expect(v.verdict).toBe('matches-baseline-better-abstention');
  });

  it('loses within 2pts when precision-when-suggesting is below 60%', () => {
    const v = buildPrequentialVerdict(
      reportWith(
        { top1: 0.46, precisionWhenSuggesting: 0.5, abstainRate: 0.6 },
        { top1: 0.46 },
      ) as never,
    );
    expect(v.verdict).toBe('loses');
  });

  it('loses when v1 top-1 trails the vote by more than 2pts', () => {
    const v = buildPrequentialVerdict(
      reportWith({ top1: 0.4, precisionWhenSuggesting: 0.9, abstainRate: 0.8 }, { top1: 0.46 }) as never,
    );
    expect(v.verdict).toBe('loses');
  });
});

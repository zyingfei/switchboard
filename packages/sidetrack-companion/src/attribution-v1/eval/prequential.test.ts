import { describe, expect, it } from 'vitest';

import {
  ATTRIBUTION_PREQUENTIAL_ARMS,
  HEAD_WORKSTREAM_LABEL_THRESHOLD,
  buildPrequentialVerdict,
  runAttributionPrequential,
  type ArmMetrics,
  type AttributionPrequentialArm,
} from './prequential.js';
import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import { USER_ORGANIZED_ITEM } from '../../feedback/events.js';
import type { AcceptedEvent } from '../../sync/causal.js';

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

  it('v1 abstains on this tiny corpus: the evidence gate needs real cross-workstream IDF', () => {
    // With the score-based evidence gate (MIN_SUGGEST_SCORE), the v1 arm's
    // absolute score must clear a floor calibrated to the REAL ~33-workstream
    // vault. On this 2-workstream synthetic fixture the cross-workstream IDF
    // collapses (every term sits in ~all workstreams ⇒ near-zero weight), so
    // even the L2/L4 self-matches score well under the floor and v1 abstains
    // on all four. This is the correct consequence of the gate, not a
    // regression: the simple arms below (which do NOT use the gate) still
    // produce their hand-traced numbers unchanged. A gate-clearing v1 trace on
    // a realistically-scaled corpus is exercised in the head-with-distractors
    // test and, at full scale, the prequential CLI.
    const report = runAttributionPrequential(handComputableEvents());
    const v1 = armOf(report.arms, 'v1');
    expect(v1.top1Hits).toBe(0);
    expect(v1.abstentions).toBe(4);
    expect(v1.abstainRate).toBeCloseTo(1.0, 10);
    // All labels are tail.
    expect(v1.tailLabelCount).toBe(4);
    expect(v1.headLabelCount).toBe(0);
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
    // Once the head workstream has members AND the corpus has enough
    // workstreams to give its terms real IDF, its title-lexical family clears
    // the evidence gate — so head top-1 must be strictly positive.
    expect(v1.head).toBeGreaterThan(0);
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

import { afterEach, describe, expect, it } from 'bun:test';

import { foldDeclineMemory } from './declineMemory.js';
import type { GuessLaneResult } from './guessLanes.js';
import {
  applyLaneCorroboration,
  LANE_CORROBORATION_ENV,
  LANE_CORROBORATION_GATE_MARK,
  LANE_CORROBORATION_MIN_PRECISION,
  LANE_CORROBORATION_MIN_SAMPLES,
  type ResultForCorroboration,
} from './laneCorroboration.js';
import type { LanePrequentialSummary } from './lanePrequential.js';
import type { ResolverCandidate } from './resolver.js';
import { USER_ORGANIZED_ITEM } from '../feedback/events.js';
import type { AcceptedEvent } from '../sync/causal.js';

// LANE CORROBORATION — the keystone promotion (review E1).
//
// THE LIVE CASE these fixtures reproduce: six structural lanes typed-empty, the
// content lane and the ai lane BOTH naming the same workstream, fusion ranking
// that same workstream first, and the decision held at
// `corroboration 1 < 2 (similarity-dominant)`. The right answer was present,
// computed and displayed — and could not reach the gate.
//
// The tests pin all three directions: it promotes on that shape WITH measured
// evidence; it refuses without it; and it cannot file anything either way.

const AGREEING_LANES: readonly GuessLaneResult[] = [
  { lane: 'graph', candidates: [], emptyReason: 'no graph path' },
  { lane: 'similarity', candidates: [], emptyReason: 'no similar pages' },
  { lane: 'topic', candidates: [], emptyReason: 'no topic membership' },
  { lane: 'title', candidates: [], emptyReason: 'junk title' },
  { lane: 'domain', candidates: [], emptyReason: 'domain unseen' },
  { lane: 'recency', candidates: [], emptyReason: 'no recent filing' },
  {
    lane: 'content',
    candidates: [{ workstreamId: 'ws-ai', score: 0.62, why: '8 matches · gist' }],
  },
  { lane: 'ai', candidates: [{ workstreamId: 'ws-ai', score: 0.71, why: '6 matches' }] },
];

// A similarity-dominant, thin-agreement candidate: exactly the shape that lifts
// requiredCorroboration from 1 to 2 in policy.ts and then fails it at 1.
// rawFusionLogit is above the balanced suggest bar (1.2) and its margin over the
// runner-up clears 0.35, so corroboration is the ONLY failing gate.
const heldCandidate = (over: Partial<ResolverCandidate> = {}): ResolverCandidate => ({
  workstreamId: 'ws-ai',
  pprScore: 0,
  simTopScore: 0.9,
  simMeanScore: 0.7,
  simAgreement: 0.1,
  simMargin: 0.6,
  clusterPosterior: 0,
  corroborationCount: 1,
  rawFusionLogit: 1.6,
  dominantSource: 'similarity',
  reasons: [{ source: 'similarity', summary: '1 similar page', anchors: [] }],
  ...over,
});

const held = (over: Partial<ResultForCorroboration> = {}): ResultForCorroboration => ({
  policyMode: 'balanced',
  decision: {
    action: 'inbox',
    margin: 1.6,
    gate: { reason: 'corroboration', detail: 'corroboration 1 < 2 (similarity-dominant)' },
  },
  fusedCandidates: [heldCandidate()],
  lanes: AGREEING_LANES,
  ...over,
});

const calibration = (
  precision: number,
  n: number,
  over: Partial<LanePrequentialSummary> = {},
): LanePrequentialSummary => ({
  scored: n * 2,
  window: 500,
  unscored: 0,
  rawPredictionRows: n * 2,
  legacyPredictionRows: 0,
  eligibleOpportunities: n,
  outcomesObserved: n,
  outcomesJoined: n,
  outcomeJoinCoverage: 1,
  status: 'ok',
  lanes: [
    { lane: 'content', n, hits: Math.round(precision * n), precision },
    { lane: 'ai', n, hits: Math.round(precision * n), precision },
  ],
  ...over,
});

const GOOD = calibration(0.72, 41);

let seq = 0;
const declineEvent = (itemId: string): AcceptedEvent => {
  seq += 1;
  return {
    type: USER_ORGANIZED_ITEM,
    acceptedAtMs: 1_000,
    dot: { replicaId: 'r1', seq },
    payload: {
      payloadVersion: 1,
      itemKind: 'canonical-url',
      itemId,
      action: 'move',
      toContainer: null,
    },
  } as unknown as AcceptedEvent;
};

const on = (): void => {
  process.env[LANE_CORROBORATION_ENV] = '1';
};

afterEach(() => {
  delete process.env[LANE_CORROBORATION_ENV];
});

describe('lane corroboration — (a) the Kimi shape, with earned evidence', () => {
  it('promotes the held pick to a suggestion when content + ai agree', () => {
    on();
    const out = applyLaneCorroboration(held(), {
      canonicalUrl: 'https://arxiv.org/abs/2510.26692',
      calibration: GOOD,
    });
    expect(out.decision.action).toBe('suggest');
    expect(out.decision.workstreamId).toBe('ws-ai');
  });

  it('states the lift and the evidence behind it in the gate detail', () => {
    on();
    const detail =
      applyLaneCorroboration(held(), { canonicalUrl: 'u', calibration: GOOD }).decision.gate
        ?.detail ?? '';
    // The arithmetic: 1 fusion channel + 1 lane agreement ≥ the lifted bar of 2.
    expect(detail).toContain('corroboration 1+1');
    expect(detail).toContain('≥ 2');
    // The provenance: which lanes, how well they have done, on how many cases.
    expect(detail).toContain('content+ai');
    expect(detail).toContain('p=0.72');
    expect(detail).toContain('n=41');
    // And the machine-detectable mark.
    expect(detail).toContain(LANE_CORROBORATION_GATE_MARK);
  });

  it('leaves fusedCandidates VERBATIM — corroborationCount is a fusion fact', () => {
    on();
    const input = held();
    const out = applyLaneCorroboration(input, { canonicalUrl: 'u', calibration: GOOD });
    expect(out.fusedCandidates).toBe(input.fusedCandidates);
    // The candidate still reports the 1 evidence channel that actually fired.
    expect(out.fusedCandidates[0]?.corroborationCount).toBe(1);
  });

  it('re-decides through the real policy — a pick failing the LOGIT floor stays held', () => {
    on();
    // Corroboration was reported first, but this pick is also under the 1.2
    // balanced suggest bar. Lifting corroboration cannot rescue it.
    const input = held({
      fusedCandidates: [heldCandidate({ rawFusionLogit: 0.4 })],
    });
    expect(applyLaneCorroboration(input, { canonicalUrl: 'u', calibration: GOOD })).toBe(input);
  });

  it('a pick failing the MARGIN too stays held', () => {
    on();
    const input = held({
      fusedCandidates: [
        heldCandidate({ rawFusionLogit: 1.6 }),
        heldCandidate({ workstreamId: 'ws-other', rawFusionLogit: 1.5 }),
      ],
      decision: {
        action: 'inbox',
        margin: 0.1,
        gate: { reason: 'corroboration', detail: 'corroboration 1 < 2 (similarity-dominant)' },
      },
    });
    expect(applyLaneCorroboration(input, { canonicalUrl: 'u', calibration: GOOD })).toBe(input);
  });
});

describe('lane corroboration — (b) it cannot file anything', () => {
  it('caps at suggest even when the pick clears the auto bar', () => {
    on();
    // rawFusionLogit 3.5 is above the balanced auto bar (2.8); with the lift,
    // decideAttribution alone would return 'auto-apply'.
    const input = held({ fusedCandidates: [heldCandidate({ rawFusionLogit: 3.5 })] });
    const out = applyLaneCorroboration(input, { canonicalUrl: 'u', calibration: GOOD });
    expect(out.decision.action).toBe('suggest');
    expect(out.decision.gate?.detail).toContain('capped at suggest');
    expect(out.decision.gate?.reason).toBe('cleared-suggest');
  });

  it('never produces auto-apply for ANY lane precision the gate admits', () => {
    on();
    for (const precision of [0.6, 0.75, 0.9, 1]) {
      const out = applyLaneCorroboration(
        held({ fusedCandidates: [heldCandidate({ rawFusionLogit: 9 })] }),
        { canonicalUrl: 'u', calibration: calibration(precision, 500) },
      );
      expect(out.decision.action).not.toBe('auto-apply');
    }
  });
});

describe('lane corroboration — (c) armed by default, with an instant kill switch', () => {
  it('is armed with the flag unset once measured evidence earns promotion', () => {
    const input = held();
    expect(applyLaneCorroboration(input, { canonicalUrl: 'u', calibration: GOOD })).not.toBe(input);
  });

  it("only explicit '0' and 'false' disable it", () => {
    const input = held();
    for (const value of ['0', 'false']) {
      process.env[LANE_CORROBORATION_ENV] = value;
      expect(applyLaneCorroboration(input, { canonicalUrl: 'u', calibration: GOOD })).toBe(input);
    }
    for (const value of ['1', 'true', 'yes', 'on', '']) {
      process.env[LANE_CORROBORATION_ENV] = value;
      expect(applyLaneCorroboration(input, { canonicalUrl: 'u', calibration: GOOD })).not.toBe(
        input,
      );
    }
  });
});

describe('lane corroboration — (d) it self-gates on MEASURED precision', () => {
  it('refuses when there is no calibration at all (fresh vault)', () => {
    on();
    const input = held();
    expect(applyLaneCorroboration(input, { canonicalUrl: 'u' })).toBe(input);
    expect(applyLaneCorroboration(input, { canonicalUrl: 'u', calibration: null })).toBe(input);
  });

  it('refuses below the precision floor, admits at it', () => {
    on();
    const input = held();
    const below = LANE_CORROBORATION_MIN_PRECISION - 0.01;
    expect(
      applyLaneCorroboration(input, { canonicalUrl: 'u', calibration: calibration(below, 100) }),
    ).toBe(input);
    expect(
      applyLaneCorroboration(input, {
        canonicalUrl: 'u',
        calibration: calibration(LANE_CORROBORATION_MIN_PRECISION, 100),
      }),
    ).not.toBe(input);
  });

  it('refuses below the sample floor, admits at it', () => {
    on();
    const input = held();
    expect(
      applyLaneCorroboration(input, {
        canonicalUrl: 'u',
        calibration: calibration(0.9, LANE_CORROBORATION_MIN_SAMPLES - 1),
      }),
    ).toBe(input);
    expect(
      applyLaneCorroboration(input, {
        canonicalUrl: 'u',
        calibration: calibration(0.9, LANE_CORROBORATION_MIN_SAMPLES),
      }),
    ).not.toBe(input);
  });

  it('gates on the WEAKER lane — a great content lane cannot carry a bad ai lane', () => {
    on();
    const lopsided: LanePrequentialSummary = {
      scored: 100,
      window: 500,
      unscored: 0,
      rawPredictionRows: 100,
      legacyPredictionRows: 0,
      eligibleOpportunities: 50,
      outcomesObserved: 50,
      outcomesJoined: 50,
      outcomeJoinCoverage: 1,
      status: 'ok',
      lanes: [
        { lane: 'content', n: 60, hits: 57, precision: 0.95 },
        { lane: 'ai', n: 60, hits: 18, precision: 0.3 },
      ],
    };
    const input = held();
    expect(applyLaneCorroboration(input, { canonicalUrl: 'u', calibration: lopsided })).toBe(input);
  });

  it('refuses when the measurement lane is switched off', () => {
    on();
    const input = held();
    expect(
      applyLaneCorroboration(input, {
        canonicalUrl: 'u',
        calibration: { ...GOOD, status: 'off' },
      }),
    ).toBe(input);
  });
});

describe('lane corroboration — (e) it fires only on the exact shape', () => {
  it('ignores every gate reason other than corroboration', () => {
    on();
    for (const reason of [
      'no-candidates',
      'below-suggest',
      'margin-tie',
      'regret-budget',
      'cleared-suggest',
      'cleared-auto',
    ] as const) {
      const input = held({
        decision: { action: 'inbox', margin: 1.6, gate: { reason, detail: 'x' } },
      });
      expect(applyLaneCorroboration(input, { canonicalUrl: 'u', calibration: GOOD })).toBe(input);
    }
  });

  it('needs BOTH lanes — one lane alone is not agreement', () => {
    on();
    const contentOnly = held({
      lanes: [
        ...AGREEING_LANES.slice(0, 6),
        {
          lane: 'content',
          candidates: [{ workstreamId: 'ws-ai', score: 0.62, why: '8 matches' }],
        },
        { lane: 'ai', candidates: [], emptyReason: 'no gist for this page yet' },
      ],
    });
    expect(applyLaneCorroboration(contentOnly, { canonicalUrl: 'u', calibration: GOOD })).toBe(
      contentOnly,
    );
  });

  it('needs the lanes to agree with EACH OTHER', () => {
    on();
    const disagreeing = held({
      lanes: [
        ...AGREEING_LANES.slice(0, 6),
        { lane: 'content', candidates: [{ workstreamId: 'ws-ai', score: 0.62, why: 'x' }] },
        { lane: 'ai', candidates: [{ workstreamId: 'ws-other', score: 0.71, why: 'y' }] },
      ],
    });
    expect(applyLaneCorroboration(disagreeing, { canonicalUrl: 'u', calibration: GOOD })).toBe(
      disagreeing,
    );
  });

  it('may corroborate fusion, never RE-RANK it', () => {
    on();
    // Both lanes agree on ws-other; fusion's top pick is ws-ai. The lanes do not
    // get to promote a workstream fusion did not rank first.
    const reranking = held({
      lanes: [
        ...AGREEING_LANES.slice(0, 6),
        { lane: 'content', candidates: [{ workstreamId: 'ws-other', score: 0.9, why: 'x' }] },
        { lane: 'ai', candidates: [{ workstreamId: 'ws-other', score: 0.9, why: 'y' }] },
      ],
    });
    expect(applyLaneCorroboration(reranking, { canonicalUrl: 'u', calibration: GOOD })).toBe(
      reranking,
    );
  });

  it('does nothing when fusion produced no candidates (that is the fallback’s job)', () => {
    on();
    const empty = held({ fusedCandidates: [] });
    expect(applyLaneCorroboration(empty, { canonicalUrl: 'u', calibration: GOOD })).toBe(empty);
  });

  it('does nothing when lanes are absent (guess lanes off)', () => {
    on();
    const { lanes: _dropped, ...withoutLanes } = held();
    expect(applyLaneCorroboration(withoutLanes, { canonicalUrl: 'u', calibration: GOOD })).toBe(
      withoutLanes,
    );
  });
});

describe('lane corroboration — (f) a decline vetoes it', () => {
  it('refuses to promote a URL the user declined, however good the evidence', () => {
    on();
    const declines = foldDeclineMemory([declineEvent('https://a.test/declined')]);
    const input = held();
    expect(
      applyLaneCorroboration(input, {
        canonicalUrl: 'https://a.test/declined',
        calibration: GOOD,
        declines,
      }),
    ).toBe(input);
  });

  it('still promotes a different URL under the same decline memory', () => {
    on();
    const declines = foldDeclineMemory([declineEvent('https://a.test/declined')]);
    const out = applyLaneCorroboration(held(), {
      canonicalUrl: 'https://a.test/other',
      calibration: GOOD,
      declines,
    });
    expect(out.decision.action).toBe('suggest');
  });
});

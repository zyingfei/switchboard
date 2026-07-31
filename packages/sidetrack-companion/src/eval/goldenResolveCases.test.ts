import { afterEach, describe, expect, it } from 'bun:test';

import type { ConnectionsSnapshot } from '../connections/types.js';
import { USER_ORGANIZED_ITEM } from '../feedback/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { appendAiLane, appendContentLane } from '../tabsession/contentLane.js';
import { foldDeclineMemory } from '../tabsession/declineMemory.js';
import type { GuessLaneResult } from '../tabsession/guessLanes.js';
import { applyLaneCorroboration, LANE_CORROBORATION_ENV } from '../tabsession/laneCorroboration.js';
import { applyLaneFallbackGuess, type ResultWithFusion } from '../tabsession/laneFallback.js';
import type { LanePrequentialSummary } from '../tabsession/lanePrequential.js';
import { decideAttribution } from '../tabsession/policy.js';
import type { ResolverCandidate } from '../tabsession/resolver.js';

// GOLDEN RESOLVE SET — the ranking-QUALITY regression net (review G9 / E8).
//
// "Resolve *plumbing* is well-tested; resolve *quality* is not. The Binance
// mis-ranking, the false-friend, the hub-magnet class — each was caught by a
// human eyeball on a live page."
//
// This file is the frozen set. Every case below is a REAL failure observed on
// the live dogfood vault, reduced to the smallest fixture that still exhibits
// it, and asserted on WHICH WORKSTREAM RANKS FIRST — not on shapes, not on
// counts. A shape assertion would have passed on every one of these bugs.
//
// The live golden set (up to 200 real (page → filed workstream) pairs replayed
// against the in-process resolver) is `goldenResolveSet.ts` — it cannot be
// committed because it contains the user's actual URLs. THIS file is its
// committed, synthetic, CI-runnable half: the four failure CLASSES, frozen.
//
// Adding a case: reduce the live failure to a fixture, name the incident and
// its date, and assert the workstream that must win. If you cannot state which
// workstream should have won, the case is not ready to be a golden case.

// ---- shared fixtures ---------------------------------------------------

const SNAPSHOT = { nodes: [], edges: [] } as unknown as ConnectionsSnapshot;
const BARE_RESULT = { lanes: [] as GuessLaneResult[] };

interface Hit {
  entityId: string;
  canonicalUrl: string;
  title: string;
  bodyIndexed: number;
}

// A recall store that answers both retrieval arms with the same fixed hits, so
// a case controls exactly what the lane sees.
const storeReturning = (hits: readonly Hit[]) => ({
  store: {
    vectorBackendAvailable: true,
    queryByCanonicalUrl: () => [],
    queryVector: () => hits,
    queryFts: () => hits,
  } as never,
  embed: async (): Promise<Float32Array> => new Float32Array([1, 0, 0]),
});

const depsFor = (hits: readonly Hit[], byUrl: Record<string, string>) => {
  const { store, embed } = storeReturning(hits);
  return {
    store,
    embed,
    embedderUsable: true,
    guessLanesEnabled: true,
    lookupWorkstreamByUrl: (url: string): string | undefined => byUrl[url],
  };
};

const EMPTY_STRUCTURAL_LANES: readonly GuessLaneResult[] = [
  { lane: 'graph', candidates: [], emptyReason: 'no graph path' },
  { lane: 'similarity', candidates: [], emptyReason: 'no similar pages' },
  { lane: 'topic', candidates: [], emptyReason: 'no topic membership' },
  { lane: 'title', candidates: [], emptyReason: 'junk title' },
  { lane: 'domain', candidates: [], emptyReason: 'domain unseen' },
  { lane: 'recency', candidates: [], emptyReason: 'no recent filing' },
];

const candidate = (over: Partial<ResolverCandidate> = {}): ResolverCandidate => ({
  workstreamId: 'ws-unset',
  pprScore: 0,
  simTopScore: 0,
  simMeanScore: 0,
  simAgreement: 0,
  simMargin: 0,
  clusterPosterior: 0,
  corroborationCount: 1,
  rawFusionLogit: 0,
  dominantSource: 'similarity',
  reasons: [],
  ...over,
});

let organizedSeq = 0;
const declineOf = (canonicalUrl: string): AcceptedEvent => {
  organizedSeq += 1;
  return {
    type: USER_ORGANIZED_ITEM,
    acceptedAtMs: 1_000,
    dot: { replicaId: 'golden', seq: organizedSeq },
    payload: {
      payloadVersion: 1,
      itemKind: 'canonical-url',
      itemId: canonicalUrl,
      action: 'move',
      toContainer: null,
    },
  } as unknown as AcceptedEvent;
};

const calibrated = (precision: number, n: number): LanePrequentialSummary => ({
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
});

afterEach(() => {
  delete process.env[LANE_CORROBORATION_ENV];
  delete process.env['SIDETRACK_LANE_HUB_GUARD'];
});

// ---- G1. hub-magnet ----------------------------------------------------

describe('golden case 1 — hub-magnet (aggregator votes must never win)', () => {
  // LIVE: 2026-07-28, "Binance makes Bitcoin options writing available". A
  // nine-word features-only gist embedded into generic-tech space; the lane's
  // winning votes came from "Deno 2.8 | Hacker News"-class pages that happen to
  // be FILED under 'ai'. So 'ai' beat the genuinely relevant crypto workstream,
  // which was carried by one topical PoW page. Same family as the 2026-07-10
  // false-friend (an HN AI-video page mis-filed to linux-security).
  const HUB_HITS: readonly Hit[] = [
    {
      entityId: 'hn1',
      canonicalUrl: 'https://news.ycombinator.com/item?id=1',
      title: 'Deno 2.8 | Hacker News',
      bodyIndexed: 0,
    },
    {
      entityId: 'hn2',
      canonicalUrl: 'https://news.ycombinator.com/item?id=2',
      title: 'Show HN: a thing | Hacker News',
      bodyIndexed: 0,
    },
    {
      entityId: 'hn3',
      canonicalUrl: 'https://news.ycombinator.com/item?id=3',
      title: 'Ask HN: another thing | Hacker News',
      bodyIndexed: 0,
    },
    {
      entityId: 'pow1',
      canonicalUrl: 'https://example.test/pow-verification',
      title: 'PoW verification and computation',
      bodyIndexed: 1,
    },
  ];
  const BY_URL: Record<string, string> = {
    'https://news.ycombinator.com/item?id=1': 'ws-ai',
    'https://news.ycombinator.com/item?id=2': 'ws-ai',
    'https://news.ycombinator.com/item?id=3': 'ws-ai',
    'https://example.test/pow-verification': 'ws-crypto',
  };

  it('the TOPICAL page decides the content lane, outnumbered 3-to-1 by hub pages', async () => {
    const out = await appendContentLane(
      BARE_RESULT,
      {
        canonicalUrl: 'https://binance.example/options',
        snapshot: SNAPSHOT,
        title: 'Binance makes Bitcoin options writing available',
        gist: 'Exchange adds options writing for retail accounts.',
      },
      depsFor(HUB_HITS, BY_URL),
    );
    const lane = out.lanes.find((entry) => entry.lane === 'content');
    // THE assertion: which workstream ranks first.
    expect(lane?.candidates[0]?.workstreamId).toBe('ws-crypto');
    expect(lane?.candidates.map((c) => c.workstreamId)).not.toContain('ws-ai');
  });

  it('the AI lane (gist-only query) obeys the same guard', async () => {
    const out = await appendAiLane(
      BARE_RESULT,
      {
        canonicalUrl: 'https://binance.example/options',
        snapshot: SNAPSHOT,
        title: 'Binance makes Bitcoin options writing available',
        gist: 'Exchange adds options writing for retail accounts.',
      },
      depsFor(HUB_HITS, BY_URL),
    );
    expect(out.lanes.find((entry) => entry.lane === 'ai')?.candidates[0]?.workstreamId).toBe(
      'ws-crypto',
    );
  });

  it('WITHOUT the guard the hub wins — this is the bug, pinned', async () => {
    process.env['SIDETRACK_LANE_HUB_GUARD'] = '0';
    const out = await appendContentLane(
      BARE_RESULT,
      {
        canonicalUrl: 'https://binance.example/options',
        snapshot: SNAPSHOT,
        title: 'T',
        gist: 'g',
      },
      depsFor(HUB_HITS, BY_URL),
    );
    expect(out.lanes.find((entry) => entry.lane === 'content')?.candidates[0]?.workstreamId).toBe(
      'ws-ai',
    );
  });

  it('says the guard ate everything rather than claiming nothing matched', async () => {
    const out = await appendContentLane(
      BARE_RESULT,
      {
        canonicalUrl: 'https://binance.example/options',
        snapshot: SNAPSHOT,
        title: 'T',
        gist: 'g',
      },
      depsFor(HUB_HITS.slice(0, 3), BY_URL),
    );
    const lane = out.lanes.find((entry) => entry.lane === 'content');
    expect(lane?.candidates ?? []).toHaveLength(0);
    expect(lane?.emptyReason).toContain('aggregator');
  });
});

// ---- G2. corroboration-hold --------------------------------------------

describe('golden case 2 — corroboration-hold (the right answer, held at 1 < 2)', () => {
  // LIVE: 2026-07-29, the Kimi Linear arXiv page. Six structural lanes empty,
  // content + ai both naming 'ws-attention', fusion ranking it first, decision
  // `held: corroboration 1 < 2 (similarity-dominant)`. The right answer was
  // present, computed and displayed, and could not reach the gate.
  const KIMI_LANES: readonly GuessLaneResult[] = [
    ...EMPTY_STRUCTURAL_LANES,
    {
      lane: 'content',
      candidates: [{ workstreamId: 'ws-attention', score: 0.66, why: '8 matches · gist' }],
    },
    {
      lane: 'ai',
      candidates: [{ workstreamId: 'ws-attention', score: 0.71, why: '6 matches' }],
    },
  ];
  // Thin-agreement, similarity-dominant: policy lifts requiredCorroboration to 2.
  const KIMI_TOP = candidate({
    workstreamId: 'ws-attention',
    simTopScore: 0.9,
    simMeanScore: 0.7,
    simAgreement: 0.1,
    simMargin: 0.6,
    corroborationCount: 1,
    rawFusionLogit: 1.6,
  });
  const KIMI = {
    policyMode: 'balanced' as const,
    decision: decideAttribution([KIMI_TOP], 'balanced'),
    fusedCandidates: [KIMI_TOP],
    lanes: KIMI_LANES,
  };

  it('the incumbent policy holds it — the case exists', () => {
    // Pinned from the REAL decideAttribution, not a hand-written fixture, so
    // this case tracks the policy rather than a snapshot of it.
    expect(KIMI.decision.action).toBe('inbox');
    expect(KIMI.decision.gate.reason).toBe('corroboration');
    expect(KIMI.decision.gate.detail).toContain('corroboration 1 < 2');
  });

  it('stays held with the promotion kill switch OFF', () => {
    process.env[LANE_CORROBORATION_ENV] = '0';
    const out = applyLaneCorroboration(KIMI, {
      canonicalUrl: 'https://arxiv.org/abs/2510.26692',
      calibration: calibrated(0.72, 41),
    });
    expect(out.decision.action).toBe('inbox');
  });

  it('with the promotion ON and the lanes MEASURED, ws-attention is suggested', () => {
    process.env[LANE_CORROBORATION_ENV] = '1';
    const out = applyLaneCorroboration(KIMI, {
      canonicalUrl: 'https://arxiv.org/abs/2510.26692',
      calibration: calibrated(0.72, 41),
    });
    expect(out.decision.action).toBe('suggest');
    expect(out.decision.workstreamId).toBe('ws-attention');
  });

  it('with the promotion ON but the lanes UNMEASURED, it stays held', () => {
    process.env[LANE_CORROBORATION_ENV] = '1';
    for (const calibration of [null, calibrated(0.72, 3), calibrated(0.2, 400)]) {
      const out = applyLaneCorroboration(KIMI, {
        canonicalUrl: 'https://arxiv.org/abs/2510.26692',
        calibration,
      });
      expect(out.decision.action).toBe('inbox');
    }
  });

  it('never promotes past suggest, whatever the logit', () => {
    process.env[LANE_CORROBORATION_ENV] = '1';
    const loud = { ...KIMI, fusedCandidates: [{ ...KIMI_TOP, rawFusionLogit: 9 }] };
    const out = applyLaneCorroboration(loud, {
      canonicalUrl: 'https://arxiv.org/abs/2510.26692',
      calibration: calibrated(0.95, 400),
    });
    expect(out.decision.action).toBe('suggest');
  });
});

// ---- G3. lane-fallback shape -------------------------------------------

describe('golden case 3 — lane-fallback shape (structural lanes empty, content+ai only)', () => {
  // LIVE: 2026-07-27, "AI Zero-Day Vulnerability Remediation and Security |
  // JFrog". Six structural lanes typed-empty, content lane holding three ranked
  // workstreams from real page-text retrieval, a gist generated and saved — and
  // a card reading "In workstream: — / No confident pick".
  const JFROG_LANES: readonly GuessLaneResult[] = [
    ...EMPTY_STRUCTURAL_LANES,
    {
      lane: 'content',
      candidates: [
        { workstreamId: 'ws-ai', score: 0.62, why: '8 matches · gist' },
        { workstreamId: 'ws-linux-security', score: 0.55, why: '5 matches · gist' },
        { workstreamId: 'ws-interview', score: 0.31, why: '2 matches · gist' },
      ],
    },
    {
      lane: 'ai',
      candidates: [
        { workstreamId: 'ws-linux-security', score: 0.71, why: '6 matches' },
        { workstreamId: 'ws-ai', score: 0.4, why: '3 matches' },
      ],
    },
  ];
  const JFROG: ResultWithFusion = {
    decision: {
      action: 'inbox',
      margin: 0,
      gate: { reason: 'no-candidates', detail: 'no candidates reached fusion' },
    },
    fusedCandidates: [],
    lanes: JFROG_LANES,
  };

  it('ranks the TWO-LANE agreement first, not the loudest single lane', () => {
    const out = applyLaneFallbackGuess(JFROG, {
      canonicalUrl: 'https://jfrog.example/ai-zero-day',
    });
    // ws-linux-security: both lanes, best score 0.71. ws-ai: both lanes, 0.62.
    // ws-interview: content only at 0.31 — agreement beats score.
    expect(out.fusedCandidates.map((c) => c.workstreamId)).toEqual([
      'ws-linux-security',
      'ws-ai',
      'ws-interview',
    ]);
  });

  it('cannot file: action, workstreamId and margin pass through verbatim', () => {
    const out = applyLaneFallbackGuess(JFROG, {
      canonicalUrl: 'https://jfrog.example/ai-zero-day',
    });
    expect(out.decision.action).toBe('inbox');
    expect(out.decision.workstreamId).toBeUndefined();
    expect(out.decision.margin).toBe(0);
    expect(out.decision.gate?.reason).toBe('no-candidates');
  });

  it('never touches a resolve where fusion HAD an opinion', () => {
    const withFusion = {
      ...JFROG,
      fusedCandidates: [candidate({ workstreamId: 'ws-real', rawFusionLogit: 0.8 })],
    };
    expect(
      applyLaneFallbackGuess(withFusion, { canonicalUrl: 'https://jfrog.example/ai-zero-day' })
        .fusedCandidates[0]?.workstreamId,
    ).toBe('ws-real');
  });
});

// ---- G4. decline-respected ---------------------------------------------

describe('golden case 4 — decline-respected (a refusal is an answer)', () => {
  // LIVE: 2026-07-29. resolveUrlAttribution settles a declined URL with gate
  // `no-candidates` / `user declined — not in any stream` and NO candidates —
  // the exact shape the lane-fallback fires on. So the fallback re-suggested a
  // workstream on a page whose own verdict line said the user had refused one.
  const DECLINED_URL = 'https://example.test/declined-page';
  const DECLINES = foldDeclineMemory([declineOf(DECLINED_URL)]);
  const SETTLED = {
    policyMode: 'balanced' as const,
    decision: {
      action: 'inbox' as const,
      margin: 0,
      gate: { reason: 'no-candidates' as const, detail: 'user declined — not in any stream' },
    },
    fusedCandidates: [] as readonly ResolverCandidate[],
    lanes: [
      ...EMPTY_STRUCTURAL_LANES,
      { lane: 'content' as const, candidates: [{ workstreamId: 'ws-ai', score: 0.62, why: '8' }] },
      { lane: 'ai' as const, candidates: [{ workstreamId: 'ws-ai', score: 0.71, why: '6' }] },
    ],
  };

  it('no fallback pick is synthesized for the declined URL', () => {
    const out = applyLaneFallbackGuess(SETTLED, {
      canonicalUrl: DECLINED_URL,
      declines: DECLINES,
    });
    expect(out.fusedCandidates).toHaveLength(0);
    expect(out.decision.gate?.detail).toBe('user declined — not in any stream');
  });

  it('the corroboration promotion is vetoed for the declined URL too', () => {
    process.env[LANE_CORROBORATION_ENV] = '1';
    const heldTop = candidate({
      workstreamId: 'ws-ai',
      simTopScore: 0.9,
      simMeanScore: 0.7,
      simAgreement: 0.1,
      simMargin: 0.6,
      rawFusionLogit: 1.6,
    });
    const held = {
      ...SETTLED,
      decision: decideAttribution([heldTop], 'balanced'),
      fusedCandidates: [heldTop],
    };
    const out = applyLaneCorroboration(held, {
      canonicalUrl: DECLINED_URL,
      calibration: calibrated(0.95, 400),
      declines: DECLINES,
    });
    expect(out.decision.action).toBe('inbox');
  });

  it('a page the user has NOT declined still gets its guess', () => {
    const out = applyLaneFallbackGuess(SETTLED, {
      canonicalUrl: 'https://example.test/some-other-page',
      declines: DECLINES,
    });
    expect(out.fusedCandidates[0]?.workstreamId).toBe('ws-ai');
  });

  it('filing the page later re-enables suggestions for it', () => {
    organizedSeq += 1;
    const filed = {
      type: USER_ORGANIZED_ITEM,
      acceptedAtMs: 5_000,
      dot: { replicaId: 'golden', seq: organizedSeq },
      payload: {
        payloadVersion: 1,
        itemKind: 'canonical-url',
        itemId: DECLINED_URL,
        action: 'move',
        toContainer: 'ws-ai',
      },
    } as unknown as AcceptedEvent;
    const declines = foldDeclineMemory([declineOf(DECLINED_URL), filed]);
    const out = applyLaneFallbackGuess(SETTLED, { canonicalUrl: DECLINED_URL, declines });
    expect(out.fusedCandidates[0]?.workstreamId).toBe('ws-ai');
  });
});

import { afterEach, describe, expect, it } from 'bun:test';

import {
  applyLaneFallbackGuess,
  LANE_FALLBACK_GATE_SUFFIX,
  LANE_FALLBACK_GUESS_ENV,
  LANE_FALLBACK_WHY_PREFIX,
  type ResultWithFusion,
} from './laneFallback.js';
import type { GuessLaneResult } from './guessLanes.js';
import type { ResolverCandidate } from './resolver.js';

// LANE FALLBACK — "returning cannot guess is absurd... should still return best
// guess on partial data".
//
// The shape under test is the live one (2026-07-27): the JFrog security page
// whose six STRUCTURAL lanes were all typed-empty, whose CONTENT lane held three
// ranked workstreams from real page-text retrieval, whose gist had been
// generated and saved — and whose card still read "In workstream: — / No
// confident pick", gate "held: no candidates reached fusion".
//
// The tests pin BOTH directions: it fills the pick on that shape, and it keeps
// its hands off everything else — most importantly any resolve where fusion
// itself produced a candidate.

// The six structural lanes, all typed-empty exactly as the live payload had
// them (typed emptiness: an empty lane always says WHY).
const EMPTY_STRUCTURAL_LANES: readonly GuessLaneResult[] = [
  { lane: 'graph', candidates: [], emptyReason: 'no graph path' },
  { lane: 'similarity', candidates: [], emptyReason: 'no similar pages' },
  { lane: 'topic', candidates: [], emptyReason: 'no topic membership' },
  { lane: 'title', candidates: [], emptyReason: 'no v1 state loaded' },
  { lane: 'domain', candidates: [], emptyReason: 'domain unseen' },
  { lane: 'recency', candidates: [], emptyReason: 'no recent filing' },
];

// The JFrog lanes: content named three workstreams; the gist-only 'ai' query
// landed on two of them. 'ai' is the corroborating lane — a workstream in BOTH
// is what the ranking must promote.
const JFROG_LANES: readonly GuessLaneResult[] = [
  ...EMPTY_STRUCTURAL_LANES,
  {
    lane: 'content',
    candidates: [
      { workstreamId: 'ws-ai', score: 0.62, why: '8 matches (Kimi Linear, RAG notes) · gist' },
      { workstreamId: 'ws-linux-security', score: 0.55, why: '5 matches (LSM, seccomp) · gist' },
      { workstreamId: 'ws-interview', score: 0.31, why: '2 matches (tech reading) · gist' },
    ],
  },
  {
    lane: 'ai',
    candidates: [
      { workstreamId: 'ws-linux-security', score: 0.71, why: '6 matches (CVE triage)' },
      { workstreamId: 'ws-ai', score: 0.4, why: '3 matches (model security)' },
    ],
  },
];

const resolution = (over: Partial<ResultWithFusion> = {}): ResultWithFusion => ({
  decision: {
    action: 'inbox',
    margin: 0,
    gate: { reason: 'no-candidates', detail: 'no candidates reached fusion' },
  },
  fusedCandidates: [],
  lanes: JFROG_LANES,
  ...over,
});

// A real fused candidate — the "fusion HAD an opinion" fixture.
const fusedCandidate = (over: Partial<ResolverCandidate> = {}): ResolverCandidate => ({
  workstreamId: 'ws-real',
  pprScore: 0.4,
  simTopScore: 0.3,
  simMeanScore: 0.2,
  simAgreement: 0.5,
  simMargin: 0.1,
  clusterPosterior: 0,
  corroborationCount: 1,
  rawFusionLogit: 0.82,
  dominantSource: 'ppr',
  reasons: [{ source: 'ppr', summary: 'graph 0.4', anchors: [] }],
  ...over,
});

afterEach(() => {
  delete process.env[LANE_FALLBACK_GUESS_ENV];
});

describe('lane-fallback guess — (a) the JFrog shape', () => {
  it('fills the empty pick from the content + ai lanes, ranked both-lanes-first', () => {
    const out = applyLaneFallbackGuess(resolution());
    // Three workstreams appear across the two lanes; all three are offered (the
    // cap is 3), with the pick — fusedCandidates[0] — the one BOTH lanes named
    // at the highest lane-native score.
    expect(out.fusedCandidates).toHaveLength(3);
    expect(out.fusedCandidates.map((candidate) => candidate.workstreamId)).toEqual([
      // in both lanes, best score 0.71
      'ws-linux-security',
      // in both lanes, best score 0.62
      'ws-ai',
      // content lane only — agreement beats score, so it ranks last despite
      // 0.31 being a real content hit
      'ws-interview',
    ]);
  });

  it('two-lane agreement outranks a higher single-lane score', () => {
    // Same lanes, but the content-only workstream now scores HIGHER (0.95) than
    // either corroborated one. Agreement is the primary key, so it still loses.
    const lanes: readonly GuessLaneResult[] = [
      ...EMPTY_STRUCTURAL_LANES,
      {
        lane: 'content',
        candidates: [
          { workstreamId: 'ws-loud', score: 0.95, why: '9 matches' },
          { workstreamId: 'ws-agreed', score: 0.2, why: '2 matches' },
        ],
      },
      { lane: 'ai', candidates: [{ workstreamId: 'ws-agreed', score: 0.25, why: '2 matches' }] },
    ];
    const out = applyLaneFallbackGuess(resolution({ lanes }));
    expect(out.fusedCandidates[0]?.workstreamId).toBe('ws-agreed');
    expect(out.fusedCandidates[0]?.corroborationCount).toBe(2);
    expect(out.fusedCandidates[1]?.workstreamId).toBe('ws-loud');
  });

  it('leaves the decision action, workstreamId and margin untouched — it can never file', () => {
    const input = resolution();
    const out = applyLaneFallbackGuess(input);
    expect(out.decision.action).toBe('inbox');
    expect(out.decision.action).toBe(input.decision.action);
    expect(out.decision.workstreamId).toBeUndefined();
    expect(out.decision.margin).toBe(0);
    // The gate REASON is preserved (fusion really did get no candidates); only
    // the free-text detail gains the disclosure suffix.
    expect(out.decision.gate?.reason).toBe('no-candidates');
    expect(out.decision.gate?.detail).toBe(
      `no candidates reached fusion${LANE_FALLBACK_GATE_SUFFIX}`,
    );
    // The input object is not mutated — the served copy is a new object.
    expect(input.fusedCandidates).toHaveLength(0);
  });

  it('marks every synthesized candidate as content-evidence-only and unconfirmed', () => {
    const out = applyLaneFallbackGuess(resolution());
    for (const candidate of out.fusedCandidates) {
      const summary = candidate.reasons[0]?.summary ?? '';
      expect(summary.startsWith(LANE_FALLBACK_WHY_PREFIX)).toBe(true);
      // No fusion channel dominated because no fusion ran.
      expect(candidate.dominantSource).toBe('none');
      // No evidence channel may claim a signal that never existed.
      expect(candidate.pprScore).toBe(0);
      expect(candidate.simTopScore).toBe(0);
      expect(candidate.clusterPosterior).toBe(0);
      // Scores stay lane-native [0,1] — never a fusion logit.
      expect(candidate.rawFusionLogit).toBeGreaterThanOrEqual(0);
      expect(candidate.rawFusionLogit).toBeLessThanOrEqual(1);
    }
    // The why names the contributing lane(s) so a reader can tell a two-lane
    // agreement from a lone content hit.
    expect(out.fusedCandidates[0]?.reasons[0]?.summary).toContain('content + ai');
    expect(out.fusedCandidates[2]?.reasons[0]?.summary).toContain('content lane');
  });

  it('lanes are left exactly as the disclosure had them', () => {
    const out = applyLaneFallbackGuess(resolution());
    expect(out.lanes).toEqual(JFROG_LANES);
  });
});

describe('lane-fallback guess — (b) the kill switch', () => {
  it('is a no-op when SIDETRACK_LANE_FALLBACK_GUESS=0', () => {
    process.env[LANE_FALLBACK_GUESS_ENV] = '0';
    const input = resolution();
    expect(applyLaneFallbackGuess(input)).toBe(input);
  });

  it("is a no-op for 'false' too, and ON for any other value (default ON)", () => {
    process.env[LANE_FALLBACK_GUESS_ENV] = 'false';
    const input = resolution();
    expect(applyLaneFallbackGuess(input)).toBe(input);
    process.env[LANE_FALLBACK_GUESS_ENV] = '1';
    expect(applyLaneFallbackGuess(input).fusedCandidates).toHaveLength(3);
    delete process.env[LANE_FALLBACK_GUESS_ENV];
    expect(applyLaneFallbackGuess(input).fusedCandidates).toHaveLength(3);
  });
});

describe('lane-fallback guess — (c) never overrides real fusion output', () => {
  it('leaves a result with ANY fused candidate untouched', () => {
    const input = resolution({ fusedCandidates: [fusedCandidate()] });
    expect(applyLaneFallbackGuess(input)).toBe(input);
  });

  it("leaves a 'corroboration'-gated held decision untouched", () => {
    // Candidates DID reach fusion and a policy gate held them — a different
    // story, already told honestly by the existing card. Even with an (already
    // impossible) empty fusedCandidates array, the gate reason alone declines.
    const input = resolution({
      decision: {
        action: 'inbox',
        margin: 0.1,
        gate: { reason: 'corroboration', detail: 'corroboration 1 < 2 (similarity-dominant)' },
      },
    });
    expect(applyLaneFallbackGuess(input)).toBe(input);
  });

  it('leaves every other gate reason untouched, and declines when the gate is ABSENT', () => {
    for (const reason of [
      'below-suggest',
      'margin-tie',
      'regret-budget',
      'cleared-suggest',
      'cleared-auto',
    ] as const) {
      const input = resolution({
        decision: { action: 'inbox', margin: 0, gate: { reason, detail: 'x' } },
      });
      expect(applyLaneFallbackGuess(input)).toBe(input);
    }
    // No gate at all (an older resolver path): we do not infer emptiness from a
    // missing field.
    const noGate = resolution({ decision: { action: 'inbox', margin: 0 } });
    expect(applyLaneFallbackGuess(noGate)).toBe(noGate);
  });
});

describe('lane-fallback guess — (d) nothing to guess from', () => {
  it('leaves the all-lanes-empty resolve untouched (no gist, nothing indexed)', () => {
    const input = resolution({
      lanes: [
        ...EMPTY_STRUCTURAL_LANES,
        { lane: 'content', candidates: [], emptyReason: 'recall store unavailable' },
        { lane: 'ai', candidates: [], emptyReason: 'no gist for this page yet' },
      ],
    });
    expect(applyLaneFallbackGuess(input)).toBe(input);
  });

  it('leaves it untouched when the six structural lanes are the ONLY lanes', () => {
    // Content lane disabled (SIDETRACK_CONTENT_LANE=0) ⇒ no lane 7/8 to draw on.
    const input = resolution({ lanes: EMPTY_STRUCTURAL_LANES });
    expect(applyLaneFallbackGuess(input)).toBe(input);
  });

  it('leaves it untouched when lanes are absent entirely (guess lanes off)', () => {
    const { lanes: _dropped, ...withoutLanes } = resolution();
    expect(applyLaneFallbackGuess(withoutLanes)).toBe(withoutLanes);
  });

  it('ignores the six structural lanes even when they DO carry candidates', () => {
    // A structural lane with a candidate is evidence fusion already saw and
    // judged insufficient — promoting it here would double-count it. Only the
    // query-time content/ai retrieval (which never reached fusion) qualifies.
    const input = resolution({
      lanes: [
        { lane: 'graph', candidates: [{ workstreamId: 'ws-graph', score: 0.9, why: 'edge' }] },
        ...EMPTY_STRUCTURAL_LANES.slice(1),
        { lane: 'content', candidates: [], emptyReason: 'recall store unavailable' },
        { lane: 'ai', candidates: [], emptyReason: 'no gist for this page yet' },
      ],
    });
    expect(applyLaneFallbackGuess(input)).toBe(input);
  });
});

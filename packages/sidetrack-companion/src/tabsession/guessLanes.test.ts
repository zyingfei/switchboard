import { afterEach, describe, expect, it } from 'vitest';

import {
  buildGuessLanes,
  GUESS_LANES_ENV,
  GUESS_LANE_ORDER,
  guessLanesEnabled,
  voteSignalsFor,
  type GuessLane,
  type GuessLaneResult,
  type GuessLaneVoteSignals,
} from './guessLanes.js';
import type { CandidateEvidence } from './fusion.js';
import {
  applyOrganizingObservation,
  createEmptyAttributionV1State,
  domainOfUrl,
  type AttributionV1State,
} from '../attribution-v1/state.js';

// ---- fixtures ---------------------------------------------------------

// A candidate-evidence row with all channels zeroed except the ones the test
// sets. corroborationCount is irrelevant to lane assembly (lanes read the RAW
// pre-filter channel scores), so it's left at 0.
const evidence = (
  workstreamId: string,
  channels: Partial<Pick<CandidateEvidence, 'pprScore' | 'simTopScore' | 'clusterPosterior' | 'simMatchedTerms'>>,
): CandidateEvidence => ({
  workstreamId,
  pprScore: channels.pprScore ?? 0,
  simTopScore: channels.simTopScore ?? 0,
  simMeanScore: 0,
  simAgreement: 0,
  simMargin: 0,
  ...(channels.simMatchedTerms === undefined ? {} : { simMatchedTerms: channels.simMatchedTerms }),
  clusterPosterior: channels.clusterPosterior ?? 0,
  corroborationCount: 0,
});

// A folded v1 state: file two rust-blog pages into wsRust so the title vote
// (title words "rust async") and the domain vote (blog.rust-lang.org — an
// UNLISTED, single-workstream domain ⇒ discriminative) both point at wsRust,
// and the recency vote (last filed) is wsRust. domainOfUrl strips www; the
// blog subdomain stays, and it is NOT a coarse-multi-topic prior domain.
const buildRustState = (): AttributionV1State => {
  const state = createEmptyAttributionV1State();
  applyOrganizingObservation(state, {
    workstreamId: 'wsRust',
    canonicalUrl: 'https://blog.rust-lang.org/a',
    title: 'rust release notes async runtime',
    atMs: 1000,
    provenance: 'asserted',
  });
  applyOrganizingObservation(state, {
    workstreamId: 'wsRust',
    canonicalUrl: 'https://blog.rust-lang.org/b',
    title: 'rust async update pinning',
    atMs: 2000,
    provenance: 'asserted',
  });
  return state;
};

// A state whose last-filed workstream is a HUB-domain filing: a single
// news.ycombinator.com page filed to wsNews. The domain is a coarse-multi-topic
// prior, so gatedDomainWorkstream withholds its vote (hub-gating) even though
// there IS a filing for it — the domain lane must say "too generic", not guess.
const buildHubState = (): AttributionV1State => {
  const state = createEmptyAttributionV1State();
  applyOrganizingObservation(state, {
    workstreamId: 'wsNews',
    canonicalUrl: 'https://news.ycombinator.com/item?id=1',
    title: 'some front page story',
    atMs: 5000,
    provenance: 'asserted',
  });
  return state;
};

const laneOf = (lanes: readonly GuessLaneResult[], lane: GuessLane): GuessLaneResult => {
  const found = lanes.find((entry) => entry.lane === lane);
  if (found === undefined) throw new Error(`lane ${lane} missing`);
  return found;
};

// ---- flag helper ------------------------------------------------------

describe('guessLanesEnabled', () => {
  const prev = process.env[GUESS_LANES_ENV];
  afterEach(() => {
    if (prev === undefined) delete process.env[GUESS_LANES_ENV];
    else process.env[GUESS_LANES_ENV] = prev;
  });

  it('defaults ON (absent env)', () => {
    delete process.env[GUESS_LANES_ENV];
    expect(guessLanesEnabled()).toBe(true);
  });

  it('is disabled by "0" and "false" only', () => {
    process.env[GUESS_LANES_ENV] = '0';
    expect(guessLanesEnabled()).toBe(false);
    process.env[GUESS_LANES_ENV] = 'false';
    expect(guessLanesEnabled()).toBe(false);
    process.env[GUESS_LANES_ENV] = '1';
    expect(guessLanesEnabled()).toBe(true);
    process.env[GUESS_LANES_ENV] = 'anything-else';
    expect(guessLanesEnabled()).toBe(true);
  });
});

// ---- lane shape -------------------------------------------------------

describe('buildGuessLanes', () => {
  it('always emits all six lanes in the fixed order', () => {
    const lanes = buildGuessLanes({ candidateEvidence: [] });
    expect(lanes.map((entry) => entry.lane)).toEqual([...GUESS_LANE_ORDER]);
    expect(lanes).toHaveLength(6);
  });

  it('every empty lane carries an emptyReason; populated lanes never do', () => {
    const state = buildRustState();
    const canonicalUrl = 'https://blog.rust-lang.org/c';
    const lanes = buildGuessLanes({
      candidateEvidence: [
        evidence('wsRust', { pprScore: 0.4, simTopScore: 0.8, clusterPosterior: 0.6 }),
      ],
      voteSignals: voteSignalsFor(state, canonicalUrl, 'rust async release'),
      nowMs: 2000 + 60 * 60 * 1000, // one hour after the last filing
    });
    for (const lane of lanes) {
      if (lane.candidates.length === 0) {
        expect(lane.emptyReason, `lane ${lane.lane} must state why it is empty`).toBeDefined();
        expect(lane.emptyReason!.length).toBeGreaterThan(0);
      } else {
        expect(lane.emptyReason, `lane ${lane.lane} populated ⇒ no emptyReason`).toBeUndefined();
      }
    }
  });

  it('new-thread shape: graph/similarity/topic empty with reasons; title/domain/recency populated when their signals exist', () => {
    const state = buildRustState();
    const canonicalUrl = 'https://blog.rust-lang.org/c';
    // NO graph evidence (brand-new thread) but the vote signals DO have opinions.
    const lanes = buildGuessLanes({
      candidateEvidence: [],
      voteSignals: voteSignalsFor(state, canonicalUrl, 'rust async release'),
      nowMs: 2000 + 2 * 60 * 60 * 1000,
    });

    // Graph channels: empty + typed reasons.
    for (const laneName of ['graph', 'similarity', 'topic'] as const) {
      const lane = laneOf(lanes, laneName);
      expect(lane.candidates).toHaveLength(0);
      expect(lane.emptyReason).toBeDefined();
    }

    // Title vote: "rust async" overlaps wsRust's folded titles ⇒ wsRust.
    const title = laneOf(lanes, 'title');
    expect(title.candidates).toHaveLength(1);
    expect(title.candidates[0]!.workstreamId).toBe('wsRust');
    expect(title.candidates[0]!.score).toBeGreaterThan(0);
    expect(title.candidates[0]!.score).toBeLessThanOrEqual(1);

    // Domain vote: blog.rust-lang.org is unlisted + single-workstream ⇒ wsRust.
    const domain = laneOf(lanes, 'domain');
    expect(domain.candidates).toHaveLength(1);
    expect(domain.candidates[0]!.workstreamId).toBe('wsRust');
    expect(domain.candidates[0]!.why).toContain('blog.rust-lang.org');

    // Recency vote: last filed workstream is wsRust; why renders the age.
    const recency = laneOf(lanes, 'recency');
    expect(recency.candidates).toHaveLength(1);
    expect(recency.candidates[0]!.workstreamId).toBe('wsRust');
    expect(recency.candidates[0]!.why).toMatch(/last active/);
  });

  it('graph/similarity/topic populate from the pre-filter evidence with why + matched terms', () => {
    const lanes = buildGuessLanes({
      candidateEvidence: [
        evidence('wsA', { pprScore: 0.3, simTopScore: 0.7, simMatchedTerms: ['cloudtrail', 'iam'], clusterPosterior: 0.5 }),
        evidence('wsB', { pprScore: 0.1 }),
      ],
    });
    const graph = laneOf(lanes, 'graph');
    expect(graph.candidates.map((c) => c.workstreamId)).toEqual(['wsA', 'wsB']);

    const similarity = laneOf(lanes, 'similarity');
    expect(similarity.candidates).toHaveLength(1);
    expect(similarity.candidates[0]!.workstreamId).toBe('wsA');
    expect(similarity.candidates[0]!.why).toContain('cloudtrail');

    const topic = laneOf(lanes, 'topic');
    expect(topic.candidates).toHaveLength(1);
    expect(topic.candidates[0]!.workstreamId).toBe('wsA');
  });

  it('normalization: scores clamped to 0..1, capped at 3 candidates, descending', () => {
    // Five graph candidates, one with an out-of-range pprScore (>1) that must
    // clamp; the lane keeps only the top 3 by score, descending.
    const lanes = buildGuessLanes({
      candidateEvidence: [
        evidence('ws1', { pprScore: 5 }), // clamps to 1
        evidence('ws2', { pprScore: 0.9 }),
        evidence('ws3', { pprScore: 0.8 }),
        evidence('ws4', { pprScore: 0.7 }),
        evidence('ws5', { pprScore: 0.6 }),
      ],
    });
    const graph = laneOf(lanes, 'graph');
    expect(graph.candidates).toHaveLength(3);
    expect(graph.candidates.map((c) => c.workstreamId)).toEqual(['ws1', 'ws2', 'ws3']);
    for (const candidate of graph.candidates) {
      expect(candidate.score).toBeGreaterThanOrEqual(0);
      expect(candidate.score).toBeLessThanOrEqual(1);
    }
    expect(graph.candidates[0]!.score).toBe(1); // clamped from 5
    // Descending order.
    expect(graph.candidates[0]!.score).toBeGreaterThanOrEqual(graph.candidates[1]!.score);
    expect(graph.candidates[1]!.score).toBeGreaterThanOrEqual(graph.candidates[2]!.score);
  });

  it('hub-gated domain yields emptyReason "too generic", never a garbage guess', () => {
    const state = buildHubState();
    const canonicalUrl = 'https://news.ycombinator.com/item?id=99';
    const lanes = buildGuessLanes({
      candidateEvidence: [],
      voteSignals: voteSignalsFor(state, canonicalUrl, 'front page'),
    });
    const domain = laneOf(lanes, 'domain');
    expect(domain.candidates).toHaveLength(0);
    expect(domain.emptyReason).toBeDefined();
    expect(domain.emptyReason).toContain('too generic');
    // Sanity: the hub filing DID set recency, so the recency lane is populated —
    // proving the domain lane's emptiness is the hub gate, not a missing state.
    expect(laneOf(lanes, 'recency').candidates).toHaveLength(1);
  });

  it('no vote signals (no state loaded) ⇒ the three vote lanes report typed emptiness', () => {
    const lanes = buildGuessLanes({
      candidateEvidence: [evidence('wsA', { pprScore: 0.5 })],
    });
    // Graph lane populates from evidence.
    expect(laneOf(lanes, 'graph').candidates).toHaveLength(1);
    // Vote lanes: empty with a "no attribution state loaded" reason.
    for (const laneName of ['title', 'domain', 'recency'] as const) {
      const lane = laneOf(lanes, laneName);
      expect(lane.candidates).toHaveLength(0);
      expect(lane.emptyReason).toContain('no attribution state loaded');
    }
  });

  it('title lane empty when the title has no folded-term overlap', () => {
    const state = buildRustState();
    const signals: GuessLaneVoteSignals = voteSignalsFor(
      state,
      'https://example.com/x',
      'entirely unrelated kubernetes helm chart',
    );
    const lanes = buildGuessLanes({ candidateEvidence: [], voteSignals: signals });
    const title = laneOf(lanes, 'title');
    expect(title.candidates).toHaveLength(0);
    expect(title.emptyReason).toBeDefined();
  });

  it('domainOfUrl sanity: voteSignalsFor derives the domain the domain lane keys on', () => {
    // Guards against a silent contract drift: the domain lane's hub-gate reads
    // the domain voteSignalsFor produced. Confirm it strips www and keeps host.
    expect(domainOfUrl('https://www.blog.rust-lang.org/a')).toBe('blog.rust-lang.org');
    const signals = voteSignalsFor(null, 'https://news.ycombinator.com/item', null);
    expect(signals.domain).toBe('news.ycombinator.com');
  });

  it('title lane why marks " · synthesized title" when the title was synthesized', () => {
    const state = buildRustState();
    const canonicalUrl = 'https://blog.rust-lang.org/c';
    // Same overlapping title, but flagged as synthesized (came from the
    // enrichment overlay, not a raw page title).
    const signals = voteSignalsFor(state, canonicalUrl, 'rust async release', true);
    expect(signals.titleSynthesized).toBe(true);
    const lanes = buildGuessLanes({ candidateEvidence: [], voteSignals: signals });
    const title = laneOf(lanes, 'title');
    expect(title.candidates).toHaveLength(1);
    expect(title.candidates[0]!.why).toContain('title words match');
    expect(title.candidates[0]!.why).toContain('· synthesized title');
  });

  it('title lane why has NO synthesized suffix for a real title', () => {
    const state = buildRustState();
    const canonicalUrl = 'https://blog.rust-lang.org/c';
    // Default (titleSynthesized false) — a real title.
    const signals = voteSignalsFor(state, canonicalUrl, 'rust async release');
    expect(signals.titleSynthesized).toBe(false);
    const lanes = buildGuessLanes({ candidateEvidence: [], voteSignals: signals });
    const title = laneOf(lanes, 'title');
    expect(title.candidates).toHaveLength(1);
    expect(title.candidates[0]!.why).not.toContain('synthesized title');
  });
});

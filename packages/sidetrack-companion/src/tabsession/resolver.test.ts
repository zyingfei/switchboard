import { afterEach, describe, expect, it } from 'vitest';

import type { ConnectionsSnapshot } from '../connections/types.js';
import type { ClosestVisitRanker } from '../connections/snapshot.js';
import { USER_ORGANIZED_ITEM } from '../feedback/events.js';
import {
  BROWSER_TIMELINE_OBSERVED,
  type BrowserTimelineObservedPayload,
} from '../timeline/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { createPprCache, runPPR, seedHash } from './causalPpr.js';
import { buildClusterEvidence } from './clusterEvidence.js';
import { buildEvidenceGraph } from './evidenceGraph.js';
import { fuseCandidates, type CandidateEvidence } from './fusion.js';
import { decideAttribution } from './policy.js';
import { projectTabSessions } from './projection.js';
import {
  inferredAttributionPayloadFromResolution,
  resolveAttribution,
  resolveThreadAttribution,
  resolveUrlAttribution,
} from './resolver.js';
import { buildSimilarityEvidence } from './similarity.js';

const snapshot = (
  nodeIds: readonly string[],
  edges: readonly {
    readonly kind: ConnectionsSnapshot['edges'][number]['kind'];
    readonly from: string;
    readonly to: string;
    readonly metadata?: Record<string, unknown>;
  }[],
): ConnectionsSnapshot => ({
  scope: {},
  nodes: nodeIds.map((id) => ({
    id,
    kind: id.startsWith('workstream:')
      ? 'workstream'
      : id.startsWith('tab-session:')
        ? 'tab-session'
        : id.startsWith('topic:')
          ? 'topic'
          : id.startsWith('visit-instance:')
            ? 'visit-instance'
            : 'timeline-visit',
    label: id,
    originReplicaIds: [],
    metadata: {},
  })),
  edges: edges.map((edge, index) => ({
    id: `edge:${String(index)}`,
    kind: edge.kind,
    fromNodeId: edge.from,
    toNodeId: edge.to,
    observedAt: '2026-05-10T10:00:00.000Z',
    producedBy: { source: 'event-log' },
    confidence: edge.kind === 'tab_session_in_workstream' ? 'asserted' : 'observed',
    ...(edge.metadata === undefined ? {} : { metadata: edge.metadata }),
  })),
  updatedAt: '2026-05-10T10:00:00.000Z',
  nodeCount: nodeIds.length,
  edgeCount: edges.length,
});

// A single-channel CandidateEvidence for the gate tests: zeros everywhere the
// caller does not override, with corroborationCount DERIVED exactly as the
// resolver derives it (ppr > 0.01, sim > 0, cluster > 0 each contribute one) so
// the fused pick's corroboration matches a real resolve rather than a magic
// number. The gate tests then read the ACTUAL fused logit rather than a
// hand-computed one, so a fusion-weight change re-derives the fixtures instead
// of silently breaking them.
const lone = (over: Partial<CandidateEvidence> & { readonly workstreamId: string }): CandidateEvidence => {
  const pprScore = over.pprScore ?? 0;
  const simTopScore = over.simTopScore ?? 0;
  const clusterPosterior = over.clusterPosterior ?? 0;
  return {
    workstreamId: over.workstreamId,
    pprScore,
    simTopScore,
    simMeanScore: over.simMeanScore ?? 0,
    simAgreement: over.simAgreement ?? 0,
    simMargin: over.simMargin ?? 0,
    clusterPosterior,
    corroborationCount:
      over.corroborationCount ??
      (pprScore > 0.01 ? 1 : 0) + (simTopScore > 0 ? 1 : 0) + (clusterPosterior > 0 ? 1 : 0),
  };
};

const observed = (
  seq: number,
  tabSessionId: string,
  url = `https://example.test/${tabSessionId}`,
  title?: string,
): AcceptedEvent => ({
  clientEventId: `evt-${String(seq)}`,
  dot: { replicaId: 'replica-a', seq },
  deps: {},
  aggregateId: '2026-05-10',
  type: BROWSER_TIMELINE_OBSERVED,
  acceptedAtMs: Date.parse('2026-05-10T10:00:00.000Z') + seq,
  payload: {
    eventId: `tl-${String(seq)}`,
    observedAt: '2026-05-10T10:00:00.000Z',
    url,
    canonicalUrl: url,
    transition: 'updated',
    tabIdHash: 'tab-a',
    tabSessionId,
    ...(title === undefined ? {} : { title }),
  },
});

const observedWithWorkstream = (
  seq: number,
  tabSessionId: string,
  url: string,
  workstreamId: string,
  title?: string,
): AcceptedEvent => {
  const event = observed(seq, tabSessionId, url, title);
  const payload = event.payload as BrowserTimelineObservedPayload;
  return {
    ...event,
    payload: {
      ...payload,
      workstreamId,
    },
  };
};

const emptyContributions = (): ReturnType<ClosestVisitRanker['predict']>['contributions'] => ({
  schemaVersion: 0,
  same_workstream: 0,
  opener_chain_depth: 0,
  in_navigation_chain: 0,
  same_canonical_url: 0,
  same_host: 0,
  same_repo: 0,
  same_search_query: 0,
  same_copied_snippet_count: 0,
  shared_title_tokens: 0,
  shared_path_tokens: 0,
  cosine_similarity: 0,
  recency_score_from: 0,
  recency_score_to: 0,
  engagement_class_match: 0,
  return_count_from: 0,
  return_count_to: 0,
  user_asserted_in_thread: 0,
  user_asserted_in_workstream: 0,
  same_active_topic: 0,
  topic_lineage_merge_split_related: 0,
  page_quality_tier_from: 0,
  page_quality_tier_to: 0,
});

describe('tab-session resolver', () => {
  it('runs deterministic signed PPR with an iteration cap on a 50-node fixture', () => {
    const nodes = Array.from({ length: 50 }, (_, index) => `timeline-visit:v${String(index)}`);
    const edges = nodes.slice(1).map((node, index) => ({
      kind: 'previous_visit_in_tab_session' as const,
      from: nodes[index]!,
      to: node,
    }));
    const graph = buildEvidenceGraph(snapshot(nodes, edges));
    const first = runPPR(graph, new Map([[nodes[0]!, 1]]), 0.15, 1e-9, 50, Infinity);
    const second = runPPR(graph, new Map([[nodes[0]!, 1]]), 0.15, 1e-9, 50, Infinity);

    expect([...first.entries()]).toEqual([...second.entries()]);
    expect(first.get(nodes[0]!)).toBeGreaterThan(first.get(nodes[49]!) ?? 0);
  });

  it('keys PPR cache by tab session, graph revision, and deterministic seed hash', () => {
    const cache = createPprCache(100);
    const leftSeed = new Map([
      ['timeline-visit:b', -0.5],
      ['tab-session:tses_a', 1],
    ]);
    const rightSeed = new Map([...leftSeed.entries()].reverse());
    const key = `tses_a|graph-rev|${seedHash(leftSeed)}`;
    const result = new Map([['workstream:ws_security', 0.42]]);

    expect(seedHash(leftSeed)).toBe(seedHash(rightSeed));
    cache.set(key, result, 1_000);
    expect(cache.get(`tses_a|graph-rev|${seedHash(rightSeed)}`, 1_050)).toBe(result);
    expect(cache.get(key, 1_200)).toBeNull();
  });

  it('builds evidence graph with duplicate from/to edges across different kinds', () => {
    const snap = snapshot(
      ['timeline-visit:a', 'timeline-visit:b'],
      [
        { kind: 'closest_visit', from: 'timeline-visit:a', to: 'timeline-visit:b' },
        { kind: 'visit_resembles_visit', from: 'timeline-visit:a', to: 'timeline-visit:b' },
      ],
    );

    expect(() => buildEvidenceGraph(snap)).not.toThrow();
    expect(buildEvidenceGraph(snap).adjacency.get('timeline-visit:a')).toHaveLength(2);
  });

  it('computes target-local cluster posterior with smoothing and min-support', () => {
    const snap = snapshot(
      [
        'visit-instance:tses_a:1',
        'timeline-visit:a',
        'timeline-visit:global',
        'topic:a',
        'topic:b',
        'topic:c',
        'topic:d',
        'topic:global-a',
        'topic:global-b',
        'topic:global-c',
        'workstream:ws_a',
        'workstream:ws_b',
      ],
      [
        {
          kind: 'visit_instance_same_url_as_timeline_visit',
          from: 'visit-instance:tses_a:1',
          to: 'timeline-visit:a',
        },
        { kind: 'visit_in_topic', from: 'timeline-visit:a', to: 'topic:a' },
        { kind: 'visit_in_topic', from: 'timeline-visit:a', to: 'topic:b' },
        { kind: 'visit_in_topic', from: 'timeline-visit:a', to: 'topic:c' },
        { kind: 'visit_in_topic', from: 'timeline-visit:a', to: 'topic:d' },
        { kind: 'visit_in_topic', from: 'timeline-visit:global', to: 'topic:global-a' },
        { kind: 'visit_in_topic', from: 'timeline-visit:global', to: 'topic:global-b' },
        { kind: 'visit_in_topic', from: 'timeline-visit:global', to: 'topic:global-c' },
        { kind: 'topic_in_workstream', from: 'topic:a', to: 'workstream:ws_a' },
        { kind: 'topic_in_workstream', from: 'topic:b', to: 'workstream:ws_a' },
        { kind: 'topic_in_workstream', from: 'topic:c', to: 'workstream:ws_a' },
        { kind: 'topic_in_workstream', from: 'topic:d', to: 'workstream:ws_b' },
        { kind: 'topic_in_workstream', from: 'topic:global-a', to: 'workstream:ws_b' },
        { kind: 'topic_in_workstream', from: 'topic:global-b', to: 'workstream:ws_b' },
        { kind: 'topic_in_workstream', from: 'topic:global-c', to: 'workstream:ws_b' },
      ],
    );

    expect(buildClusterEvidence(snap, new Set(['visit-instance:tses_a:1']))).toEqual([
      { workstreamId: 'ws_a', support: 3, posterior: 4 / 6 },
    ]);
    expect(buildClusterEvidence(snap, new Set(['timeline-visit:missing']))).toEqual([]);
  });

  it('fuses a five-candidate fixture by logit strength', () => {
    const candidates: CandidateEvidence[] = Array.from({ length: 5 }, (_, index) => ({
      workstreamId: `ws_${String(index)}`,
      pprScore: index === 3 ? 0.8 : 0.1,
      simTopScore: index === 2 ? 0.7 : 0,
      simMeanScore: 0,
      simAgreement: 0,
      simMargin: 0,
      clusterPosterior: index === 4 ? 0.5 : 0,
      corroborationCount: 1,
    }));

    expect(fuseCandidates(candidates)[0]?.workstreamId).toBe('ws_3');
  });

  it('builds similarity evidence through generated candidates and an injected ranker', () => {
    const snap = snapshot(
      [
        'timeline-visit:https://example.test/current',
        'timeline-visit:https://example.test/anchor',
        'workstream:ws_security',
      ],
      [
        {
          kind: 'visit_in_workstream',
          from: 'timeline-visit:https://example.test/anchor',
          to: 'workstream:ws_security',
        },
      ],
    );
    let predictCalls = 0;
    const ranker: ClosestVisitRanker = {
      revisionId: 'ranker-test',
      predict: (_features, candidate) => {
        predictCalls += 1;
        return {
          score: candidate.toVisitId === 'https://example.test/anchor' ? 0.91 : 0.01,
          contributions: emptyContributions(),
        };
      },
    };

    const evidence = buildSimilarityEvidence({
      snapshot: snap,
      targetVisitNodeIds: new Set(['timeline-visit:https://example.test/current']),
      events: [
        observed(1, 'tses_current', 'https://example.test/current', 'Current research'),
        observed(2, 'tses_anchor', 'https://example.test/anchor', 'Anchor research'),
      ],
      closestVisitRanker: ranker,
    });

    expect(predictCalls).toBeGreaterThan(0);
    expect(evidence[0]).toMatchObject({
      workstreamId: 'ws_security',
      simTopScore: 0.91,
    });
  });

  it('deduplicates timeline and visit-instance anchors for URL similarity evidence', () => {
    const currentUrl = 'https://example.test/current';
    const anchorUrl = 'https://example.test/anchor';
    const base = snapshot(
      [
        `timeline-visit:${currentUrl}`,
        `visit-instance:tses_current:2026-05-10T10:00:00.000Z:${currentUrl}`,
        `timeline-visit:${anchorUrl}`,
        'workstream:ws_security',
      ],
      [
        {
          kind: 'visit_instance_same_url_as_timeline_visit',
          from: `visit-instance:tses_current:2026-05-10T10:00:00.000Z:${currentUrl}`,
          to: `timeline-visit:${currentUrl}`,
        },
        {
          kind: 'visit_in_workstream',
          from: `timeline-visit:${anchorUrl}`,
          to: 'workstream:ws_security',
        },
      ],
    );
    const snap: ConnectionsSnapshot = {
      ...base,
      nodes: base.nodes.map((node) =>
        node.id.startsWith('visit-instance:tses_current:')
          ? {
              ...node,
              metadata: {
                canonicalUrl: currentUrl,
                timelineVisitId: `timeline-visit:${currentUrl}`,
              },
            }
          : node,
      ),
    };
    let predictCalls = 0;
    const ranker: ClosestVisitRanker = {
      revisionId: 'ranker-test',
      predict: (_features, candidate) => {
        predictCalls += 1;
        return {
          score: candidate.toVisitId === anchorUrl ? 0.91 : 0.01,
          contributions: emptyContributions(),
        };
      },
    };

    const evidence = buildSimilarityEvidence({
      snapshot: snap,
      targetVisitNodeIds: new Set([
        `timeline-visit:${currentUrl}`,
        `visit-instance:tses_current:2026-05-10T10:00:00.000Z:${currentUrl}`,
      ]),
      events: [
        observed(1, 'tses_current', currentUrl, 'Current research'),
        observed(2, 'tses_anchor', anchorUrl, 'Anchor research'),
      ],
      closestVisitRanker: ranker,
    });

    expect(predictCalls).toBe(1);
    expect(evidence).toEqual([
      expect.objectContaining({
        workstreamId: 'ws_security',
        simAgreement: 0.1,
      }),
    ]);
  });

  it('treats current visit_in_workstream edges as authoritative over stale event stamps', () => {
    const currentUrl = 'https://current.example.test/start';
    const newAnchorUrl = 'https://new-anchor.example.test/relevant';
    const oldAnchorUrl = 'https://old-anchor.example.test/archive';
    const snap = snapshot(
      [
        `timeline-visit:${currentUrl}`,
        `timeline-visit:${newAnchorUrl}`,
        `timeline-visit:${oldAnchorUrl}`,
        'workstream:ws_new',
        'workstream:ws_old',
      ],
      [
        {
          kind: 'visit_in_workstream',
          from: `timeline-visit:${currentUrl}`,
          to: 'workstream:ws_new',
        },
        {
          kind: 'visit_in_workstream',
          from: `timeline-visit:${newAnchorUrl}`,
          to: 'workstream:ws_new',
        },
        {
          kind: 'visit_in_workstream',
          from: `timeline-visit:${oldAnchorUrl}`,
          to: 'workstream:ws_old',
        },
        {
          kind: 'visit_resembles_visit',
          from: `timeline-visit:${currentUrl}`,
          to: `timeline-visit:${newAnchorUrl}`,
        },
      ],
    );

    const evidence = buildSimilarityEvidence({
      snapshot: snap,
      targetVisitNodeIds: new Set([`timeline-visit:${currentUrl}`]),
      events: [
        observedWithWorkstream(1, 'tses_current', currentUrl, 'ws_old', 'Current'),
        observedWithWorkstream(2, 'tses_new', newAnchorUrl, 'ws_new', 'New anchor'),
        observedWithWorkstream(3, 'tses_old', oldAnchorUrl, 'ws_old', 'Old anchor'),
      ],
    });

    expect(evidence.map((item) => item.workstreamId)).toContain('ws_new');
    expect(evidence.map((item) => item.workstreamId)).not.toContain('ws_old');
  });

  it('ignores a chrome-only similarity edge between two aggregator pages', () => {
    // Two Hacker News items resemble each other only on behavior + title/host/
    // path chrome (no content channel). The resolver must not attribute the
    // current item to the other one's workstream. (~7000 such edges on a real
    // vault, scored 0.8–0.99.)
    const currentUrl = 'https://news.ycombinator.com/item?id=1';
    const anchorUrl = 'https://news.ycombinator.com/item?id=2';
    const snap = snapshot(
      [`timeline-visit:${currentUrl}`, `timeline-visit:${anchorUrl}`, 'workstream:ws_unrelated'],
      [
        {
          kind: 'visit_in_workstream',
          from: `timeline-visit:${anchorUrl}`,
          to: 'workstream:ws_unrelated',
        },
        {
          kind: 'visit_resembles_visit',
          from: `timeline-visit:${currentUrl}`,
          to: `timeline-visit:${anchorUrl}`,
          metadata: { score: 0.95, channels: { behavior: 0.95, metadata: 0.9 } },
        },
      ],
    );

    const evidence = buildSimilarityEvidence({
      snapshot: snap,
      targetVisitNodeIds: new Set([`timeline-visit:${currentUrl}`]),
      events: [observed(1, 'tses_current', currentUrl), observed(2, 'tses_anchor', anchorUrl)],
    });

    expect(evidence.map((item) => item.workstreamId)).not.toContain('ws_unrelated');
  });

  it('keeps a content-backed similarity edge between two aggregator pages', () => {
    // Same two aggregator pages, but the resemblance is backed by a real
    // content vector — genuine topical similarity, must be preserved.
    const currentUrl = 'https://news.ycombinator.com/item?id=1';
    const anchorUrl = 'https://news.ycombinator.com/item?id=2';
    const snap = snapshot(
      [`timeline-visit:${currentUrl}`, `timeline-visit:${anchorUrl}`, 'workstream:ws_topic'],
      [
        {
          kind: 'visit_in_workstream',
          from: `timeline-visit:${anchorUrl}`,
          to: 'workstream:ws_topic',
        },
        {
          kind: 'visit_resembles_visit',
          from: `timeline-visit:${currentUrl}`,
          to: `timeline-visit:${anchorUrl}`,
          metadata: { score: 0.8, channels: { contentVector: 0.8, metadata: 0.5 } },
        },
      ],
    );

    const evidence = buildSimilarityEvidence({
      snapshot: snap,
      targetVisitNodeIds: new Set([`timeline-visit:${currentUrl}`]),
      events: [observed(1, 'tses_current', currentUrl), observed(2, 'tses_anchor', anchorUrl)],
    });

    expect(evidence.map((item) => item.workstreamId)).toContain('ws_topic');
  });

  it('does not suggest a lone low-agreement similarity pick with no corroboration', () => {
    // The exact shape of the misattribution: one similarity edge, no graph
    // path, no cluster. Pre-discount this fused to logit ~1.5 → suggest ~82%.
    const [candidate] = fuseCandidates([
      {
        workstreamId: 'ws_x',
        pprScore: 0.0006,
        simTopScore: 0.65,
        simMeanScore: 0.65,
        simAgreement: 0.2,
        simMargin: 0.65,
        clusterPosterior: 0,
        corroborationCount: 1,
      },
    ]);
    expect(candidate?.dominantSource).toBe('similarity');
    expect(candidate!.rawFusionLogit).toBeGreaterThanOrEqual(1.2); // would otherwise 'suggest'
    expect(decideAttribution([candidate!], 'balanced').action).toBe('inbox');
  });

  it('still suggests a similarity pick once a second source corroborates it', () => {
    const fused = fuseCandidates([
      {
        workstreamId: 'ws_x',
        pprScore: 0.05, // > 0.01 → contributes a corroboration
        simTopScore: 0.65,
        simMeanScore: 0.65,
        simAgreement: 0.2,
        simMargin: 0.65,
        clusterPosterior: 0,
        corroborationCount: 2,
      },
    ]);
    expect(fused[0]?.dominantSource).toBe('similarity');
    expect(decideAttribution(fused, 'balanced').action).toBe('suggest');
  });

  it('still guards a thin-similarity aggregator false-friend even when the WEIGHTED label flips to ppr', () => {
    // The aggregator/URL-skeleton false-friend shape: a thin similarity
    // (only a top lexical match, near-zero mean/margin, weak agreement) plus
    // a SMALL nonzero pprScore from the shared platform's link graph. Because
    // pprScore carries a 5× weight, its weighted contribution (0.30×5 = 1.50)
    // out-ranks the thin similarity family (0.55×1.6 + 0.15×0.75 = 0.99), so
    // the diagnostic `dominantSource` label is 'ppr', NOT 'similarity'.
    //
    // The regret budget/rate telemetry may key off that label, but the
    // corroboration guard must NOT — it keys off raw simTopScore dominance.
    // The fused logit here (~1.64) clears the balanced 'suggest' floor (1.2)
    // and, with a single candidate, the margin (1.64) clears policy.margin,
    // so WITHOUT the guard this would 'suggest'. The guard is the deciding
    // factor: it lifts requiredCorroboration to 2 on this lone-source pick and
    // holds the false-friend in the inbox. Regression for the label flip
    // silently bypassing B3 (commit 60369f18).
    const [candidate] = fuseCandidates([
      {
        workstreamId: 'ws_agg',
        pprScore: 0.3, // small platform-link PPR → 5× weight flips the LABEL to ppr
        simTopScore: 0.55, // top raw evidence channel (> pprScore, > cluster)
        simMeanScore: 0,
        simAgreement: 0.15, // weak agreement — 1–2 neighbors only
        simMargin: 0,
        clusterPosterior: 0, // no topic corroboration
        corroborationCount: 1, // pprScore > 0.01 contributes the lone source
      },
    ]);
    expect(candidate?.dominantSource).toBe('ppr'); // label flipped, as designed
    expect(candidate!.simTopScore).toBeGreaterThanOrEqual(candidate!.pprScore);
    expect(candidate!.rawFusionLogit).toBeGreaterThanOrEqual(1.2); // would otherwise 'suggest'
    // Guard still fires despite the flip → held in inbox, not suggested.
    expect(decideAttribution([candidate!], 'balanced').action).toBe('inbox');
  });

  // ---- pipeline-gate: decision.gate names WHICH policy gate decided ----
  //
  // Every decision carries a `gate` (frozen wire contract). Inbox outcomes name
  // the FIRST failing gate in evaluation order (corroboration → suggest-logit →
  // margin); cleared outcomes carry cleared-suggest/cleared-auto; the regret
  // budget demotes an auto-eligible pick to suggest and says so. The detail line
  // carries the actual numbers so the strip can explain the outcome to a human.
  describe('decision.gate (pipeline-gate)', () => {
    it('no-candidates when nothing reaches fusion', () => {
      const decision = decideAttribution([], 'balanced');
      expect(decision.action).toBe('inbox');
      expect(decision.gate.reason).toBe('no-candidates');
    });

    it('cleared-auto for a strong pick clearing the auto bar, with the numbers in detail', () => {
      // ppr 1.0 → logit ~3.8 (>= 2.8 auto), single candidate so margin is the
      // logit itself (>= 0.35), corroboration 1 (ppr contributes), regret 0.
      const fused = fuseCandidates([lone({ workstreamId: 'ws', pprScore: 1.0 })]);
      const decision = decideAttribution(fused, 'balanced');
      expect(decision.action).toBe('auto-apply');
      expect(decision.gate.reason).toBe('cleared-auto');
      expect(decision.gate.detail).toContain('2.8 auto bar');
    });

    it('cleared-suggest for a pick in the suggest band (below the auto bar)', () => {
      // ppr 0.5 → logit ~1.65 (>= 1.2 suggest, < 2.8 auto), margin = logit.
      const fused = fuseCandidates([lone({ workstreamId: 'ws', pprScore: 0.5 })]);
      const decision = decideAttribution(fused, 'balanced');
      expect(decision.action).toBe('suggest');
      expect(decision.gate.reason).toBe('cleared-suggest');
      expect(decision.gate.detail).toContain('1.2 suggest bar');
    });

    it('below-suggest when corroboration clears but the logit is under the suggest bar', () => {
      // A weak cluster-only pick: cluster 0.5 → logit ~-0.25 (< 1.2 suggest),
      // corroboration 1 (cluster contributes), requiredCorroboration 1 (cluster
      // is the top raw channel, not similarity — the lift never fires).
      const fused = fuseCandidates([lone({ workstreamId: 'ws', clusterPosterior: 0.5 })]);
      const decision = decideAttribution(fused, 'balanced');
      expect(decision.action).toBe('inbox');
      expect(decision.gate.reason).toBe('below-suggest');
      expect(decision.gate.detail).toContain('suggest bar');
    });

    it('corroboration (similarity-dominant) for a lone thin-similarity false-friend', () => {
      // The false-friend shape: simTop the top raw channel, weak agreement,
      // corroboration 1 < the lifted requirement of 2.
      const [candidate] = fuseCandidates([
        {
          workstreamId: 'ws_agg',
          pprScore: 0.0006,
          simTopScore: 0.65,
          simMeanScore: 0.65,
          simAgreement: 0.2,
          simMargin: 0.65,
          clusterPosterior: 0,
          corroborationCount: 1,
        },
      ]);
      const decision = decideAttribution([candidate!], 'balanced');
      expect(decision.action).toBe('inbox');
      expect(decision.gate.reason).toBe('corroboration');
      expect(decision.gate.detail).toContain('(similarity-dominant)');
      expect(decision.gate.detail).toContain('< 2');
    });

    it('margin-tie when logit + corroboration clear but the runner-up is too close', () => {
      // Two ppr picks a hair apart: top logit ~1.65, second ~1.55 → margin 0.10
      // < 0.35. Top clears the suggest logit and corroboration, so margin is the
      // first failing gate.
      const fused = fuseCandidates([
        lone({ workstreamId: 'ws_top', pprScore: 0.5 }),
        lone({ workstreamId: 'ws_second', pprScore: 0.48 }),
      ]);
      const decision = decideAttribution(fused, 'balanced');
      expect(decision.action).toBe('inbox');
      expect(decision.gate.reason).toBe('margin-tie');
      expect(decision.gate.detail).toContain('< 0.35');
    });

    it('reports the FIRST failing gate: both below-suggest AND margin failing → below-suggest', () => {
      // Two weak cluster picks: top logit ~-0.25 (< 1.2 suggest) AND margin tiny.
      // The suggest-logit gate is earlier in the order, so it wins the reason.
      const fused = fuseCandidates([
        lone({ workstreamId: 'ws_top', clusterPosterior: 0.5 }),
        lone({ workstreamId: 'ws_second', clusterPosterior: 0.49 }),
      ]);
      const decision = decideAttribution(fused, 'balanced');
      expect(decision.action).toBe('inbox');
      expect(decision.gate.reason).toBe('below-suggest');
    });

    it('regret-budget demotes an auto-eligible pick to suggest (auto→suggest)', () => {
      // ppr 1.0 → logit ~3.8 clears the auto bar with margin + corroboration,
      // but the per-source (ppr) online regret rate 0.5 exceeds the 0.08 budget,
      // so the pick surfaces as SUGGEST and the gate names the regret budget.
      const fused = fuseCandidates([lone({ workstreamId: 'ws', pprScore: 1.0 })]);
      const decision = decideAttribution(fused, 'balanced', {
        regretRateBySource: { ppr: 0.5 },
      });
      expect(decision.action).toBe('suggest');
      expect(decision.gate.reason).toBe('regret-budget');
      expect(decision.gate.detail).toContain('auto→suggest');
    });
  });

  it('resolves a strong causal session with explainable candidates and no writes', () => {
    const snap = snapshot(
      [
        'tab-session:tses_a',
        'timeline-visit:https://example.test/a',
        'timeline-visit:https://example.test/anchor',
        'workstream:ws_security',
      ],
      [
        {
          kind: 'visit_in_tab_session',
          from: 'timeline-visit:https://example.test/a',
          to: 'tab-session:tses_a',
        },
        {
          kind: 'closest_visit',
          from: 'timeline-visit:https://example.test/a',
          to: 'timeline-visit:https://example.test/anchor',
        },
        {
          kind: 'visit_in_workstream',
          from: 'timeline-visit:https://example.test/anchor',
          to: 'workstream:ws_security',
        },
      ],
    );
    const events = [observed(1, 'tses_a')];
    const result = resolveAttribution({
      tabSessionId: 'tses_a',
      snapshot: snap,
      projection: projectTabSessions(events),
      events,
      policyMode: 'balanced',
      nowMs: Date.parse('2026-05-10T10:01:00.000Z'),
    });

    expect(result.dryRun).toBe(true);
    expect(result.decision.action).toBe('auto-apply');
    expect(result.fusedCandidates[0]?.workstreamId).toBe('ws_security');
    expect(result.fusedCandidates[0]?.reasons.length).toBeGreaterThan(0);
    // Enriched anchor shape: each anchor carries { id, kind, label }
    // so the extension can render human text without a separate
    // graph lookup. Backward compat for bare-string anchors lives in
    // the extension's formatAnchorDisplay reader.
    const anchorList = result.fusedCandidates[0]?.reasons[0]?.anchors ?? [];
    expect(anchorList.length).toBeGreaterThan(0);
    for (const anchor of anchorList) {
      expect(typeof anchor).toBe('object');
      expect(typeof anchor.id).toBe('string');
      expect(typeof anchor.kind).toBe('string');
      expect(typeof anchor.label).toBe('string');
    }
    expect(inferredAttributionPayloadFromResolution(result)).toMatchObject({
      payloadVersion: 1,
      tabSessionId: 'tses_a',
      workstreamId: 'ws_security',
      policyMode: 'balanced',
      dominantSource: 'similarity',
    });
  });

  it('resolves thread suggestions through the same URL graph evidence', () => {
    const currentUrl = 'https://chatgpt.com/c/thread-a';
    const anchorUrl = 'https://example.test/anchor';
    const base = snapshot(
      [
        'thread:thread_a',
        `timeline-visit:${currentUrl}`,
        `timeline-visit:${anchorUrl}`,
        'workstream:ws_security',
      ],
      [
        {
          kind: 'closest_visit',
          from: `timeline-visit:${currentUrl}`,
          to: `timeline-visit:${anchorUrl}`,
        },
        {
          kind: 'visit_in_workstream',
          from: `timeline-visit:${anchorUrl}`,
          to: 'workstream:ws_security',
        },
      ],
    );
    const snap: ConnectionsSnapshot = {
      ...base,
      nodes: base.nodes.map((node) =>
        node.id === 'thread:thread_a'
          ? {
              ...node,
              metadata: {
                canonicalUrl: currentUrl,
                threadId: 'provider-thread-a',
                url: currentUrl,
              },
            }
          : node,
      ),
    };
    const events = [
      observed(1, 'tses_current', currentUrl, 'Current thread'),
      observed(2, 'tses_anchor', anchorUrl, 'Anchor'),
    ];

    const threadResult = resolveThreadAttribution({
      threadId: 'thread_a',
      providerThreadId: 'provider-thread-a',
      threadUrl: currentUrl,
      snapshot: snap,
      events,
      policyMode: 'balanced',
    });
    const urlResult = resolveUrlAttribution({
      canonicalUrl: currentUrl,
      snapshot: snap,
      events,
      policyMode: 'balanced',
    });

    expect(threadResult.fusedCandidates[0]?.workstreamId).toBe('ws_security');
    expect(threadResult.fusedCandidates[0]?.dominantSource).toBe(
      urlResult.fusedCandidates[0]?.dominantSource,
    );
    expect(threadResult.reasons.targetAnchors).toContain('thread:thread_a');
    expect(threadResult.reasons.targetAnchors).toContain(`timeline-visit:${currentUrl}`);
  });

  it('can use materialized snapshot edges without rebuilding event-derived candidates', () => {
    const targetUrl = 'https://example.test/target';
    const anchorUrl = 'https://example.test/anchor';
    const snap = snapshot(
      [`timeline-visit:${targetUrl}`, `timeline-visit:${anchorUrl}`, 'workstream:ws_security'],
      [
        {
          kind: 'visit_in_workstream',
          from: `timeline-visit:${anchorUrl}`,
          to: 'workstream:ws_security',
        },
      ],
    );
    const events = [
      observed(1, 'tses_target', targetUrl, 'Target'),
      observed(2, 'tses_anchor', anchorUrl, 'Anchor'),
    ];

    const eventCandidateResult = resolveUrlAttribution({
      canonicalUrl: targetUrl,
      snapshot: snap,
      events,
      policyMode: 'balanced',
    });
    const snapshotOnlyResult = resolveUrlAttribution({
      canonicalUrl: targetUrl,
      snapshot: snap,
      events,
      useEventCandidateSimilarity: false,
      policyMode: 'balanced',
    });

    expect(eventCandidateResult.fusedCandidates[0]?.workstreamId).toBe('ws_security');
    expect(snapshotOnlyResult.fusedCandidates).toHaveLength(0);
  });

  it('respects "Not in any stream": a user decline settles the URL instead of re-asking', () => {
    const url = 'https://example.test/declined';
    const anchorUrl = 'https://example.test/anchor';
    const snap = snapshot(
      [`timeline-visit:${url}`, `timeline-visit:${anchorUrl}`, 'workstream:ws_security'],
      [
        { kind: 'closest_visit', from: `timeline-visit:${url}`, to: `timeline-visit:${anchorUrl}` },
        {
          kind: 'visit_in_workstream',
          from: `timeline-visit:${anchorUrl}`,
          to: 'workstream:ws_security',
        },
      ],
    );
    const baseEvents = [observed(1, 'tses_a', url), observed(2, 'tses_anchor', anchorUrl)];

    // Baseline: no user decision → the resolver emits a best-guess.
    const before = resolveUrlAttribution({
      canonicalUrl: url,
      snapshot: snap,
      events: baseEvents,
      policyMode: 'balanced',
    });
    expect(before.fusedCandidates.length).toBeGreaterThan(0);

    // The user picks "Not in any stream" (USER_ORGANIZED_ITEM move,
    // toContainer:null) → the resolver must settle, not re-ask.
    const decline: AcceptedEvent = {
      clientEventId: 'evt-decline',
      dot: { replicaId: 'replica-a', seq: 3 },
      deps: {},
      aggregateId: 'feedback-decline',
      type: USER_ORGANIZED_ITEM,
      acceptedAtMs: Date.parse('2026-05-10T10:05:00.000Z'),
      payload: {
        payloadVersion: 1,
        itemKind: 'canonical-url',
        itemId: url,
        action: 'move',
        toContainer: null,
      },
    };
    const after = resolveUrlAttribution({
      canonicalUrl: url,
      snapshot: snap,
      events: [...baseEvents, decline],
      policyMode: 'balanced',
    });
    expect(after.decision.action).toBe('inbox');
    expect(after.decision.workstreamId).toBeUndefined();
    expect(after.fusedCandidates).toHaveLength(0);
  });

  it('blocks auto-apply when source regret exceeds the policy budget', () => {
    const snap = snapshot(
      [
        'tab-session:tses_a',
        'timeline-visit:https://example.test/a',
        'timeline-visit:https://example.test/anchor',
        'workstream:ws_security',
      ],
      [
        {
          kind: 'visit_in_tab_session',
          from: 'timeline-visit:https://example.test/a',
          to: 'tab-session:tses_a',
        },
        {
          kind: 'closest_visit',
          from: 'timeline-visit:https://example.test/a',
          to: 'timeline-visit:https://example.test/anchor',
        },
        {
          kind: 'visit_in_workstream',
          from: 'timeline-visit:https://example.test/anchor',
          to: 'workstream:ws_security',
        },
      ],
    );
    const events = [observed(1, 'tses_a')];
    const result = resolveAttribution({
      tabSessionId: 'tses_a',
      snapshot: snap,
      projection: projectTabSessions(events),
      events,
      policyMode: 'balanced',
      policyTelemetry: { regretRateBySource: { similarity: 0.5 } },
      nowMs: Date.parse('2026-05-10T10:01:00.000Z'),
    });

    expect(result.decision.action).toBe('suggest');
    expect(inferredAttributionPayloadFromResolution(result)).toBeNull();
  });
});

describe('resolver guess lanes (SIDETRACK_GUESS_LANES)', () => {
  const GUESS_LANES_ENV = 'SIDETRACK_GUESS_LANES';
  const prev = process.env[GUESS_LANES_ENV];
  afterEach(() => {
    if (prev === undefined) delete process.env[GUESS_LANES_ENV];
    else process.env[GUESS_LANES_ENV] = prev;
  });

  // A URL with a graph path to a workstream (visit_in_workstream), so the graph
  // lane populates from the resolver's own PPR/similarity evidence.
  const laneSnapshot = (): ConnectionsSnapshot => {
    const targetUrl = 'https://example.test/target';
    const anchorUrl = 'https://example.test/anchor';
    return snapshot(
      [`timeline-visit:${targetUrl}`, `timeline-visit:${anchorUrl}`, 'workstream:ws_security'],
      [
        { kind: 'closest_visit', from: `timeline-visit:${targetUrl}`, to: `timeline-visit:${anchorUrl}` },
        { kind: 'visit_in_workstream', from: `timeline-visit:${anchorUrl}`, to: 'workstream:ws_security' },
      ],
    );
  };

  it('omits the lanes field entirely when the flag is off', () => {
    process.env[GUESS_LANES_ENV] = '0';
    const result = resolveUrlAttribution({
      canonicalUrl: 'https://example.test/target',
      snapshot: laneSnapshot(),
      events: [observed(1, 'tses_target', 'https://example.test/target', 'Target')],
      policyMode: 'balanced',
    });
    expect(result.lanes).toBeUndefined();
    expect('lanes' in result).toBe(false);
  });

  it('emits all six lanes in the fixed order when the flag is on', () => {
    delete process.env[GUESS_LANES_ENV];
    const result = resolveUrlAttribution({
      canonicalUrl: 'https://example.test/target',
      snapshot: laneSnapshot(),
      events: [observed(1, 'tses_target', 'https://example.test/target', 'Target')],
      policyMode: 'balanced',
    });
    expect(result.lanes).toBeDefined();
    expect(result.lanes!.map((lane) => lane.lane)).toEqual([
      'graph',
      'similarity',
      'topic',
      'title',
      'domain',
      'recency',
    ]);
    // The graph lane populates from the resolver's own evidence (a path exists),
    // and its top candidate is the connected workstream.
    const graph = result.lanes!.find((lane) => lane.lane === 'graph');
    expect(graph?.candidates.some((c) => c.workstreamId === 'ws_security')).toBe(true);
    // With no vote signals supplied, the vote lanes report typed emptiness.
    for (const laneName of ['title', 'domain', 'recency'] as const) {
      const lane = result.lanes!.find((l) => l.lane === laneName);
      expect(lane?.candidates).toHaveLength(0);
      expect(lane?.emptyReason).toBeDefined();
    }
  });

  it('carries lanes on the thread and tab-session result shapes too', () => {
    delete process.env[GUESS_LANES_ENV];
    const snap = laneSnapshot();
    const events = [observed(1, 'tses_target', 'https://example.test/target', 'Target')];
    const threadResult = resolveThreadAttribution({
      threadId: 'thread_x',
      threadUrl: 'https://example.test/target',
      snapshot: snap,
      events,
      policyMode: 'balanced',
    });
    expect(threadResult.lanes).toHaveLength(6);
    const tabResult = resolveAttribution({
      tabSessionId: 'tses_target',
      snapshot: snap,
      projection: projectTabSessions(events),
      events,
      policyMode: 'balanced',
    });
    expect(tabResult.lanes).toHaveLength(6);
  });
});

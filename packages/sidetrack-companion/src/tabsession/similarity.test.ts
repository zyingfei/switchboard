import { afterEach, describe, expect, it } from 'vitest';

import type {
  ConnectionEdge,
  ConnectionEdgeKind,
  ConnectionNode,
  ConnectionsSnapshot,
} from '../connections/types.js';
import { fuseCandidates, type CandidateEvidence } from './fusion.js';
import { decideAttribution } from './policy.js';
import { buildSimilarityEvidence } from './similarity.js';

// Acceptance tests for the aggregator (HN) subpage redesign. Per
// DEBUGGING_DOCTRINE rule 10 these read back the SERVED decision
// (buildSimilarityEvidence → fuseCandidates → decideAttribution), not an
// intermediate layer — the artifact the user actually experiences as
// auto-file / suggest / inbox.

const VISIT_PREFIX = 'timeline-visit:';
const WORKSTREAM_PREFIX = 'workstream:';

const node = (id: string): ConnectionNode => ({
  id,
  kind: 'timeline-visit',
  label: id,
  firstSeenAt: '2026-05-07T10:00:00.000Z',
  lastSeenAt: '2026-05-07T10:00:00.000Z',
  originReplicaIds: [],
});

const edge = (input: {
  readonly kind: ConnectionEdgeKind;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly metadata?: Record<string, unknown>;
}): ConnectionEdge => ({
  id: `edge:${input.kind}:${input.fromNodeId}:${input.toNodeId}`,
  kind: input.kind,
  fromNodeId: input.fromNodeId,
  toNodeId: input.toNodeId,
  observedAt: '2026-05-07T10:00:03.000Z',
  producedBy: { source: 'timeline-projection' },
  confidence: 'inferred',
  ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
});

const snapshot = (nodes: readonly ConnectionNode[], edges: readonly ConnectionEdge[]): ConnectionsSnapshot => ({
  scope: {},
  nodes,
  edges,
  updatedAt: '2026-05-07T10:00:03.000Z',
  nodeCount: nodes.length,
  edgeCount: edges.length,
});

// Fold the similarity evidence into the fusion input the policy reads. No PPR /
// cluster corroboration by default — that is the false-friend shape (similarity
// alone, thin agreement).
const evidenceToCandidate = (
  ev: ReturnType<typeof buildSimilarityEvidence>[number],
  overrides: Partial<CandidateEvidence> = {},
): CandidateEvidence => ({
  workstreamId: ev.workstreamId,
  pprScore: 0,
  simTopScore: ev.simTopScore,
  simMeanScore: ev.simMeanScore,
  simAgreement: ev.simAgreement,
  simMargin: ev.simMargin,
  clusterPosterior: 0,
  corroborationCount: 1,
  ...overrides,
});

const AI_VIDEO_ITEM = 'https://news.ycombinator.com/item?id=48856904';
const LINUX_SEC_ITEM = 'https://news.ycombinator.com/item?id=48173708';
const HN_FEED = 'https://news.ycombinator.com/newest';
const LINUX_WS = 'linux-security';

// A chrome-only resemblance edge: title_only tier, no content channel. This is
// the exact shape of the 3,879 persisted item↔item edges on the live vault.
const chromeOnlyResemble = (from: string, to: string): ConnectionEdge =>
  edge({
    kind: 'visit_resembles_visit',
    fromNodeId: `${VISIT_PREFIX}${from}`,
    toNodeId: `${VISIT_PREFIX}${to}`,
    metadata: {
      score: 0.9,
      evidenceTier: 'title_only',
      candidateSources: ['same_title_path_tokens'],
      channels: { metadata: 0.9 },
    },
  });

// The ACTUAL persisted shape on the live vault (verified 2026-07-24: 100% of
// the 51,248 visit_resembles_visit edges): a cosine-only payload with NEITHER a
// `channels` object NOR a `candidateSources` array — just the title-only
// similarity metadata. The prior `chromeOnlyResemble` fixture (which carries
// both) masked blocker B2: isChromeOnlySimilarityEdge only inspected
// channels/candidateSources, so on the real shape it returned false and the
// persisted-edge drop never fired. This fixture reproduces the real artifact.
const realTitleOnlyResemble = (from: string, to: string, cosine: number): ConnectionEdge =>
  edge({
    kind: 'visit_resembles_visit',
    fromNodeId: `${VISIT_PREFIX}${from}`,
    toNodeId: `${VISIT_PREFIX}${to}`,
    metadata: {
      cosine,
      threshold: 0.85,
      evidenceTier: 'title_only',
      evidenceProducedAt: 1784862829694,
      simZ: 3.03,
    },
  });

// A content-backed resemblance edge: carries a real contentVector channel.
const contentBackedResemble = (from: string, to: string, cosine: number): ConnectionEdge =>
  edge({
    kind: 'visit_resembles_visit',
    fromNodeId: `${VISIT_PREFIX}${from}`,
    toNodeId: `${VISIT_PREFIX}${to}`,
    metadata: {
      score: cosine,
      evidenceTier: 'content_backed',
      candidateSources: ['content_embedding_neighborhood'],
      channels: { contentVector: cosine, metadata: 0.4 },
    },
  });

const wsEdge = (visitUrl: string, workstreamId: string): ConnectionEdge =>
  edge({
    kind: 'visit_in_workstream',
    fromNodeId: `${VISIT_PREFIX}${visitUrl}`,
    toNodeId: `${WORKSTREAM_PREFIX}${workstreamId}`,
  });

const decisionFor = (
  snap: ConnectionsSnapshot,
  targetUrl: string,
  overrides: Partial<CandidateEvidence> = {},
): ReturnType<typeof decideAttribution> => {
  const evidence = buildSimilarityEvidence({
    snapshot: snap,
    targetVisitNodeIds: new Set([`${VISIT_PREFIX}${targetUrl}`]),
    events: [],
  });
  const fused = fuseCandidates(evidence.map((ev) => evidenceToCandidate(ev, overrides)));
  return decideAttribution(fused, 'balanced');
};

const withItemSignals = (value: string | undefined, run: () => void): void => {
  const previous = process.env['SIDETRACK_AGGREGATOR_ITEM_SIGNALS'];
  if (value === undefined) delete process.env['SIDETRACK_AGGREGATOR_ITEM_SIGNALS'];
  else process.env['SIDETRACK_AGGREGATOR_ITEM_SIGNALS'] = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env['SIDETRACK_AGGREGATOR_ITEM_SIGNALS'];
    else process.env['SIDETRACK_AGGREGATOR_ITEM_SIGNALS'] = previous;
  }
};

describe('aggregator resolver — acceptance (reads the served decision)', () => {
  afterEach(() => {
    delete process.env['SIDETRACK_AGGREGATOR_ITEM_SIGNALS'];
  });

  it('REGRESSION (2026-07-10): AI-video HN item + chrome-only edge to a linux-security item → inbox', () => {
    // The original false-friend: an AI-video HN item filed into linux-security
    // at 82% via the shared site skeleton. With ONLY a chrome-only (title_only)
    // resemblance edge and no corroboration, the served decision must be inbox —
    // under BOTH flag states, because the chrome-only-edge drop stays in force
    // for item pages as defense-in-depth.
    const snap = snapshot(
      [node(`${VISIT_PREFIX}${AI_VIDEO_ITEM}`), node(`${VISIT_PREFIX}${LINUX_SEC_ITEM}`)],
      [chromeOnlyResemble(AI_VIDEO_ITEM, LINUX_SEC_ITEM), wsEdge(LINUX_SEC_ITEM, LINUX_WS)],
    );
    for (const flag of [undefined, '1'] as const) {
      withItemSignals(flag, () => {
        expect(decisionFor(snap, AI_VIDEO_ITEM).action).toBe('inbox');
      });
    }
  });

  it('REGRESSION: an HN FEED page with a chrome-only edge stays inbox regardless of flag', () => {
    const snap = snapshot(
      [node(`${VISIT_PREFIX}${HN_FEED}`), node(`${VISIT_PREFIX}${LINUX_SEC_ITEM}`)],
      [chromeOnlyResemble(HN_FEED, LINUX_SEC_ITEM), wsEdge(LINUX_SEC_ITEM, LINUX_WS)],
    );
    for (const flag of [undefined, '1'] as const) {
      withItemSignals(flag, () => {
        expect(decisionFor(snap, HN_FEED).action).toBe('inbox');
      });
    }
  });

  it('FIX: a genuine linux-security HN item with a CONTENT-backed edge attributes when narrowing is ON', () => {
    // The point of the redesign: a content-backed similarity edge between two
    // items should NOT be dropped, so the item resolves to the linux-security
    // workstream on CONTENT — which the old blanket guard would have wrongly
    // suppressed (isChromeOnlySimilarityEdge is FALSE for a contentVector edge,
    // so this survived even the old guard; the real change is that item↔item
    // content edges are no longer starved at generation). We assert the served
    // evidence is non-empty and carries the content score.
    const GENUINE_LINUX_ITEM = 'https://news.ycombinator.com/item?id=48178692';
    const snap = snapshot(
      [
        node(`${VISIT_PREFIX}${GENUINE_LINUX_ITEM}`),
        node(`${VISIT_PREFIX}${LINUX_SEC_ITEM}`),
      ],
      [
        contentBackedResemble(GENUINE_LINUX_ITEM, LINUX_SEC_ITEM, 0.92),
        wsEdge(LINUX_SEC_ITEM, LINUX_WS),
      ],
    );
    withItemSignals('1', () => {
      const evidence = buildSimilarityEvidence({
        snapshot: snap,
        targetVisitNodeIds: new Set([`${VISIT_PREFIX}${GENUINE_LINUX_ITEM}`]),
        events: [],
      });
      // The content-backed edge survives the guard and yields evidence for the
      // linux-security workstream.
      const linux = evidence.find((ev) => ev.workstreamId === LINUX_WS);
      expect(linux).toBeDefined();
      expect(linux?.simTopScore).toBeGreaterThan(0.85);
    });
  });

  it('BLOCKER B2 (real shape): a cosine-only title_only edge between two HN items → inbox, both flags', () => {
    // The prior fixture carried channels+candidateSources, so it tripped the
    // guard regardless. This uses the ACTUAL live shape (no channels, no
    // candidateSources, evidenceTier:'title_only', cosine 0.9128). Before the
    // B2 fix, isChromeOnlySimilarityEdge returned false for this shape and the
    // 0.91 score flowed into byWorkstream — the literal 2026-07-10 mis-file.
    // Post-fix the persisted-edge drop fires on evidenceTier:'title_only'
    // between two aggregator pages, so the served decision is inbox.
    const snap = snapshot(
      [node(`${VISIT_PREFIX}${AI_VIDEO_ITEM}`), node(`${VISIT_PREFIX}${LINUX_SEC_ITEM}`)],
      [realTitleOnlyResemble(AI_VIDEO_ITEM, LINUX_SEC_ITEM, 0.9128), wsEdge(LINUX_SEC_ITEM, LINUX_WS)],
    );
    for (const flag of [undefined, '1'] as const) {
      withItemSignals(flag, () => {
        const evidence = buildSimilarityEvidence({
          snapshot: snap,
          targetVisitNodeIds: new Set([`${VISIT_PREFIX}${AI_VIDEO_ITEM}`]),
          events: [],
        });
        // The title_only edge is dropped: no similarity evidence for linux-security.
        expect(evidence.find((ev) => ev.workstreamId === LINUX_WS)).toBeUndefined();
        expect(decisionFor(snap, AI_VIDEO_ITEM).action).toBe('inbox');
      });
    }
  });

  it('DIRECTIONALITY: a title_only edge from an HN item to an EXTERNAL article is NOT dropped (legitimate content link)', () => {
    // 2,038 of the live HN-item resemble edges go item↔external-article — the HN
    // item and the story it discusses. Only ONE endpoint is an aggregator, so
    // the any-aggregator persisted-edge drop (which requires BOTH endpoints to
    // be aggregator pages) must NOT fire. The item keeps attributing on this
    // structural content link.
    const EXTERNAL_ARTICLE = 'https://aibodh.com/posts/async-rust-intro';
    const ARTICLE_WS = 'rust-async';
    const snap = snapshot(
      [node(`${VISIT_PREFIX}${AI_VIDEO_ITEM}`), node(`${VISIT_PREFIX}${EXTERNAL_ARTICLE}`)],
      [
        realTitleOnlyResemble(AI_VIDEO_ITEM, EXTERNAL_ARTICLE, 0.91),
        wsEdge(EXTERNAL_ARTICLE, ARTICLE_WS),
      ],
    );
    withItemSignals('1', () => {
      const evidence = buildSimilarityEvidence({
        snapshot: snap,
        targetVisitNodeIds: new Set([`${VISIT_PREFIX}${AI_VIDEO_ITEM}`]),
        events: [],
      });
      const article = evidence.find((ev) => ev.workstreamId === ARTICLE_WS);
      expect(article).toBeDefined();
      expect(article?.simTopScore).toBeGreaterThan(0.85);
    });
  });

  it('DEFENSE-IN-DEPTH: a content-backed item edge WITHOUT corroboration still needs a second source to auto-apply', () => {
    // Even a strong content edge alone is lone-similarity; policy B3 demands
    // corroboration for a similarity-dominant pick with thin agreement. Assert a
    // lone content edge does NOT auto-apply (stays inbox/suggest boundary safe).
    const GENUINE_LINUX_ITEM = 'https://news.ycombinator.com/item?id=48178692';
    const snap = snapshot(
      [node(`${VISIT_PREFIX}${GENUINE_LINUX_ITEM}`), node(`${VISIT_PREFIX}${LINUX_SEC_ITEM}`)],
      [
        contentBackedResemble(GENUINE_LINUX_ITEM, LINUX_SEC_ITEM, 0.92),
        wsEdge(LINUX_SEC_ITEM, LINUX_WS),
      ],
    );
    withItemSignals('1', () => {
      // corroborationCount 1 (lone), no PPR/cluster → not auto-apply.
      expect(decisionFor(snap, GENUINE_LINUX_ITEM).action).not.toBe('auto-apply');
    });
  });
});

import { createHash } from 'node:crypto';

import {
  USER_FLOW_REJECTED,
  USER_ORGANIZED_ITEM,
  isUserFlowRejectedPayload,
  isUserOrganizedItemPayload,
} from '../feedback/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { ConnectionsSnapshot } from '../connections/types.js';
import type { ClosestVisitRanker } from '../connections/snapshot.js';
import { seedHash, runPPR, createPprCache } from './causalPpr.js';
import { buildClusterEvidence } from './clusterEvidence.js';
import type { TabSessionAttributionInferredPayload } from './events.js';
import { buildEvidenceGraph } from './evidenceGraph.js';
import { fuseCandidates, type CandidateEvidence, type FusedCandidate } from './fusion.js';
import {
  decideAttribution,
  type AttributionAction,
  type AttributionPolicyMode,
  type AttributionPolicyTelemetry,
} from './policy.js';
import { buildSimilarityEvidence } from './similarity.js';
import type { TabSessionProjection } from './projection.js';

const TAB_SESSION_PREFIX = 'tab-session:';
const VISIT_PREFIX = 'timeline-visit:';
const VISIT_INSTANCE_PREFIX = 'visit-instance:';
const WORKSTREAM_PREFIX = 'workstream:';
const MODEL_REVISION = 'tabsession-resolver-v1';
const pprCache = createPprCache();

export interface AttributionReason {
  readonly source: 'ppr' | 'similarity' | 'cluster';
  readonly summary: string;
  readonly anchors: readonly string[];
}

export interface ResolverCandidate extends FusedCandidate {
  readonly reasons: readonly AttributionReason[];
}

export interface ResolutionResult {
  readonly tabSessionId: string;
  readonly dryRun: true;
  readonly policyMode: AttributionPolicyMode;
  readonly decision: {
    readonly action: AttributionAction;
    readonly workstreamId?: string;
    readonly margin: number;
  };
  readonly fusedCandidates: readonly ResolverCandidate[];
  readonly reasons: {
    readonly dependencyKey: string;
    readonly modelRevision: string;
    readonly graphRevision: string;
    readonly evidenceHash: string;
    readonly targetAnchors: readonly string[];
    readonly topContributingAnchors: readonly string[];
  };
}

export interface ResolveAttributionInput {
  readonly tabSessionId: string;
  readonly snapshot: ConnectionsSnapshot;
  readonly projection: TabSessionProjection;
  readonly events: readonly AcceptedEvent[];
  readonly policyMode?: AttributionPolicyMode;
  readonly policyTelemetry?: AttributionPolicyTelemetry;
  readonly nowMs?: number;
  readonly closestVisitRanker?: ClosestVisitRanker;
}

const compareString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const workstreamIdFromNode = (nodeId: string): string | null =>
  nodeId.startsWith(WORKSTREAM_PREFIX) ? nodeId.slice(WORKSTREAM_PREFIX.length) : null;

const tabSessionNodeId = (tabSessionId: string): string => `${TAB_SESSION_PREFIX}${tabSessionId}`;

const targetVisitNodes = (snapshot: ConnectionsSnapshot, tabSessionId: string): Set<string> => {
  const target = tabSessionNodeId(tabSessionId);
  const visits = new Set<string>();
  for (const edge of snapshot.edges) {
    if (edge.kind !== 'visit_in_tab_session' && edge.kind !== 'visit_instance_in_tab_session') {
      continue;
    }
    if (
      edge.toNodeId === target &&
      (edge.fromNodeId.startsWith(VISIT_PREFIX) || edge.fromNodeId.startsWith(VISIT_INSTANCE_PREFIX))
    ) {
      visits.add(edge.fromNodeId);
    }
    if (
      edge.fromNodeId === target &&
      (edge.toNodeId.startsWith(VISIT_PREFIX) || edge.toNodeId.startsWith(VISIT_INSTANCE_PREFIX))
    ) {
      visits.add(edge.toNodeId);
    }
  }
  return visits;
};

const allWorkstreamIds = (snapshot: ConnectionsSnapshot): Set<string> => {
  const ids = new Set<string>();
  for (const node of snapshot.nodes) {
    const workstreamId = workstreamIdFromNode(node.id);
    if (workstreamId !== null) ids.add(workstreamId);
  }
  return ids;
};

const candidateWorkstreamIds = (
  evidence: {
    readonly adjacency: ReadonlyMap<
      string,
      readonly { readonly to: string; readonly weight: number }[]
    >;
  },
  anchors: readonly string[],
  fallback: ReadonlySet<string>,
): Set<string> => {
  const reachable = new Set<string>();
  const seen = new Set<string>();
  const queue = [...anchors];
  for (const anchor of queue) seen.add(anchor);
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined) break;
    const workstreamId = workstreamIdFromNode(node);
    if (workstreamId !== null) reachable.add(workstreamId);
    for (const edge of evidence.adjacency.get(node) ?? []) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }
  return reachable.size > 0 ? reachable : new Set(fallback);
};

const negativeSeeds = (input: ResolveAttributionInput): Map<string, number> => {
  const seeds = new Map<string, number>();
  for (const event of input.events) {
    if (event.type === USER_FLOW_REJECTED && isUserFlowRejectedPayload(event.payload)) {
      seeds.set(event.payload.toId, -0.5);
    }
    if (event.type !== USER_ORGANIZED_ITEM || !isUserOrganizedItemPayload(event.payload)) continue;
    if (
      event.payload.itemKind === 'tab-session' &&
      event.payload.itemId === input.tabSessionId &&
      event.payload.toContainer === null &&
      typeof event.payload.fromContainer === 'string'
    ) {
      seeds.set(`${WORKSTREAM_PREFIX}${event.payload.fromContainer}`, -0.75);
    }
  }
  return seeds;
};

const evidenceReasons = (
  candidate: CandidateEvidence,
  anchors: readonly string[],
): readonly AttributionReason[] => {
  const reasons: AttributionReason[] = [];
  if (candidate.pprScore > 0) {
    reasons.push({
      source: 'ppr',
      summary: `Signed graph score ${candidate.pprScore.toFixed(3)}`,
      anchors,
    });
  }
  if (candidate.simTopScore > 0) {
    reasons.push({
      source: 'similarity',
      summary: `Similarity top ${candidate.simTopScore.toFixed(3)}, margin ${candidate.simMargin.toFixed(3)}`,
      anchors,
    });
  }
  if (candidate.clusterPosterior > 0) {
    reasons.push({
      source: 'cluster',
      summary: `Topic posterior ${candidate.clusterPosterior.toFixed(3)}`,
      anchors,
    });
  }
  return reasons;
};

export const resolveAttribution = (input: ResolveAttributionInput): ResolutionResult => {
  const mode = input.policyMode ?? 'balanced';
  const evidence = buildEvidenceGraph(input.snapshot);
  const tabNode = tabSessionNodeId(input.tabSessionId);
  const visits = targetVisitNodes(input.snapshot, input.tabSessionId);
  const anchors = [tabNode, ...[...visits].sort(compareString)].filter((anchor) =>
    evidence.graph.hasNode(anchor),
  );
  const seed = new Map<string, number>();
  for (const anchor of anchors) seed.set(anchor, 1);
  for (const [anchor, value] of negativeSeeds(input)) seed.set(anchor, value);

  const seedFingerprint = seedHash(seed);
  const evidenceHash = createHash('sha256')
    .update(`${MODEL_REVISION}|${input.tabSessionId}|${evidence.revision}|${seedFingerprint}`)
    .digest('hex');
  const cacheKey = `${input.tabSessionId}|${evidence.revision}|${seedFingerprint}`;
  const nowMs = input.nowMs ?? Date.now();
  const ppr = pprCache.get(cacheKey, nowMs) ?? runPPR(evidence, seed);
  pprCache.set(cacheKey, ppr, nowMs);

  const similarity = new Map(
    buildSimilarityEvidence({
      snapshot: input.snapshot,
      targetVisitNodeIds: visits,
      events: input.events,
      ...(input.closestVisitRanker === undefined
        ? {}
        : { closestVisitRanker: input.closestVisitRanker }),
    }).map((item) => [item.workstreamId, item]),
  );
  const cluster = new Map(
    buildClusterEvidence(input.snapshot, visits).map((item) => [item.workstreamId, item]),
  );
  const workstreamIds = candidateWorkstreamIds(evidence, anchors, allWorkstreamIds(input.snapshot));
  for (const key of similarity.keys()) workstreamIds.add(key);
  for (const key of cluster.keys()) workstreamIds.add(key);

  const candidateEvidence: CandidateEvidence[] = [...workstreamIds]
    .sort(compareString)
    .map((workstreamId) => {
      const sim = similarity.get(workstreamId);
      const clusterEvidence = cluster.get(workstreamId);
      const pprScore = Math.max(0, ppr.get(`${WORKSTREAM_PREFIX}${workstreamId}`) ?? 0);
      const corroborationCount =
        (pprScore > 0.01 ? 1 : 0) +
        ((sim?.simTopScore ?? 0) > 0 ? 1 : 0) +
        ((clusterEvidence?.posterior ?? 0) > 0 ? 1 : 0);
      return {
        workstreamId,
        pprScore,
        simTopScore: sim?.simTopScore ?? 0,
        simMeanScore: sim?.simMeanScore ?? 0,
        simAgreement: sim?.simAgreement ?? 0,
        simMargin: sim?.simMargin ?? 0,
        clusterPosterior: clusterEvidence?.posterior ?? 0,
        corroborationCount,
      };
    });

  const fusedCandidates = fuseCandidates(candidateEvidence)
    .filter((candidate) => candidate.corroborationCount > 0)
    .slice(0, 5)
    .map((candidate) => ({
      ...candidate,
      reasons: evidenceReasons(candidate, anchors.slice(0, 3)),
    }));
  const decision = decideAttribution(fusedCandidates, mode, input.policyTelemetry);

  return {
    tabSessionId: input.tabSessionId,
    dryRun: true,
    policyMode: mode,
    decision,
    fusedCandidates,
    reasons: {
      dependencyKey: cacheKey,
      modelRevision: MODEL_REVISION,
      graphRevision: evidence.revision,
      evidenceHash,
      targetAnchors: anchors,
      topContributingAnchors: anchors.slice(0, 3),
    },
  };
};

export const inferredAttributionPayloadFromResolution = (
  result: ResolutionResult,
): TabSessionAttributionInferredPayload | null => {
  if (result.decision.action !== 'auto-apply' || result.decision.workstreamId === undefined) {
    return null;
  }
  const top = result.fusedCandidates.find(
    (candidate) => candidate.workstreamId === result.decision.workstreamId,
  );
  if (top === undefined || top.dominantSource === 'none') return null;
  return {
    payloadVersion: 1,
    tabSessionId: result.tabSessionId,
    workstreamId: result.decision.workstreamId,
    policyMode: result.policyMode,
    dominantSource: top.dominantSource,
    rawFusionLogit: top.rawFusionLogit,
    margin: result.decision.margin,
    corroborationCount: top.corroborationCount,
    modelRevision: result.reasons.modelRevision,
    graphRevision: result.reasons.graphRevision,
    evidenceHash: result.reasons.evidenceHash,
    resolverDependencyKey: result.reasons.dependencyKey,
    reasonSummary:
      top.reasons
        .map((reason) => reason.summary)
        .filter((summary) => summary.length > 0)
        .join('; ') || `${top.dominantSource} evidence`,
  };
};

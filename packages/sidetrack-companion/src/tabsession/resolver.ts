import { createHash } from 'node:crypto';

import {
  USER_FLOW_REJECTED,
  USER_ORGANIZED_ITEM,
  isUserFlowRejectedPayload,
  isUserOrganizedItemPayload,
} from '../feedback/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { ConnectionNode, ConnectionsSnapshot } from '../connections/types.js';
import type { ClosestVisitRanker } from '../connections/snapshot.js';
import { seedHash, runPPR, createPprCache } from './causalPpr.js';
import { buildClusterEvidence } from './clusterEvidence.js';
import type { TabSessionAttributionInferredPayload } from './events.js';
import { buildEvidenceGraph } from './evidenceGraph.js';
import { fuseCandidates, type CandidateEvidence, type FusedCandidate } from './fusion.js';
import type { UrlAttributionInferredPayload } from '../urls/events.js';
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

// Enriched anchor — the resolver now ships kind + best-effort label
// alongside the raw node id so the extension's AttributionProvenance
// can render human-friendly text ("ChatGPT — sidetrack") instead of
// raw `tses_*` / `visit-instance:tses_*:date:url` strings. The
// resolver pulls `label` from the same connections graph the snapshot
// builds, with a fallback derived from the id prefix when the graph
// has no entry. The extension's reader accepts both this enriched
// shape and the legacy bare-string form for backward compat.
export interface AttributionAnchor {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
}

export interface AttributionReason {
  readonly source: 'ppr' | 'similarity' | 'cluster';
  readonly summary: string;
  readonly anchors: readonly AttributionAnchor[];
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
      (edge.fromNodeId.startsWith(VISIT_PREFIX) ||
        edge.fromNodeId.startsWith(VISIT_INSTANCE_PREFIX))
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

// Derive { kind, label } for an anchor node id from the connections
// snapshot. When the snapshot has a real ConnectionNode we use its
// label (which the snapshot builder has already hydrated with title
// and host fallbacks); otherwise we synthesize a kind-aware
// placeholder so the wire format never sends an unlabeled anchor.
// The extension's `formatAnchorDisplay` will further override with
// its live snapshot when the user has fresher metadata, but this
// gives audit-log readers and other consumers a usable label too.
const kindFromAnchorId = (id: string): string => {
  const colon = id.indexOf(':');
  return colon === -1 ? 'node' : id.slice(0, colon);
};

const enrichAnchor = (
  anchorId: string,
  nodeById: ReadonlyMap<string, ConnectionNode>,
): AttributionAnchor => {
  const node = nodeById.get(anchorId);
  const kind = node?.kind ?? kindFromAnchorId(anchorId);
  const label = node?.label && node.label.length > 0 ? node.label : '';
  return { id: anchorId, kind, label };
};

const evidenceReasons = (
  candidate: CandidateEvidence,
  anchors: readonly AttributionAnchor[],
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

// Per-canonical-URL resolver. Anchors are every visit-instance and
// timeline-visit node whose canonical URL matches the target. The
// resolver runs the same PPR + similarity + cluster + fusion pipeline
// as the tab-session resolver — only the seed set differs.
export interface ResolveUrlAttributionInput {
  readonly canonicalUrl: string;
  readonly snapshot: ConnectionsSnapshot;
  readonly events: readonly AcceptedEvent[];
  readonly policyMode?: AttributionPolicyMode;
  readonly policyTelemetry?: AttributionPolicyTelemetry;
  readonly nowMs?: number;
  readonly closestVisitRanker?: ClosestVisitRanker;
}

export interface UrlResolutionResult {
  readonly canonicalUrl: string;
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

const urlNegativeSeeds = (input: ResolveUrlAttributionInput): Map<string, number> => {
  const seeds = new Map<string, number>();
  for (const event of input.events) {
    if (event.type === USER_FLOW_REJECTED && isUserFlowRejectedPayload(event.payload)) {
      seeds.set(event.payload.toId, -0.5);
    }
    if (event.type !== USER_ORGANIZED_ITEM || !isUserOrganizedItemPayload(event.payload)) continue;
    if (
      event.payload.itemKind === 'canonical-url' &&
      event.payload.itemId === input.canonicalUrl &&
      event.payload.toContainer === null &&
      typeof event.payload.fromContainer === 'string'
    ) {
      seeds.set(`${WORKSTREAM_PREFIX}${event.payload.fromContainer}`, -0.75);
    }
  }
  return seeds;
};

const collectUrlAnchors = (
  snapshot: ConnectionsSnapshot,
  canonicalUrl: string,
): readonly string[] => {
  const out: string[] = [];
  const timelineVisitId = `timeline-visit:${canonicalUrl}`;
  if (snapshot.nodes.some((node) => node.id === timelineVisitId)) {
    out.push(timelineVisitId);
  }
  for (const node of snapshot.nodes) {
    if (node.kind !== 'visit-instance') continue;
    const nodeCanonical =
      typeof node.metadata.canonicalUrl === 'string'
        ? node.metadata.canonicalUrl
        : typeof node.metadata.url === 'string'
          ? node.metadata.url
          : undefined;
    if (nodeCanonical === canonicalUrl) out.push(node.id);
  }
  return out.sort(compareString);
};

export const resolveUrlAttribution = (input: ResolveUrlAttributionInput): UrlResolutionResult => {
  const mode = input.policyMode ?? 'balanced';
  const evidence = buildEvidenceGraph(input.snapshot);
  const anchors = collectUrlAnchors(input.snapshot, input.canonicalUrl).filter((anchor) =>
    evidence.graph.hasNode(anchor),
  );
  const seed = new Map<string, number>();
  for (const anchor of anchors) seed.set(anchor, 1);
  for (const [anchor, value] of urlNegativeSeeds(input)) seed.set(anchor, value);

  const seedFingerprint = seedHash(seed);
  const evidenceHash = createHash('sha256')
    .update(`${MODEL_REVISION}|url:${input.canonicalUrl}|${evidence.revision}|${seedFingerprint}`)
    .digest('hex');
  const cacheKey = `url:${input.canonicalUrl}|${evidence.revision}|${seedFingerprint}`;
  const nowMs = input.nowMs ?? Date.now();
  const ppr = pprCache.get(cacheKey, nowMs) ?? runPPR(evidence, seed);
  pprCache.set(cacheKey, ppr, nowMs);

  // For similarity/cluster, target the visit-instance / timeline-visit
  // anchors (same set as PPR's positive seeds).
  const similarity = new Map(
    buildSimilarityEvidence({
      snapshot: input.snapshot,
      targetVisitNodeIds: new Set(anchors),
      events: input.events,
      ...(input.closestVisitRanker === undefined
        ? {}
        : { closestVisitRanker: input.closestVisitRanker }),
    }).map((item) => [item.workstreamId, item]),
  );
  const cluster = new Map(
    buildClusterEvidence(input.snapshot, new Set(anchors)).map((item) => [item.workstreamId, item]),
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

  const nodeById = new Map<string, ConnectionNode>(
    input.snapshot.nodes.map((node) => [node.id, node] as const),
  );
  const enrichedAnchors: readonly AttributionAnchor[] = anchors
    .slice(0, 3)
    .map((anchorId) => enrichAnchor(anchorId, nodeById));

  const fusedCandidates = fuseCandidates(candidateEvidence)
    .filter((candidate) => candidate.corroborationCount > 0)
    .slice(0, 5)
    .map((candidate) => ({
      ...candidate,
      reasons: evidenceReasons(candidate, enrichedAnchors),
    }));
  const decision = decideAttribution(fusedCandidates, mode, input.policyTelemetry);

  return {
    canonicalUrl: input.canonicalUrl,
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

  // Build the enriched anchor list once and reuse across reasons.
  // Each anchor is { id, kind, label } where kind/label are pulled
  // from the connections snapshot (which hydrates tab-session labels
  // from the projection — see snapshot.ts).
  const nodeById = new Map<string, ConnectionNode>(
    input.snapshot.nodes.map((node) => [node.id, node] as const),
  );
  const enrichedAnchors: readonly AttributionAnchor[] = anchors
    .slice(0, 3)
    .map((anchorId) => enrichAnchor(anchorId, nodeById));

  const fusedCandidates = fuseCandidates(candidateEvidence)
    .filter((candidate) => candidate.corroborationCount > 0)
    .slice(0, 5)
    .map((candidate) => ({
      ...candidate,
      reasons: evidenceReasons(candidate, enrichedAnchors),
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

export const inferredUrlAttributionPayloadFromResolution = (
  result: UrlResolutionResult,
): UrlAttributionInferredPayload | null => {
  if (result.decision.action !== 'auto-apply' || result.decision.workstreamId === undefined) {
    return null;
  }
  const top = result.fusedCandidates.find(
    (candidate) => candidate.workstreamId === result.decision.workstreamId,
  );
  if (top === undefined || top.dominantSource === 'none') return null;
  return {
    payloadVersion: 1,
    canonicalUrl: result.canonicalUrl,
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

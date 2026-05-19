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

interface ResolveTargetAttributionInput {
  readonly targetKind: 'tab-session' | 'url' | 'thread';
  readonly targetId: string;
  readonly seedAnchorIds: readonly string[];
  readonly targetVisitNodeIds: readonly string[];
  readonly snapshot: ConnectionsSnapshot;
  readonly events: readonly AcceptedEvent[];
  readonly negativeSeeds: ReadonlyMap<string, number>;
  readonly policyMode?: AttributionPolicyMode;
  readonly policyTelemetry?: AttributionPolicyTelemetry;
  readonly nowMs?: number;
  readonly closestVisitRanker?: ClosestVisitRanker;
}

interface ResolvedTargetAttribution {
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

const uniqueSorted = (values: Iterable<string>): readonly string[] => [...new Set(values)].sort();

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
    const matched =
      candidate.simMatchedTerms === undefined || candidate.simMatchedTerms.length === 0
        ? ''
        : ` via ${candidate.simMatchedTerms.slice(0, 3).join(', ')}`;
    reasons.push({
      source: 'similarity',
      summary: `Similarity top ${candidate.simTopScore.toFixed(3)}, margin ${candidate.simMargin.toFixed(3)}${matched}`,
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

const resolveTargetAttribution = (
  input: ResolveTargetAttributionInput,
): ResolvedTargetAttribution => {
  const mode = input.policyMode ?? 'balanced';
  const evidence = buildEvidenceGraph(input.snapshot);
  const anchors = uniqueSorted(input.seedAnchorIds).filter((anchor) =>
    evidence.graph.hasNode(anchor),
  );
  const targetVisitAnchors = uniqueSorted(input.targetVisitNodeIds).filter((anchor) =>
    evidence.graph.hasNode(anchor),
  );
  const seed = new Map<string, number>();
  for (const anchor of anchors) seed.set(anchor, 1);
  for (const [anchor, value] of input.negativeSeeds) seed.set(anchor, value);

  const seedFingerprint = seedHash(seed);
  const evidenceHash = createHash('sha256')
    .update(
      `${MODEL_REVISION}|${input.targetKind}:${input.targetId}|${evidence.revision}|${seedFingerprint}`,
    )
    .digest('hex');
  const cacheKey = `${input.targetKind}:${input.targetId}|${evidence.revision}|${seedFingerprint}`;
  const nowMs = input.nowMs ?? Date.now();
  const ppr = pprCache.get(cacheKey, nowMs) ?? runPPR(evidence, seed);
  pprCache.set(cacheKey, ppr, nowMs);

  const similarity = new Map(
    buildSimilarityEvidence({
      snapshot: input.snapshot,
      targetVisitNodeIds: new Set(targetVisitAnchors),
      events: input.events,
      ...(input.closestVisitRanker === undefined
        ? {}
        : { closestVisitRanker: input.closestVisitRanker }),
    }).map((item) => [item.workstreamId, item]),
  );
  const cluster = new Map(
    buildClusterEvidence(input.snapshot, new Set(targetVisitAnchors)).map((item) => [
      item.workstreamId,
      item,
    ]),
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
        ...(sim?.simMatchedTerms === undefined ? {} : { simMatchedTerms: sim.simMatchedTerms }),
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

// "Not in any stream" is a definitive user decision (the latest
// USER_ORGANIZED_ITEM move for this url with toContainer === null),
// distinct from "unassigned / never decided". urlNegativeSeeds only
// down-weights a *prior* container, so a decline on a never-assigned
// url left no signal and the resolver re-emitted a fresh best-guess
// every resolve ("ask me again"). Detect the decline and settle.
const urlUserDeclinedNoWorkstream = (input: ResolveUrlAttributionInput): boolean => {
  let latest: { readonly at: number; readonly seq: number; readonly declined: boolean } | undefined;
  for (const event of input.events) {
    if (event.type !== USER_ORGANIZED_ITEM || !isUserOrganizedItemPayload(event.payload)) continue;
    const p = event.payload;
    if (p.itemKind !== 'canonical-url' || p.itemId !== input.canonicalUrl || p.action !== 'move') {
      continue;
    }
    const cand = { at: event.acceptedAtMs, seq: event.dot.seq, declined: p.toContainer === null };
    if (
      latest === undefined ||
      cand.at > latest.at ||
      (cand.at === latest.at && cand.seq > latest.seq)
    ) {
      latest = cand;
    }
  }
  return latest?.declined === true;
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

const stripFragmentAndTrailingSlash = (url: string): string =>
  url.replace(/#.*$/u, '').replace(/\/+$/u, '');

const collectThreadAnchors = (input: {
  readonly snapshot: ConnectionsSnapshot;
  readonly threadId: string;
  readonly providerThreadId?: string;
  readonly threadUrl?: string;
}): {
  readonly seedAnchorIds: readonly string[];
  readonly targetVisitNodeIds: readonly string[];
} => {
  const seedAnchorIds = new Set<string>();
  const canonicalUrls = new Set<string>();
  const threadNodeIds = new Set([`thread:${input.threadId}`]);
  if (input.providerThreadId !== undefined && input.providerThreadId.length > 0) {
    threadNodeIds.add(`thread:${input.providerThreadId}`);
  }
  if (input.threadUrl !== undefined && input.threadUrl.length > 0) {
    canonicalUrls.add(stripFragmentAndTrailingSlash(input.threadUrl));
  }

  for (const node of input.snapshot.nodes) {
    if (node.kind !== 'thread') continue;
    const metadataThreadId =
      typeof node.metadata.threadId === 'string' ? node.metadata.threadId : undefined;
    const metadataCanonical =
      typeof node.metadata.canonicalUrl === 'string'
        ? node.metadata.canonicalUrl
        : typeof node.metadata.url === 'string'
          ? node.metadata.url
          : undefined;
    if (
      threadNodeIds.has(node.id) ||
      metadataThreadId === input.threadId ||
      (input.providerThreadId !== undefined && metadataThreadId === input.providerThreadId) ||
      (metadataCanonical !== undefined &&
        canonicalUrls.has(stripFragmentAndTrailingSlash(metadataCanonical)))
    ) {
      seedAnchorIds.add(node.id);
      if (metadataCanonical !== undefined) {
        canonicalUrls.add(stripFragmentAndTrailingSlash(metadataCanonical));
      }
    }
  }
  for (const threadNodeId of threadNodeIds) {
    if (input.snapshot.nodes.some((node) => node.id === threadNodeId))
      seedAnchorIds.add(threadNodeId);
  }

  const targetVisitNodeIds = new Set<string>();
  for (const canonicalUrl of canonicalUrls) {
    for (const anchor of collectUrlAnchors(input.snapshot, canonicalUrl)) {
      seedAnchorIds.add(anchor);
      targetVisitNodeIds.add(anchor);
    }
  }
  return {
    seedAnchorIds: uniqueSorted(seedAnchorIds),
    targetVisitNodeIds: uniqueSorted(targetVisitNodeIds),
  };
};

export const resolveUrlAttribution = (input: ResolveUrlAttributionInput): UrlResolutionResult => {
  const anchors = collectUrlAnchors(input.snapshot, input.canonicalUrl);
  const resolved = resolveTargetAttribution({
    targetKind: 'url',
    targetId: input.canonicalUrl,
    seedAnchorIds: anchors,
    targetVisitNodeIds: anchors,
    snapshot: input.snapshot,
    events: input.events,
    negativeSeeds: urlNegativeSeeds(input),
    ...(input.policyMode === undefined ? {} : { policyMode: input.policyMode }),
    ...(input.policyTelemetry === undefined ? {} : { policyTelemetry: input.policyTelemetry }),
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
    ...(input.closestVisitRanker === undefined
      ? {}
      : { closestVisitRanker: input.closestVisitRanker }),
  });

  if (urlUserDeclinedNoWorkstream(input)) {
    // Respect the user's "Not in any stream": settle as no-suggestion
    // (the projection already records currentAttribution{ws:null}, so
    // it's out of the inbox list — this stops the active-tab card from
    // re-asking with a fresh best-guess).
    return {
      canonicalUrl: input.canonicalUrl,
      dryRun: true,
      ...resolved,
      decision: { action: 'inbox', margin: 0 },
      fusedCandidates: [],
    };
  }
  return {
    canonicalUrl: input.canonicalUrl,
    dryRun: true,
    ...resolved,
  };
};

export interface ResolveThreadAttributionInput {
  readonly threadId: string;
  readonly providerThreadId?: string;
  readonly threadUrl?: string;
  readonly snapshot: ConnectionsSnapshot;
  readonly events: readonly AcceptedEvent[];
  readonly policyMode?: AttributionPolicyMode;
  readonly policyTelemetry?: AttributionPolicyTelemetry;
  readonly nowMs?: number;
  readonly closestVisitRanker?: ClosestVisitRanker;
}

export interface ThreadResolutionResult {
  readonly threadId: string;
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

const threadNegativeSeeds = (input: ResolveThreadAttributionInput): Map<string, number> => {
  const seeds = new Map<string, number>();
  const canonicalUrl =
    input.threadUrl === undefined || input.threadUrl.length === 0
      ? undefined
      : stripFragmentAndTrailingSlash(input.threadUrl);
  for (const event of input.events) {
    if (event.type === USER_FLOW_REJECTED && isUserFlowRejectedPayload(event.payload)) {
      seeds.set(event.payload.toId, -0.5);
    }
    if (event.type !== USER_ORGANIZED_ITEM || !isUserOrganizedItemPayload(event.payload)) continue;
    const isThreadMove =
      event.payload.itemKind === 'thread' &&
      (event.payload.itemId === input.threadId ||
        (input.providerThreadId !== undefined && event.payload.itemId === input.providerThreadId));
    const isUrlMove =
      canonicalUrl !== undefined &&
      event.payload.itemKind === 'canonical-url' &&
      stripFragmentAndTrailingSlash(event.payload.itemId) === canonicalUrl;
    if (
      (isThreadMove || isUrlMove) &&
      event.payload.toContainer === null &&
      typeof event.payload.fromContainer === 'string'
    ) {
      seeds.set(`${WORKSTREAM_PREFIX}${event.payload.fromContainer}`, -0.75);
    }
  }
  return seeds;
};

export const resolveThreadAttribution = (
  input: ResolveThreadAttributionInput,
): ThreadResolutionResult => {
  const anchors = collectThreadAnchors(input);
  const resolved = resolveTargetAttribution({
    targetKind: 'thread',
    targetId: input.threadId,
    seedAnchorIds: anchors.seedAnchorIds,
    targetVisitNodeIds: anchors.targetVisitNodeIds,
    snapshot: input.snapshot,
    events: input.events,
    negativeSeeds: threadNegativeSeeds(input),
    ...(input.policyMode === undefined ? {} : { policyMode: input.policyMode }),
    ...(input.policyTelemetry === undefined ? {} : { policyTelemetry: input.policyTelemetry }),
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
    ...(input.closestVisitRanker === undefined
      ? {}
      : { closestVisitRanker: input.closestVisitRanker }),
  });
  return {
    threadId: input.threadId,
    dryRun: true,
    ...resolved,
  };
};

export const resolveAttribution = (input: ResolveAttributionInput): ResolutionResult => {
  const tabNode = tabSessionNodeId(input.tabSessionId);
  const visits = targetVisitNodes(input.snapshot, input.tabSessionId);
  const resolved = resolveTargetAttribution({
    targetKind: 'tab-session',
    targetId: input.tabSessionId,
    seedAnchorIds: [tabNode, ...visits],
    targetVisitNodeIds: [...visits],
    snapshot: input.snapshot,
    events: input.events,
    negativeSeeds: negativeSeeds(input),
    ...(input.policyMode === undefined ? {} : { policyMode: input.policyMode }),
    ...(input.policyTelemetry === undefined ? {} : { policyTelemetry: input.policyTelemetry }),
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
    ...(input.closestVisitRanker === undefined
      ? {}
      : { closestVisitRanker: input.closestVisitRanker }),
  });

  return {
    tabSessionId: input.tabSessionId,
    dryRun: true,
    ...resolved,
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

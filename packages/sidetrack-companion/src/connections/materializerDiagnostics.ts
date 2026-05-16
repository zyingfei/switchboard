// Sync Contract v1 / Class F — connections-materializer diagnostics.
//
// Stage 5 lock-1 deliverable. Every snapshot rebuild emits a counter
// struct that captures how much signal each stage of the pipeline
// produced. The bridge between Stage 1–3 producers and the live snapshot
// is dark in dogfood: similarity edges, topics, ranker training all
// silently produce zero artifacts. T1's purpose is to make that
// invisible failure visible — every subsequent track (T2–T6) is
// verified against the deltas in these counters, not against "the code
// runs."

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ENGAGEMENT_SESSION_AGGREGATED } from '../engagement/events.js';
import { TAB_SESSION_ATTRIBUTION_INFERRED } from '../tabsession/events.js';
import {
  USER_ORGANIZED_ITEM,
  USER_ORGANIZED_ITEM_KINDS,
  isUserOrganizedItemPayload,
  type UserOrganizedItemKind,
} from '../feedback/events.js';
import type { TopicRevision } from '../producers/topic-revision.js';
import type { RankerRetrainResult } from '../ranker/retrain.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { ConnectionsSnapshot, VisitSimilarityRevision } from './types.js';
import type { TopicShadowDiagnostics } from './topicShadowCandidate.js';
import type { EffectiveVisitSimilarityConfig } from './visitSimilarity.js';
import { URL_ATTRIBUTION_INFERRED } from '../urls/events.js';
import type { UrlProjection } from '../urls/projection.js';

export const MATERIALIZER_DIAGNOSTICS_SCHEMA_VERSION = 1;

const DIAGNOSTICS_RELATIVE_DIR = '_BAC/connections/diagnostics';
const DIAGNOSTICS_LATEST_FILENAME = 'latest.json';
const DIAGNOSTICS_HISTORY_DIRNAME = 'history';

export interface MaterializerTimelineCounters {
  readonly entryCount: number;
  readonly entriesWithTabSessionId: number;
  readonly entriesWithFocusedWindowMs: number;
  readonly engagementEligibleEntryCount: number;
  readonly engagementGateMs: number;
}

export interface MaterializerSimilarityCounters {
  readonly revisionId: string;
  readonly modelRevision: string;
  readonly threshold: number;
  readonly edgeCount: number;
  // Stage 5 / T2 — present when the revision came from the metadata
  // lexical fallback ('lexical') vs the embedding pipeline ('embedding',
  // or absent for older fixture data that pre-dates the field).
  readonly producer: 'embedding' | 'lexical' | 'unknown';
  // Stage 5.0 follow-up — the effective config the materializer
  // forwarded to `buildVisitSimilarity`, captured here so dogfood can
  // confirm env overrides actually took effect. Optional because the
  // collector accepts legacy input shapes that didn't carry it.
  readonly effectiveConfig?: {
    readonly threshold: number;
    readonly topK: number;
    readonly engagementGateMs: number;
    readonly lexicalThreshold: number;
    readonly lexicalFallbackEnabled: boolean;
  };
}

export interface MaterializerTopicCounters {
  readonly revisionId: string;
  readonly algorithmVersion: string;
  readonly topicCount: number;
  readonly memberCount: number;
  readonly componentSizes: readonly number[];
  readonly lineageCount: number;
}

export interface MaterializerRankerCounters {
  readonly status: RankerRetrainResult['status'] | 'not-run';
  readonly reason: string | null;
  readonly labelCount: number;
  readonly positiveLabelCount: number;
  readonly negativeLabelCount: number;
  readonly newLabelCount: number | null;
  readonly candidateCount: number | null;
  readonly revisionId: string | null;
  readonly error: string | null;
}

export type MaterializerUserAssertionsByKind = Readonly<Record<UserOrganizedItemKind, number>>;

export interface MaterializerUserAssertionCounters {
  readonly byItemKind: MaterializerUserAssertionsByKind;
  readonly total: number;
}

export interface MaterializerInferredEventCounters {
  readonly urlAttributionInferredCount: number;
  readonly tabSessionAttributionInferredCount: number;
}

// Stage 5 follow-up — diagnostic counters for the engagement
// subsystem, which is upstream of similarity / topic gates. Lets the
// operator distinguish "extension never emitted engagement events"
// (sessionAggregatedCount = 0) from "events arrived but recorded zero
// focused window" (count > 0 but sumFocusedWindowMs = 0).
export interface MaterializerEngagementCounters {
  readonly sessionAggregatedCount: number;
  readonly sumFocusedWindowMs: number;
  readonly maxFocusedWindowMs: number;
}

export interface MaterializerUrlCounters {
  readonly canonicalUrlCount: number;
  readonly attributedCanonicalUrlCount: number;
  readonly attributedByUserCanonicalUrlCount: number;
  // Stage 5 follow-up — per-source breakdown so the operator can
  // verify each propagation path is actually firing. Catches the
  // case where thread→URL propagation would have attributed a URL
  // but a direct user_asserted move beat it on tie-break (so the
  // total counts don't move, but the source-of-truth changes).
  readonly attributionBySource: Readonly<Record<string, number>>;
}

export interface MaterializerSnapshotCounters {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly visitInstanceCount: number;
  readonly attributedVisitInstanceCount: number;
  readonly unattributedVisitInstanceCount: number;
  readonly nodeCountByKind: Readonly<Record<string, number>>;
  readonly edgeCountByKind: Readonly<Record<string, number>>;
}

export interface MaterializerDiagnostics {
  readonly schemaVersion: typeof MATERIALIZER_DIAGNOSTICS_SCHEMA_VERSION;
  readonly producedAt: string;
  readonly maxAcceptedAtMs: number;
  readonly timeline: MaterializerTimelineCounters;
  readonly similarity: MaterializerSimilarityCounters;
  readonly topics: MaterializerTopicCounters;
  readonly ranker: MaterializerRankerCounters;
  readonly userAssertions: MaterializerUserAssertionCounters;
  readonly inferred: MaterializerInferredEventCounters;
  readonly engagement: MaterializerEngagementCounters;
  readonly urls: MaterializerUrlCounters;
  readonly snapshot: MaterializerSnapshotCounters;
  readonly shadowVsBaseline?: TopicShadowDiagnostics;
}

export interface MaterializerDiagnosticsInput {
  readonly producedAt: string;
  readonly maxAcceptedAtMs: number;
  readonly engagementGateMs: number;
  // Stage 5.0 follow-up — the materializer forwards the same struct
  // it gave `buildVisitSimilarity`. Optional so test fixtures that
  // pre-date the follow-up still compile.
  readonly similarityEffectiveConfig?: EffectiveVisitSimilarityConfig;
  readonly timelineEntries: readonly {
    readonly tabSessionId?: string;
    readonly dimensions?: unknown;
  }[];
  readonly visitSimilarity: VisitSimilarityRevision;
  readonly topicRevision: TopicRevision;
  readonly rankerRetrainResult: RankerRetrainResult | null;
  readonly events: readonly AcceptedEvent[];
  readonly urlProjection: UrlProjection;
  readonly snapshot: ConnectionsSnapshot;
  readonly topicShadowDiagnostics?: TopicShadowDiagnostics;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const focusedWindowMsOf = (dimensions: unknown): number | undefined => {
  if (!isRecord(dimensions)) return undefined;
  const engagement = dimensions['engagement'];
  if (!isRecord(engagement)) return undefined;
  const focused = engagement['focusedWindowMs'];
  if (typeof focused !== 'number' || !Number.isFinite(focused) || focused < 0) {
    return undefined;
  }
  return focused;
};

const emptyUserAssertionsByKind = (): Record<UserOrganizedItemKind, number> => {
  const out = {} as Record<UserOrganizedItemKind, number>;
  for (const kind of USER_ORGANIZED_ITEM_KINDS) {
    out[kind] = 0;
  }
  return out;
};

const collectTimelineCounters = (
  entries: MaterializerDiagnosticsInput['timelineEntries'],
  engagementGateMs: number,
): MaterializerTimelineCounters => {
  let entriesWithTabSessionId = 0;
  let entriesWithFocusedWindowMs = 0;
  let engagementEligibleEntryCount = 0;
  for (const entry of entries) {
    if (typeof entry.tabSessionId === 'string' && entry.tabSessionId.length > 0) {
      entriesWithTabSessionId += 1;
    }
    const focused = focusedWindowMsOf(entry.dimensions);
    if (focused !== undefined) {
      entriesWithFocusedWindowMs += 1;
      if (focused >= engagementGateMs) engagementEligibleEntryCount += 1;
    }
  }
  return {
    entryCount: entries.length,
    entriesWithTabSessionId,
    entriesWithFocusedWindowMs,
    engagementEligibleEntryCount,
    engagementGateMs,
  };
};

const collectSimilarityCounters = (
  revision: VisitSimilarityRevision,
  effectiveConfig: EffectiveVisitSimilarityConfig | undefined,
): MaterializerSimilarityCounters => ({
  revisionId: revision.revisionId,
  modelRevision: revision.modelRevision,
  threshold: revision.threshold,
  edgeCount: revision.edges.length,
  producer: revision.producer ?? 'unknown',
  ...(effectiveConfig === undefined
    ? {}
    : {
        effectiveConfig: {
          threshold: effectiveConfig.threshold,
          topK: effectiveConfig.topK,
          engagementGateMs: effectiveConfig.engagementGateMs,
          lexicalThreshold: effectiveConfig.lexicalThreshold,
          lexicalFallbackEnabled: effectiveConfig.lexicalFallbackEnabled,
        },
      }),
});

const collectTopicCounters = (revision: TopicRevision): MaterializerTopicCounters => {
  const componentSizes = revision.topics
    .map((topic) => topic.memberCanonicalUrls.length)
    .sort((left, right) => right - left);
  const memberCount = componentSizes.reduce((sum, size) => sum + size, 0);
  return {
    revisionId: revision.revisionId,
    algorithmVersion: revision.algorithmVersion,
    topicCount: revision.topics.length,
    memberCount,
    componentSizes,
    lineageCount: revision.lineage.length,
  };
};

const collectRankerCounters = (result: RankerRetrainResult | null): MaterializerRankerCounters => {
  if (result === null) {
    return {
      status: 'not-run',
      reason: null,
      labelCount: 0,
      positiveLabelCount: 0,
      negativeLabelCount: 0,
      newLabelCount: null,
      candidateCount: null,
      revisionId: null,
      error: null,
    };
  }
  switch (result.status) {
    case 'trained':
      return {
        status: 'trained',
        reason: null,
        labelCount: result.fingerprint.labelCount,
        positiveLabelCount: result.fingerprint.positiveLabelCount,
        negativeLabelCount: result.fingerprint.negativeLabelCount,
        newLabelCount: result.newLabelCount,
        candidateCount: result.candidateCount,
        revisionId: result.revisionId,
        error: null,
      };
    case 'skipped':
      return {
        status: 'skipped',
        reason: result.reason,
        labelCount: result.fingerprint.labelCount,
        positiveLabelCount: result.fingerprint.positiveLabelCount,
        negativeLabelCount: result.fingerprint.negativeLabelCount,
        newLabelCount: result.newLabelCount,
        candidateCount: result.candidateCount ?? null,
        revisionId: null,
        error: null,
      };
    case 'failed':
      return {
        status: 'failed',
        reason: null,
        labelCount: result.fingerprint.labelCount,
        positiveLabelCount: result.fingerprint.positiveLabelCount,
        negativeLabelCount: result.fingerprint.negativeLabelCount,
        newLabelCount: result.newLabelCount,
        candidateCount: result.candidateCount,
        revisionId: null,
        error: result.error,
      };
  }
};

const isRecordLite = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const focusedWindowMsFromEngagementPayload = (payload: unknown): number => {
  if (!isRecordLite(payload)) return 0;
  const dimensions = payload['dimensions'];
  if (!isRecordLite(dimensions)) return 0;
  const engagement = dimensions['engagement'];
  if (!isRecordLite(engagement)) return 0;
  const focused = engagement['focusedWindowMs'];
  if (typeof focused !== 'number' || !Number.isFinite(focused) || focused < 0) return 0;
  return focused;
};

const collectEventCounters = (
  events: readonly AcceptedEvent[],
): {
  readonly userAssertions: MaterializerUserAssertionCounters;
  readonly inferred: MaterializerInferredEventCounters;
  readonly engagement: MaterializerEngagementCounters;
} => {
  const byItemKind = emptyUserAssertionsByKind();
  let total = 0;
  let urlAttributionInferredCount = 0;
  let tabSessionAttributionInferredCount = 0;
  let sessionAggregatedCount = 0;
  let sumFocusedWindowMs = 0;
  let maxFocusedWindowMs = 0;
  for (const event of events) {
    if (event.type === USER_ORGANIZED_ITEM && isUserOrganizedItemPayload(event.payload)) {
      byItemKind[event.payload.itemKind] += 1;
      total += 1;
      continue;
    }
    if (event.type === URL_ATTRIBUTION_INFERRED) {
      urlAttributionInferredCount += 1;
      continue;
    }
    if (event.type === TAB_SESSION_ATTRIBUTION_INFERRED) {
      tabSessionAttributionInferredCount += 1;
      continue;
    }
    if (event.type === ENGAGEMENT_SESSION_AGGREGATED) {
      sessionAggregatedCount += 1;
      const focused = focusedWindowMsFromEngagementPayload(event.payload);
      sumFocusedWindowMs += focused;
      if (focused > maxFocusedWindowMs) maxFocusedWindowMs = focused;
      continue;
    }
  }
  return {
    userAssertions: { byItemKind, total },
    inferred: { urlAttributionInferredCount, tabSessionAttributionInferredCount },
    engagement: { sessionAggregatedCount, sumFocusedWindowMs, maxFocusedWindowMs },
  };
};

const collectUrlCounters = (projection: UrlProjection): MaterializerUrlCounters => {
  let attributedCanonicalUrlCount = 0;
  let attributedByUserCanonicalUrlCount = 0;
  const attributionBySource: Record<string, number> = {};
  for (const record of projection.byCanonicalUrl.values()) {
    const attribution = record.currentAttribution;
    if (attribution?.workstreamId === undefined || attribution.workstreamId === null) continue;
    attributedCanonicalUrlCount += 1;
    // Both direct URL moves and thread-derived attributions count as
    // user-driven for the diagnostic ratio. 'inferred' and tab-group
    // sources don't.
    if (attribution.source === 'user_asserted' || attribution.source === 'thread') {
      attributedByUserCanonicalUrlCount += 1;
    }
    attributionBySource[attribution.source] = (attributionBySource[attribution.source] ?? 0) + 1;
  }
  return {
    canonicalUrlCount: projection.byCanonicalUrl.size,
    attributedCanonicalUrlCount,
    attributedByUserCanonicalUrlCount,
    attributionBySource,
  };
};

const collectSnapshotCounters = (snapshot: ConnectionsSnapshot): MaterializerSnapshotCounters => {
  const nodeCountByKind: Record<string, number> = {};
  const edgeCountByKind: Record<string, number> = {};
  const visitInstanceNodeIds = new Set<string>();
  for (const node of snapshot.nodes) {
    nodeCountByKind[node.kind] = (nodeCountByKind[node.kind] ?? 0) + 1;
    if (node.kind === 'visit-instance') visitInstanceNodeIds.add(node.id);
  }
  const attributedVisitInstanceIds = new Set<string>();
  for (const edge of snapshot.edges) {
    edgeCountByKind[edge.kind] = (edgeCountByKind[edge.kind] ?? 0) + 1;
    if (edge.kind === 'visit_instance_in_workstream' && visitInstanceNodeIds.has(edge.fromNodeId)) {
      attributedVisitInstanceIds.add(edge.fromNodeId);
    }
  }
  const visitInstanceCount = visitInstanceNodeIds.size;
  const attributedVisitInstanceCount = attributedVisitInstanceIds.size;
  return {
    nodeCount: snapshot.nodes.length,
    edgeCount: snapshot.edges.length,
    visitInstanceCount,
    attributedVisitInstanceCount,
    unattributedVisitInstanceCount: visitInstanceCount - attributedVisitInstanceCount,
    nodeCountByKind,
    edgeCountByKind,
  };
};

export const collectMaterializerDiagnostics = (
  input: MaterializerDiagnosticsInput,
): MaterializerDiagnostics => {
  const eventCounters = collectEventCounters(input.events);
  return {
    schemaVersion: MATERIALIZER_DIAGNOSTICS_SCHEMA_VERSION,
    producedAt: input.producedAt,
    maxAcceptedAtMs: input.maxAcceptedAtMs,
    timeline: collectTimelineCounters(input.timelineEntries, input.engagementGateMs),
    similarity: collectSimilarityCounters(input.visitSimilarity, input.similarityEffectiveConfig),
    topics: collectTopicCounters(input.topicRevision),
    ranker: collectRankerCounters(input.rankerRetrainResult),
    userAssertions: eventCounters.userAssertions,
    inferred: eventCounters.inferred,
    engagement: eventCounters.engagement,
    urls: collectUrlCounters(input.urlProjection),
    snapshot: collectSnapshotCounters(input.snapshot),
    ...(input.topicShadowDiagnostics === undefined
      ? {}
      : { shadowVsBaseline: input.topicShadowDiagnostics }),
  };
};

export const summarizeMaterializerDiagnostics = (diagnostics: MaterializerDiagnostics): string => {
  const parts: string[] = [
    `nodes=${String(diagnostics.snapshot.nodeCount)}`,
    `edges=${String(diagnostics.snapshot.edgeCount)}`,
    `visits=${String(diagnostics.timeline.entryCount)}`,
    `engagementEligible=${String(diagnostics.timeline.engagementEligibleEntryCount)}`,
    `engagementEvents=${String(diagnostics.engagement.sessionAggregatedCount)}`,
    `simEdges=${String(diagnostics.similarity.edgeCount)}(${diagnostics.similarity.producer})`,
    `topics=${String(diagnostics.topics.topicCount)}`,
    `topicMembers=${String(diagnostics.topics.memberCount)}`,
    `ranker=${diagnostics.ranker.status}${diagnostics.ranker.reason === null ? '' : `:${diagnostics.ranker.reason}`}`,
    `labels=${String(diagnostics.ranker.labelCount)}(+${String(diagnostics.ranker.positiveLabelCount)}/-${String(diagnostics.ranker.negativeLabelCount)})`,
    `newLabels=${diagnostics.ranker.newLabelCount === null ? 'n/a' : String(diagnostics.ranker.newLabelCount)}`,
    `userAssertions=${String(diagnostics.userAssertions.total)}`,
    `inferredUrlAttr=${String(diagnostics.inferred.urlAttributionInferredCount)}`,
    `inferredTabSessionAttr=${String(diagnostics.inferred.tabSessionAttributionInferredCount)}`,
    `urlsAttributed=${String(diagnostics.urls.attributedCanonicalUrlCount)}/${String(diagnostics.urls.canonicalUrlCount)}`,
    `visitInstancesAttributed=${String(diagnostics.snapshot.attributedVisitInstanceCount)}/${String(diagnostics.snapshot.visitInstanceCount)}`,
  ];
  if (diagnostics.shadowVsBaseline !== undefined) {
    parts.push(
      `shadow=${diagnostics.shadowVsBaseline.candidate}`,
      `shadowTopics=${String(diagnostics.shadowVsBaseline.shadowTopicCount)}`,
      `shadowMax=${String(diagnostics.shadowVsBaseline.shadowMaxTopicSize)}`,
      `shadowNoise=${String(diagnostics.shadowVsBaseline.noiseShare)}`,
    );
  }
  return `[materializer-diag] ${parts.join(' ')}`;
};

export interface MaterializerDiagnosticsStore {
  readonly write: (diagnostics: MaterializerDiagnostics) => Promise<void>;
}

const safeFilenameTimestamp = (iso: string): string => iso.replace(/[:.]/gu, '-');

export const createMaterializerDiagnosticsStore = (
  vaultRoot: string,
): MaterializerDiagnosticsStore => {
  const dir = join(vaultRoot, DIAGNOSTICS_RELATIVE_DIR);
  const historyDir = join(dir, DIAGNOSTICS_HISTORY_DIRNAME);
  const latestPath = join(dir, DIAGNOSTICS_LATEST_FILENAME);
  const write = async (diagnostics: MaterializerDiagnostics): Promise<void> => {
    await mkdir(historyDir, { recursive: true });
    const body = `${JSON.stringify(diagnostics, null, 2)}\n`;
    const tmpPath = `${latestPath}.tmp`;
    await writeFile(tmpPath, body, 'utf8');
    await rename(tmpPath, latestPath);
    const historyPath = join(historyDir, `${safeFilenameTimestamp(diagnostics.producedAt)}.json`);
    await writeFile(historyPath, body, 'utf8');
  };
  return { write };
};

export const logMaterializerDiagnostics = (diagnostics: MaterializerDiagnostics): void => {
  console.warn(summarizeMaterializerDiagnostics(diagnostics));
};

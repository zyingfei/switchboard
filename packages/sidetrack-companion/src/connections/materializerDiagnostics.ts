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

import { mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { appendHealthHistory } from './healthHistory.js';

import { ENGAGEMENT_SESSION_AGGREGATED } from '../engagement/events.js';
import { TAB_SESSION_ATTRIBUTION_INFERRED } from '../tabsession/events.js';
import {
  USER_ORGANIZED_ITEM,
  USER_ORGANIZED_ITEM_KINDS,
  isUserOrganizedItemPayload,
  type UserOrganizedItemKind,
} from '../feedback/events.js';
import type { TopicRevision } from '../producers/topic-revision.js';
import { FEATURE_SCHEMA_VERSION } from '../ranker/feature-schema.js';
import type { RankerRetrainResult } from '../ranker/retrain.js';
import { RANKER_MODEL_VERSION, type RankerTrainQuality } from '../ranker/train.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { ConnectionsSnapshot, VisitSimilarityRevision } from './types.js';
import type { TopicShadowDiagnostics } from './topicShadowCandidate.js';
import type { TopicShadowObservationDiagnostics } from './topicShadowObservation.js';
import type { HotPathDiagnostics } from './hotPathMode.js';
import type { ServedTopicProducerReport } from './servedTopicProducer.js';
import {
  DriftMonitor,
  extractDriftSamples,
  loadDriftMonitor,
  persistDriftMonitor,
  type DriftReport,
} from './drift/driftMonitor.js';
import { createDriftStateStore, type DriftStateStore } from './drift/driftStateStore.js';
import { edgeKindIsPairwiseRelatedness } from './edgeSemantics.js';
import type { SilhouetteSimilarityEdge, SilhouetteTopic } from './drift/temporalSilhouette.js';
import type { EffectiveVisitSimilarityConfig } from './visitSimilarity.js';
import type { SimilarityFloorDiagnostics } from './similarityFloorGuard.js';
import type { PageEvidenceRecord } from '../page-evidence/types.js';
import { URL_ATTRIBUTION_INFERRED } from '../urls/events.js';
import type { UrlProjection } from '../urls/projection.js';

export const MATERIALIZER_DIAGNOSTICS_SCHEMA_VERSION = 1;

const DIAGNOSTICS_RELATIVE_DIR = '_BAC/connections/diagnostics';
const DIAGNOSTICS_LATEST_FILENAME = 'latest.json';
const DIAGNOSTICS_HISTORY_DIRNAME = 'history';
// Bounded retention for the per-drain history files. This dir had NO
// pruner — it grew one JSON per drain forever (observed at 4k+ files),
// and the reconcile path re-walked it, compounding the constant-CPU
// runaway. The health-history ring (HEALTH_HISTORY_MAX) is the trend
// source; this dir is ad-hoc forensics, so a few hundred is plenty.
export const DIAGNOSTICS_HISTORY_MAX = 240;
const TIMELINE_VISIT_PREFIX = 'timeline-visit:';
const WORKSTREAM_PREFIX = 'workstream:';

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
  readonly contentEnrichedEdges: number;
  readonly metadataOnlyEdges: number;
  readonly mixedTierEdges: number;
  readonly avgEvidenceConfidence: number;
  readonly vectorSkippedMissingCount: number;
  readonly vectorSkippedModelMismatchCount: number;
  readonly topMatchedTerms: readonly string[];
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

export type MaterializerRankerAugmentationStatus =
  | 'not-run'
  | 'skipped'
  | 'absent'
  | 'emitted'
  | 'failed';

export type MaterializerRankerModelFreshness = 'fresh' | 'stale' | 'unknown' | null;

type RankerMethodologySpine = NonNullable<RankerTrainQuality['methodologySpine']>;

export interface MaterializerRankerMethodologySpineDiagnostics {
  readonly servingGateEnforced: boolean;
  readonly split: RankerMethodologySpine['split'];
  readonly shipGate: RankerMethodologySpine['shipGate'];
}

export interface MaterializerRankerAugmentationCounters {
  readonly status: MaterializerRankerAugmentationStatus;
  readonly reason: string | null;
  readonly activeRevisionId: string | null;
  readonly activeModelVersion: string | null;
  readonly expectedModelVersion: string;
  readonly activeFeatureSchemaVersion: number | null;
  readonly expectedFeatureSchemaVersion: number;
  readonly needsRetrain: boolean;
  readonly modelFreshness: MaterializerRankerModelFreshness;
  readonly methodologySpine: MaterializerRankerMethodologySpineDiagnostics | null;
  readonly baseEdgeCount: number;
  readonly finalEdgeCount: number;
  readonly closestVisitEdgeCount: number;
  readonly rankerSourceEdgeCount: number;
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

export interface MaterializerPairEvidenceCounters {
  // Counts candidate-source metadata on emitted closest_visit edges.
  // `same_workstream` must stay zero/absent; workstream membership is
  // graph scope, not pairwise evidence.
  readonly candidatesBySource: Readonly<Record<string, number>>;
  readonly closestVisitEdgesByPrimarySource: Readonly<Record<string, number>>;
  readonly sameWorkstreamCandidateSourceCount: number;
  readonly membershipOnlyClosestVisitEdgeCount: number;
  readonly membershipOnlyPairEdgesBlocked: number;
}

export interface MaterializerPageEvidenceCounters {
  readonly metadataOnlyCount: number;
  readonly featuresOnlyCount: number;
  readonly indexedChunkCount: number;
  readonly contentVectorReadyCount: number;
  readonly contentVectorMissingCount: number;
  readonly contentVectorDisabledCount: number;
  readonly contentVectorFailedCount: number;
  readonly avgTopTermCount: number;
  readonly featureOnlyPages: number;
}

export interface MaterializerPhaseDuration {
  readonly label: string;
  readonly durationMs: number;
  readonly totalMs: number;
}

export interface MaterializerLatencyCounters {
  readonly pageEvidence: {
    readonly evidenceReadP95Ms: number;
    readonly vectorMapReadP95Ms: number;
    readonly chunkReadP95Ms: number;
  };
  readonly contentSimilarity: {
    readonly pairScoringP95Ms: number;
    readonly buildP95Ms: number;
  };
  readonly snapshot: {
    readonly rebuildP95Ms: number;
    readonly baseRebuildP95Ms: number;
    readonly rankerAugmentedRebuildP95Ms: number;
  };
  readonly phases: {
    readonly readMergedP95Ms: number;
    readonly readVaultStoresP95Ms: number;
    readonly buildTimelineDaysP95Ms: number;
    readonly engagementClassifierP95Ms: number;
    readonly topicRevisionP95Ms: number;
    readonly topicShadowP95Ms: number;
    readonly rankerRetrainerP95Ms: number;
    readonly rankerLoadP95Ms: number;
    readonly putCurrentP95Ms: number;
  };
}

export interface MaterializerDiagnostics {
  readonly schemaVersion: typeof MATERIALIZER_DIAGNOSTICS_SCHEMA_VERSION;
  readonly producedAt: string;
  readonly maxAcceptedAtMs: number;
  readonly timeline: MaterializerTimelineCounters;
  readonly similarity: MaterializerSimilarityCounters;
  readonly topics: MaterializerTopicCounters;
  readonly ranker: MaterializerRankerCounters;
  readonly rankerAugmentation: MaterializerRankerAugmentationCounters;
  readonly userAssertions: MaterializerUserAssertionCounters;
  readonly inferred: MaterializerInferredEventCounters;
  readonly engagement: MaterializerEngagementCounters;
  readonly urls: MaterializerUrlCounters;
  readonly snapshot: MaterializerSnapshotCounters;
  readonly pairEvidence: MaterializerPairEvidenceCounters;
  readonly pageEvidence?: MaterializerPageEvidenceCounters;
  readonly latency?: MaterializerLatencyCounters;
  readonly shadowVsBaseline?: TopicShadowDiagnostics;
  readonly shadowObservation?: TopicShadowObservationDiagnostics;
  // U2 — incremental hot-path decision + cheap counters (similarity +
  // topics). Always present (the materializer always produces it).
  readonly hotPath?: HotPathDiagnostics;
  // Served-signal floor guard (flapping fix). Present on every drain that
  // produced a similarity revision. `suppressedCollapse` / the running
  // `suppressedCollapseCount` are what /v1/system/health flips non-ok on.
  readonly similarityFloor?: SimilarityFloorDiagnostics;
  // W2 — which clustering produced the served revision + its
  // churn/lineage vs the previous served (auto-rollback signal).
  readonly servedTopicProducer?: ServedTopicProducerReport;
  // Statistical drift/evaluation layer. Optional: present once the
  // drift monitor has run for the drain. Absent for legacy fixtures
  // and for the pure `collectMaterializerDiagnostics` path (which does
  // no I/O); `attachDriftReport` folds it in after the monitor runs.
  readonly drift?: DriftReport;
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
  readonly rankerAugmentation?: MaterializerRankerAugmentationCounters;
  readonly events: readonly AcceptedEvent[];
  readonly urlProjection: UrlProjection;
  readonly snapshot: ConnectionsSnapshot;
  readonly pageEvidenceRecords?: readonly PageEvidenceRecord[];
  readonly phaseDurations?: readonly MaterializerPhaseDuration[];
  readonly topicShadowDiagnostics?: TopicShadowDiagnostics;
  readonly topicShadowObservation?: TopicShadowObservationDiagnostics;
  readonly hotPathDiagnostics?: HotPathDiagnostics;
  readonly servedTopicProducerReport?: ServedTopicProducerReport;
  readonly similarityFloorDiagnostics?: SimilarityFloorDiagnostics;
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

const collectPageEvidenceCounters = (
  records: readonly PageEvidenceRecord[],
): MaterializerPageEvidenceCounters => {
  const metadataOnlyCount = records.filter(
    (record) => record.evidenceTier === 'metadata_only',
  ).length;
  const featuresOnlyCount = records.filter(
    (record) => record.evidenceTier === 'content_features_only',
  ).length;
  const indexedChunkCount = records.filter(
    (record) => record.evidenceTier === 'indexed_chunks',
  ).length;
  const contentRecords = records.filter((record) => record.content !== undefined);
  const contentVectorDisabledCount = contentRecords.filter(
    (record) => record.content?.embeddingState === 'disabled',
  ).length;
  const contentVectorFailedCount = contentRecords.filter(
    (record) => record.content?.embeddingState === 'failed',
  ).length;
  return {
    metadataOnlyCount,
    featuresOnlyCount,
    indexedChunkCount,
    contentVectorReadyCount: contentRecords.filter(
      (record) => record.content?.docEmbeddingRef !== undefined,
    ).length,
    contentVectorMissingCount: contentRecords.filter(
      (record) =>
        record.content?.docEmbeddingRef === undefined &&
        record.content?.embeddingState !== 'disabled' &&
        record.content?.embeddingState !== 'failed',
    ).length,
    contentVectorDisabledCount,
    contentVectorFailedCount,
    avgTopTermCount:
      records.length === 0
        ? 0
        : Number(
            (
              records.reduce((sum, record) => sum + (record.content?.terms.length ?? 0), 0) /
              records.length
            ).toFixed(2),
          ),
    featureOnlyPages: featuresOnlyCount,
  };
};

const p95 = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return Number((sorted[index] ?? 0).toFixed(3));
};

const collectLatencyCounters = (
  phaseDurations: readonly MaterializerPhaseDuration[] | undefined,
): MaterializerLatencyCounters | undefined => {
  if (phaseDurations === undefined || phaseDurations.length === 0) return undefined;
  const labelNumber = (label: string, key: string): number | undefined => {
    const match = new RegExp(`(?:^| )${key}=([0-9]+(?:\\.[0-9]+)?)`, 'u').exec(label);
    if (match?.[1] === undefined) return undefined;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  const durationsFor = (prefixes: readonly string[]): readonly number[] =>
    phaseDurations
      .filter((phase) => prefixes.some((prefix) => phase.label.startsWith(prefix)))
      .map((phase) => phase.durationMs);
  const phaseP95 = (prefixes: readonly string[]): number => p95(durationsFor(prefixes));
  const perRecordDurationsFor = (
    prefixes: readonly string[],
    countKey: string,
  ): readonly number[] =>
    phaseDurations
      .filter((phase) => prefixes.some((prefix) => phase.label.startsWith(prefix)))
      .map((phase) => phase.durationMs / (labelNumber(phase.label, countKey) ?? 1));
  return {
    pageEvidence: {
      evidenceReadP95Ms: p95(perRecordDurationsFor(['pageEvidence.ensure'], 'records')),
      vectorMapReadP95Ms: phaseP95(['pageEvidence.vectorMapRead']),
      chunkReadP95Ms: phaseP95(['pageEvidence.chunkRead']),
    },
    contentSimilarity: {
      pairScoringP95Ms: p95(
        perRecordDurationsFor(['buildVisitSimilarity', 'buildVisitSimilarityIncremental'], 'pairs'),
      ),
      buildP95Ms: phaseP95(['buildVisitSimilarity', 'buildVisitSimilarityIncremental']),
    },
    snapshot: {
      rebuildP95Ms: p95(durationsFor(['buildConnectionsSnapshot'])),
      baseRebuildP95Ms: phaseP95(['buildConnectionsSnapshot base']),
      rankerAugmentedRebuildP95Ms: phaseP95([
        'buildConnectionsSnapshot ranker-augmented',
        'augmentConnectionsSnapshot ranker-augmented',
      ]),
    },
    phases: {
      readMergedP95Ms: phaseP95(['readMerged']),
      readVaultStoresP95Ms: phaseP95(['readVaultStores']),
      buildTimelineDaysP95Ms: phaseP95(['buildTimelineDays']),
      engagementClassifierP95Ms: phaseP95(['engagementClassifier']),
      topicRevisionP95Ms: phaseP95([
        'topicRevision',
        'buildTopicRevisionFromAccumulator',
        'putActiveTopicRevision',
      ]),
      topicShadowP95Ms: phaseP95(['topicShadowCandidate']),
      rankerRetrainerP95Ms: phaseP95(['rankerRetrainer']),
      rankerLoadP95Ms: phaseP95(['loadClosestVisitRanker']),
      putCurrentP95Ms: phaseP95(['putCurrent']),
    },
  };
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
): MaterializerSimilarityCounters => {
  const contentEnriched = revision.edges.filter(
    (edge) => edge.metadata?.producer === 'content-enriched',
  );
  const metadataOnly = revision.edges.filter((edge) => edge.metadata?.producer === 'metadata-only');
  const confidences = revision.edges.flatMap((edge) =>
    typeof edge.metadata?.confidence === 'number' ? [edge.metadata.confidence] : [],
  );
  const matchedTermCounts = new Map<string, number>();
  let vectorSkippedMissingCount = 0;
  let vectorSkippedModelMismatchCount = 0;
  for (const edge of revision.edges) {
    const metadata = edge.metadata;
    if (metadata === undefined) continue;
    if (
      metadata.evidenceTierFrom !== metadata.evidenceTierTo &&
      (metadata.evidenceTierFrom === 'metadata_only' || metadata.evidenceTierTo === 'metadata_only')
    ) {
      vectorSkippedMissingCount += 1;
    }
    if (
      metadata.evidenceTierFrom !== 'metadata_only' &&
      metadata.evidenceTierTo !== 'metadata_only' &&
      metadata.channels.contentVector === undefined
    ) {
      vectorSkippedModelMismatchCount += 1;
    }
    for (const term of metadata.matchedTerms ?? []) {
      matchedTermCounts.set(term, (matchedTermCounts.get(term) ?? 0) + 1);
    }
  }
  return {
    revisionId: revision.revisionId,
    modelRevision: revision.modelRevision,
    threshold: revision.threshold,
    edgeCount: revision.edges.length,
    producer: revision.producer ?? 'unknown',
    contentEnrichedEdges: contentEnriched.length,
    metadataOnlyEdges: metadataOnly.length,
    mixedTierEdges: revision.edges.filter(
      (edge) =>
        edge.metadata !== undefined &&
        edge.metadata.evidenceTierFrom !== edge.metadata.evidenceTierTo,
    ).length,
    avgEvidenceConfidence:
      confidences.length === 0
        ? 0
        : Number(
            (confidences.reduce((sum, value) => sum + value, 0) / confidences.length).toFixed(4),
          ),
    vectorSkippedMissingCount,
    vectorSkippedModelMismatchCount,
    topMatchedTerms: [...matchedTermCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 20)
      .map(([term]) => term),
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
  };
};

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

const collectDefaultRankerAugmentationCounters = (
  snapshot: ConnectionsSnapshot,
): MaterializerRankerAugmentationCounters => ({
  status: 'not-run',
  reason: null,
  activeRevisionId: null,
  activeModelVersion: null,
  expectedModelVersion: RANKER_MODEL_VERSION,
  activeFeatureSchemaVersion: null,
  expectedFeatureSchemaVersion: FEATURE_SCHEMA_VERSION,
  needsRetrain: false,
  modelFreshness: 'unknown',
  methodologySpine: null,
  baseEdgeCount: snapshot.edges.length,
  finalEdgeCount: snapshot.edges.length,
  closestVisitEdgeCount: snapshot.edges.filter((edge) => edge.kind === 'closest_visit').length,
  rankerSourceEdgeCount: snapshot.edges.filter((edge) => edge.producedBy.source === 'ranker')
    .length,
});

const metadataString = (
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | null => {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

const metadataStringList = (
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): readonly string[] => {
  const value = metadata?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
};

const incrementCounter = (record: Record<string, number>, key: string): void => {
  record[key] = (record[key] ?? 0) + 1;
};

const parsePrefixedId = (value: string, prefix: string): string | null => {
  if (!value.startsWith(prefix)) return null;
  const id = value.slice(prefix.length);
  return id.length > 0 ? id : null;
};

const addToSetMap = (map: Map<string, Set<string>>, key: string, value: string): void => {
  let set = map.get(key);
  if (set === undefined) {
    set = new Set<string>();
    map.set(key, set);
  }
  set.add(value);
};

const pairKey = (left: string, right: string): string =>
  left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;

const collectVisitWorkstreamMemberships = (
  snapshot: ConnectionsSnapshot,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const groups = new Map<string, Set<string>>();
  for (const edge of snapshot.edges) {
    if (edge.kind !== 'visit_in_workstream') continue;
    const visitId = parsePrefixedId(edge.fromNodeId, TIMELINE_VISIT_PREFIX);
    const workstreamId = parsePrefixedId(edge.toNodeId, WORKSTREAM_PREFIX);
    if (visitId === null || workstreamId === null) continue;
    addToSetMap(groups, workstreamId, visitId);
  }
  return groups;
};

const collectPairwiseRelatednessKeys = (snapshot: ConnectionsSnapshot): ReadonlySet<string> => {
  const keys = new Set<string>();
  for (const edge of snapshot.edges) {
    if (!edgeKindIsPairwiseRelatedness(edge.kind)) continue;
    const fromVisitId = parsePrefixedId(edge.fromNodeId, TIMELINE_VISIT_PREFIX);
    const toVisitId = parsePrefixedId(edge.toNodeId, TIMELINE_VISIT_PREFIX);
    if (fromVisitId === null || toVisitId === null || fromVisitId === toVisitId) continue;
    keys.add(pairKey(fromVisitId, toVisitId));
  }
  return keys;
};

const countMembershipOnlyPairsBlocked = (snapshot: ConnectionsSnapshot): number => {
  const groups = collectVisitWorkstreamMemberships(snapshot);
  if (groups.size === 0) return 0;
  const pairwiseRelatedness = collectPairwiseRelatednessKeys(snapshot);
  let blocked = 0;
  for (const visitIds of groups.values()) {
    const n = visitIds.size;
    if (n < 2) continue;
    blocked += (n * (n - 1)) / 2;
    const visits = [...visitIds];
    for (let left = 0; left < visits.length; left += 1) {
      for (let right = left + 1; right < visits.length; right += 1) {
        const leftVisit = visits[left];
        const rightVisit = visits[right];
        if (
          leftVisit !== undefined &&
          rightVisit !== undefined &&
          pairwiseRelatedness.has(pairKey(leftVisit, rightVisit))
        ) {
          blocked -= 1;
        }
      }
    }
  }
  return Math.max(0, blocked);
};

const collectPairEvidenceCounters = (
  snapshot: ConnectionsSnapshot,
): MaterializerPairEvidenceCounters => {
  const candidatesBySource: Record<string, number> = {};
  const closestVisitEdgesByPrimarySource: Record<string, number> = {};
  let sameWorkstreamCandidateSourceCount = 0;
  let membershipOnlyClosestVisitEdgeCount = 0;

  for (const edge of snapshot.edges) {
    if (edge.kind !== 'closest_visit') continue;
    const candidateSources = metadataStringList(edge.metadata, 'candidateSources');
    for (const source of candidateSources) {
      incrementCounter(candidatesBySource, source);
      if (source === 'same_workstream') sameWorkstreamCandidateSourceCount += 1;
    }
    const primarySource = metadataString(edge.metadata, 'primaryCandidateSource');
    if (primarySource !== null) incrementCounter(closestVisitEdgesByPrimarySource, primarySource);
    if (candidateSources.length === 1 && candidateSources[0] === 'same_workstream') {
      membershipOnlyClosestVisitEdgeCount += 1;
    }
  }

  return {
    candidatesBySource,
    closestVisitEdgesByPrimarySource,
    sameWorkstreamCandidateSourceCount,
    membershipOnlyClosestVisitEdgeCount,
    membershipOnlyPairEdgesBlocked: countMembershipOnlyPairsBlocked(snapshot),
  };
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
  const latency = collectLatencyCounters(input.phaseDurations);
  return {
    schemaVersion: MATERIALIZER_DIAGNOSTICS_SCHEMA_VERSION,
    producedAt: input.producedAt,
    maxAcceptedAtMs: input.maxAcceptedAtMs,
    timeline: collectTimelineCounters(input.timelineEntries, input.engagementGateMs),
    similarity: collectSimilarityCounters(input.visitSimilarity, input.similarityEffectiveConfig),
    topics: collectTopicCounters(input.topicRevision),
    ranker: collectRankerCounters(input.rankerRetrainResult),
    rankerAugmentation:
      input.rankerAugmentation ?? collectDefaultRankerAugmentationCounters(input.snapshot),
    userAssertions: eventCounters.userAssertions,
    inferred: eventCounters.inferred,
    engagement: eventCounters.engagement,
    urls: collectUrlCounters(input.urlProjection),
    snapshot: collectSnapshotCounters(input.snapshot),
    pairEvidence: collectPairEvidenceCounters(input.snapshot),
    ...(input.pageEvidenceRecords === undefined
      ? {}
      : { pageEvidence: collectPageEvidenceCounters(input.pageEvidenceRecords) }),
    ...(latency === undefined ? {} : { latency }),
    ...(input.topicShadowDiagnostics === undefined
      ? {}
      : { shadowVsBaseline: input.topicShadowDiagnostics }),
    ...(input.topicShadowObservation === undefined
      ? {}
      : { shadowObservation: input.topicShadowObservation }),
    ...(input.hotPathDiagnostics === undefined
      ? {}
      : { hotPath: input.hotPathDiagnostics }),
    ...(input.servedTopicProducerReport === undefined
      ? {}
      : { servedTopicProducer: input.servedTopicProducerReport }),
    ...(input.similarityFloorDiagnostics === undefined
      ? {}
      : { similarityFloor: input.similarityFloorDiagnostics }),
  };
};

export const rankerMethodologySpineDiagnosticsFromTrainQuality = (
  trainQuality: RankerTrainQuality | undefined,
): MaterializerRankerMethodologySpineDiagnostics | null => {
  const methodologySpine = trainQuality?.methodologySpine;
  if (methodologySpine === undefined) return null;
  return {
    servingGateEnforced: false,
    split: methodologySpine.split,
    shipGate: methodologySpine.shipGate,
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
    ...(diagnostics.similarityFloor === undefined
      ? []
      : [
          `simFloor=${
            diagnostics.similarityFloor.suppressedCollapse
              ? `SUPPRESSED(${String(diagnostics.similarityFloor.previousServedEdgeCount)}->${String(
                  diagnostics.similarityFloor.builtEdgeCount,
                )})`
              : diagnostics.similarityFloor.laneUnloadedReuse
                ? `REUSE(${String(diagnostics.similarityFloor.builtEdgeCount)}->${String(
                    diagnostics.similarityFloor.servedEdgeCount,
                  )})`
                : diagnostics.similarityFloor.bootstrapAdopted
                  ? `BOOTSTRAP(${String(diagnostics.similarityFloor.builtEdgeCount)}->${String(
                      diagnostics.similarityFloor.servedEdgeCount,
                    )})`
                  : (diagnostics.similarityFloor.allowedResetReason ?? 'ok')
          }`,
          // Round-3 render-layer surface — the served-artifact truth. The
          // rendered count is what resolvers actually read from current.db;
          // RENDER-REPAIRED marks a drain where the terminal rendered-edge
          // floor carried the previous similarity-family rows + endpoint nodes
          // forward because a window-poor node set stripped them.
          `simFloorRendered=${String(
            diagnostics.similarityFloor.renderedSimilarityFamilyEdgeCount,
          )}${diagnostics.similarityFloor.renderRepaired ? '(RENDER-REPAIRED)' : ''}`,
          `simFloorSuppressedTotal=${String(diagnostics.similarityFloor.suppressedCollapseCount)}`,
          `simFloorFlapping=${String(diagnostics.similarityFloor.flapping)}`,
        ]),
    `topics=${String(diagnostics.topics.topicCount)}`,
    `topicMembers=${String(diagnostics.topics.memberCount)}`,
    `ranker=${diagnostics.ranker.status}${diagnostics.ranker.reason === null ? '' : `:${diagnostics.ranker.reason}`}`,
    `rankerAug=${diagnostics.rankerAugmentation.status}${
      diagnostics.rankerAugmentation.reason === null
        ? ''
        : `:${diagnostics.rankerAugmentation.reason}`
    }${
      diagnostics.rankerAugmentation.modelFreshness === null
        ? ''
        : `:${diagnostics.rankerAugmentation.modelFreshness}`
    }`,
    `rankerNeedsRetrain=${String(diagnostics.rankerAugmentation.needsRetrain)}`,
    `closestVisit=${String(diagnostics.rankerAugmentation.closestVisitEdgeCount)}`,
    `rankerSource=${String(diagnostics.rankerAugmentation.rankerSourceEdgeCount)}`,
    `sameWorkstreamPairSources=${String(
      diagnostics.pairEvidence.sameWorkstreamCandidateSourceCount,
    )}`,
    `labels=${String(diagnostics.ranker.labelCount)}(+${String(diagnostics.ranker.positiveLabelCount)}/-${String(diagnostics.ranker.negativeLabelCount)})`,
    `newLabels=${diagnostics.ranker.newLabelCount === null ? 'n/a' : String(diagnostics.ranker.newLabelCount)}`,
    `userAssertions=${String(diagnostics.userAssertions.total)}`,
    `inferredUrlAttr=${String(diagnostics.inferred.urlAttributionInferredCount)}`,
    `inferredTabSessionAttr=${String(diagnostics.inferred.tabSessionAttributionInferredCount)}`,
    `urlsAttributed=${String(diagnostics.urls.attributedCanonicalUrlCount)}/${String(diagnostics.urls.canonicalUrlCount)}`,
    `visitInstancesAttributed=${String(diagnostics.snapshot.attributedVisitInstanceCount)}/${String(diagnostics.snapshot.visitInstanceCount)}`,
  ];
  const methodologySpine = diagnostics.rankerAugmentation.methodologySpine;
  if (methodologySpine !== null) {
    const split = methodologySpine.split;
    parts.push(
      `shipGate=${methodologySpine.shipGate.status}:${methodologySpine.shipGate.reason}`,
      `servingGateEnforced=${String(methodologySpine.servingGateEnforced)}`,
      split.status === 'available'
        ? `split=available:${String(split.trainGroupCount)}/${String(split.validationGroupCount)}/${String(split.testGroupCount)}`
        : `split=unavailable:${split.reason}`,
    );
  }
  if (diagnostics.shadowVsBaseline !== undefined) {
    parts.push(
      `shadow=${diagnostics.shadowVsBaseline.candidate}`,
      `shadowTopics=${String(diagnostics.shadowVsBaseline.shadowTopicCount)}`,
      `shadowMax=${String(diagnostics.shadowVsBaseline.shadowMaxTopicSize)}`,
      `shadowNoise=${String(diagnostics.shadowVsBaseline.noiseShare)}`,
      `shadowRuntimeMs=${String(diagnostics.shadowVsBaseline.runtimeMs)}`,
    );
  }
  if (diagnostics.shadowObservation !== undefined) {
    parts.push(
      `shadowAdjChurn=${
        diagnostics.shadowObservation.adjacentPerVisitChurn === undefined
          ? 'n/a'
          : String(diagnostics.shadowObservation.adjacentPerVisitChurn)
      }`,
      `shadowBoundaryChanged=${String(
        diagnostics.shadowObservation.shadowCollapseBoundaryChanged ?? false,
      )}`,
      `activeBoundaryChanged=${String(
        diagnostics.shadowObservation.activeCollapseBoundaryChanged ?? false,
      )}`,
      `shadowNoiseDelta=${
        diagnostics.shadowObservation.noiseShareDeltaFromPrevious === undefined
          ? 'n/a'
          : String(diagnostics.shadowObservation.noiseShareDeltaFromPrevious)
      }`,
    );
  }
  if (diagnostics.drift !== undefined) {
    const drift = diagnostics.drift;
    parts.push(
      `drift=${drift.status}`,
      ...(drift.trippedSignals.length === 0
        ? []
        : [`driftTripped=${drift.trippedSignals.join(',')}`]),
      ...(drift.warningSignals.length === 0 ? [] : [`driftWarn=${drift.warningSignals.join(',')}`]),
      `silhouette=${drift.silhouette.silhouette === null ? 'n/a' : String(drift.silhouette.silhouette)}`,
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
    // Bounded retention — prune oldest beyond DIAGNOSTICS_HISTORY_MAX.
    // safeFilenameTimestamp is ISO-derived (fixed-width, `:`/`.` -> `-`)
    // so lexicographic sort == chronological. Best-effort: observability
    // must never fail a drain.
    try {
      const historyFiles = (await readdir(historyDir))
        .filter((name) => name.endsWith('.json'))
        .sort();
      if (historyFiles.length > DIAGNOSTICS_HISTORY_MAX) {
        const stale = historyFiles.slice(0, historyFiles.length - DIAGNOSTICS_HISTORY_MAX);
        await Promise.all(
          stale.map((name) => unlink(join(historyDir, name)).catch(() => undefined)),
        );
      }
    } catch {
      /* prune is best-effort; never fail the drain */
    }
    // Feed the dumb fixed-window ring (plan TODO-H5). Best-effort:
    // observability must never break a drain, and the ring is the
    // trend source the Focus surface reads instead of scanning the
    // 3.5k-file history dir.
    try {
      const shadow = diagnostics.shadowVsBaseline;
      const observation = diagnostics.shadowObservation;
      // Post-W2 the idf-rkn shadow is retired from serving, so the
      // shadow* fields are perpetually null. Record the SERVED
      // producer's per-drain stats so the Focus "Drain trend" reads a
      // live series instead of a dead ring (F2).
      const served = diagnostics.servedTopicProducer;
      await appendHealthHistory(vaultRoot, {
        at: diagnostics.producedAt,
        adjacentPerVisitChurn: observation?.adjacentPerVisitChurn ?? null,
        shadowMaxTopicShare: shadow?.shadowMaxTopicShare ?? null,
        noiseShare: shadow?.noiseShare ?? null,
        shadowTopicCount: shadow?.shadowTopicCount ?? null,
        runtimeMs: shadow?.runtimeMs ?? null,
        vaultBytes: null,
        servedTopicCount: served?.topicCount ?? null,
        servedCoveredPages: served?.coveredPages ?? null,
        servedChurnP50: served?.churnP50 ?? null,
        servedChurnP90: served?.churnP90 ?? null,
        servedLineageContinue: served?.lineageContinue ?? null,
        servedLineageSplit: served?.lineageSplit ?? null,
        servedLineageMerge: served?.lineageMerge ?? null,
      });
    } catch {
      /* ring-buffer write is best-effort; never fail the drain */
    }
  };
  return { write };
};

// --- Statistical drift/evaluation layer wiring -------------------------
//
// `collectMaterializerDiagnostics` stays pure (no I/O). The drift
// monitor is stateful (detector windows persist across drains) so it
// is driven by a separate async step the materializer invokes after
// collecting diagnostics. `attachDriftReport` is the single integration
// seam: feed it the already-collected diagnostics + the topic/edge
// inputs and it returns the diagnostics with `drift` folded in.
//
// Failure contract (matches the existing diagnostics artifact):
// observability must NEVER fail the drain. Every persistence path is
// wrapped; on any I/O error the monitor degrades to "fresh state /
// not persisted" and the in-memory report is still produced.

export interface DriftMonitorRunInput {
  readonly diagnostics: MaterializerDiagnostics;
  readonly topics: readonly SilhouetteTopic[];
  readonly similarityEdges: readonly SilhouetteSimilarityEdge[];
  readonly stateStore?: DriftStateStore;
  readonly vaultRoot?: string;
  readonly updatedAt?: string;
}

export interface DriftMonitorRunResult {
  readonly diagnostics: MaterializerDiagnostics;
  readonly report: DriftReport;
  readonly statePersisted: boolean;
  readonly stateError: string | null;
}

const resolveDriftStateStore = (input: DriftMonitorRunInput): DriftStateStore | null => {
  if (input.stateStore !== undefined) return input.stateStore;
  if (input.vaultRoot !== undefined) return createDriftStateStore(input.vaultRoot);
  return null;
};

/**
 * Run the drift monitor for one drain and return the diagnostics with
 * the `drift` report folded in. The whole body is wrapped: if anything
 * here throws (it should not — the monitor and its store already
 * swallow I/O), the original diagnostics are returned unchanged with a
 * `stable` placeholder so the drain never fails on the drift layer.
 */
export const attachDriftReport = async (
  input: DriftMonitorRunInput,
): Promise<DriftMonitorRunResult> => {
  try {
    const store = resolveDriftStateStore(input);
    const monitor = store === null ? new DriftMonitor(null) : await loadDriftMonitor(store);
    const samples = extractDriftSamples({
      similarityEdgeCount: input.diagnostics.similarity.edgeCount,
      topicCount: input.diagnostics.topics.topicCount,
      topicMemberCount: input.diagnostics.topics.memberCount,
      snapshotEdgeCount: input.diagnostics.snapshot.edgeCount,
      ...(input.diagnostics.shadowVsBaseline === undefined
        ? {}
        : {
            shadow: {
              perVisitChurn: input.diagnostics.shadowVsBaseline.perVisitChurn,
              noiseShare: input.diagnostics.shadowVsBaseline.noiseShare,
              edgeCountBeforePruning: input.diagnostics.shadowVsBaseline.edgeCountBeforePruning,
              edgeCountAfterPruning: input.diagnostics.shadowVsBaseline.edgeCountAfterPruning,
              maxTopicSizeDelta: input.diagnostics.shadowVsBaseline.maxTopicSizeDelta,
            },
          }),
    });
    const report = monitor.observe({
      samples,
      revisionId: input.diagnostics.topics.revisionId,
      topics: input.topics,
      similarityEdges: input.similarityEdges,
    });
    const updatedAt = input.updatedAt ?? input.diagnostics.producedAt;
    const persistResult =
      store === null
        ? { persisted: false, error: null }
        : await persistDriftMonitor(store, monitor, updatedAt);
    return {
      diagnostics: { ...input.diagnostics, drift: report },
      report,
      statePersisted: persistResult.persisted,
      stateError: persistResult.error,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const fallback: DriftReport = {
      schemaVersion: 1,
      status: 'stable',
      trippedSignals: [],
      warningSignals: [],
      signals: [],
      silhouette: {
        revisionId: input.diagnostics.topics.revisionId,
        silhouette: null,
        previousSilhouette: null,
        delta: null,
        meanCohesion: 0,
        meanSeparation: 0,
        topicCount: 0,
      },
    };
    return {
      diagnostics: { ...input.diagnostics, drift: fallback },
      report: fallback,
      statePersisted: false,
      stateError: message,
    };
  }
};

export const logMaterializerDiagnostics = (diagnostics: MaterializerDiagnostics): void => {
  console.warn(summarizeMaterializerDiagnostics(diagnostics));
};

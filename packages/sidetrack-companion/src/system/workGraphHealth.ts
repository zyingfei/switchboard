import {
  readActiveClosestVisitRankerRevisionManifest,
  readClosestVisitRankerRevision,
} from '../producers/closest-visit-revision.js';
import { createTopicRevisionStore } from '../producers/topic-revision.js';
import { projectFeedback } from '../feedback/projection.js';
import { loadDefaultUsearch } from '../recall/ann-index.js';
import {
  fingerprintFeedbackTrainingLabels,
  planRankerRetrain,
  readRankerRetrainState,
  type RankerRetrainSkipReason,
} from '../ranker/retrain.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { EventLog } from '../sync/eventLog.js';

export interface WorkGraphHealthReport {
  readonly ranker: {
    readonly activeRevisionId: string | null;
    readonly loadStatus: 'missing' | 'ready' | 'invalid-model';
    readonly trainedAt: number | null;
    readonly trainingDatasetHash: string | null;
    readonly retrainSkipReason: RankerRetrainSkipReason | null;
    readonly retrainNewLabelCount: number;
  };
  readonly ann: {
    readonly backend: 'hnsw' | 'flat';
    readonly fallbackActive: boolean;
    readonly reason: string | null;
  };
  readonly feedback: {
    readonly actionCount: number;
    readonly positiveLabelCount: number;
    readonly negativeLabelCount: number;
  };
  readonly topicProducer: {
    readonly activeRevisionId: string | null;
    readonly algorithmVersion: string | null;
    readonly topicCount: number;
    readonly lineageCount: number;
  };
}

export interface WorkGraphHealthDeps {
  readonly vaultRoot: string;
  readonly eventLog?: EventLog;
}

const emptyEvents: readonly AcceptedEvent[] = [];

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const countFeedbackActions = (perItem: Record<string, readonly unknown[]>): number =>
  Object.values(perItem).reduce((count, actions) => count + actions.length, 0);

const annStatus = async (): Promise<WorkGraphHealthReport['ann']> => {
  try {
    await loadDefaultUsearch();
    return { backend: 'hnsw', fallbackActive: false, reason: null };
  } catch (error) {
    return { backend: 'flat', fallbackActive: true, reason: errorMessage(error) };
  }
};

export const collectWorkGraphHealth = async ({
  vaultRoot,
  eventLog,
}: WorkGraphHealthDeps): Promise<WorkGraphHealthReport> => {
  const merged = eventLog === undefined ? emptyEvents : await eventLog.readMerged();
  const feedback = projectFeedback(merged);
  const fingerprint = fingerprintFeedbackTrainingLabels(feedback);
  const [activeManifest, retrainState, ann, topicRevision] = await Promise.all([
    readActiveClosestVisitRankerRevisionManifest(vaultRoot),
    readRankerRetrainState(vaultRoot),
    annStatus(),
    createTopicRevisionStore(vaultRoot).readActiveRevision(),
  ]);
  const activeRevision =
    activeManifest === null
      ? null
      : await readClosestVisitRankerRevision(vaultRoot, activeManifest.revisionId);
  const retrainPlan = planRankerRetrain({ fingerprint, state: retrainState });
  return {
    ranker: {
      activeRevisionId: activeManifest?.revisionId ?? null,
      loadStatus:
        activeManifest === null ? 'missing' : activeRevision === null ? 'invalid-model' : 'ready',
      trainedAt: activeManifest?.trainedAt ?? null,
      trainingDatasetHash: activeManifest?.trainingDatasetHash ?? null,
      retrainSkipReason: retrainPlan.action === 'skip' ? retrainPlan.reason : null,
      retrainNewLabelCount: retrainPlan.newLabelCount,
    },
    ann,
    feedback: {
      actionCount: countFeedbackActions(feedback.perItem),
      positiveLabelCount: feedback.positiveLabels.length,
      negativeLabelCount: feedback.negativeLabels.length,
    },
    topicProducer: {
      activeRevisionId: topicRevision?.revisionId ?? null,
      algorithmVersion: topicRevision?.algorithmVersion ?? null,
      topicCount: topicRevision?.topics.length ?? 0,
      lineageCount: topicRevision?.lineage.length ?? 0,
    },
  };
};

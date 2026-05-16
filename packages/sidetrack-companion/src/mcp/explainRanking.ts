import { z } from 'zod';

import type { ConnectionsSnapshot } from '../connections/types.js';
import {
  readActiveClosestVisitRankerRevisionManifest,
  readClosestVisitRankerRevision,
} from '../producers/closest-visit-revision.js';
import {
  CANDIDATE_PAIR_FEATURE_KEYS,
  type CandidatePairFeatures,
} from '../ranker/feature-schema.js';
import { extractFeatures } from '../ranker/features.js';
import { loadRankerModel, predictRanker } from '../ranker/predict.js';
import type { Candidate } from '../ranker/types.js';
import type { AcceptedEvent } from '../sync/causal.js';

export const EXPLAIN_RANKING_TOOL_NAME = 'sidetrack.debug.explainRanking' as const;

export const explainRankingInputSchemaShape = {
  from: z.string().trim().min(1),
  to: z.string().trim().min(1),
} as const;

export const explainRankingInputSchema = z.object(explainRankingInputSchemaShape).strict();

export type ExplainRankingInput = z.infer<typeof explainRankingInputSchema>;

type FeatureKey = Exclude<keyof CandidatePairFeatures, 'schemaVersion'>;

export interface ExplainRankingContribution {
  readonly feature: FeatureKey;
  readonly weight: number;
}

export interface ExplainRankingReasonCode {
  readonly code: string;
  readonly payload: Record<string, unknown>;
}

export interface ExplainRankingOutput {
  readonly features: CandidatePairFeatures;
  readonly modelVersion: string;
  readonly revisionId: string;
  readonly score: number;
  readonly contributions: readonly ExplainRankingContribution[];
  readonly sortedReasonCodes: readonly ExplainRankingReasonCode[];
}

export interface ExplainRankingPrediction {
  readonly score: number;
  readonly contributions: Readonly<Record<keyof CandidatePairFeatures, number>>;
}

export interface ExplainRankingRanker {
  readonly revisionId: string;
  readonly modelVersion: string;
  readonly predict: (
    features: CandidatePairFeatures,
    candidate: Candidate,
  ) => ExplainRankingPrediction;
}

export interface LoadedExplainRankingRanker {
  readonly ranker: ExplainRankingRanker;
  readonly dispose?: () => void;
}

export interface ExplainRankingDeps {
  readonly readMergedEvents: () => Promise<readonly AcceptedEvent[]>;
  readonly readConnectionsSnapshot: () => Promise<ConnectionsSnapshot>;
  readonly loadActiveRanker: () => Promise<LoadedExplainRankingRanker | null>;
}

export class ExplainRankingError extends Error {
  constructor(
    readonly code: 'ranker-unavailable',
    message: string,
  ) {
    super(message);
  }
}

interface ReasonDefinition {
  readonly code: string;
  readonly features: readonly FeatureKey[];
  readonly payload: (features: CandidatePairFeatures) => Record<string, unknown> | null;
}

const roundDebugNumber = (value: number): number => Number(value.toFixed(6));

const stableFeatureObject = (features: CandidatePairFeatures): CandidatePairFeatures => {
  const out = {} as Record<keyof CandidatePairFeatures, number>;
  for (const key of CANDIDATE_PAIR_FEATURE_KEYS) {
    out[key] = features[key];
  }
  return out as CandidatePairFeatures;
};

const candidateFor = (input: ExplainRankingInput): Candidate => ({
  fromVisitId: input.from,
  toVisitId: input.to,
  sources: [],
  generatedAt: 0,
});

const featureKeys = CANDIDATE_PAIR_FEATURE_KEYS.filter(
  (key): key is FeatureKey => key !== 'schemaVersion',
);

const contributionArray = (
  contributions: Readonly<Record<keyof CandidatePairFeatures, number>>,
): readonly ExplainRankingContribution[] =>
  featureKeys.map((feature) => ({
    feature,
    weight: roundDebugNumber(contributions[feature]),
  }));

const topContributions = (
  contributions: readonly ExplainRankingContribution[],
  limit: number,
): readonly ExplainRankingContribution[] =>
  contributions
    .filter((entry) => entry.weight !== 0)
    .sort(
      (left, right) =>
        Math.abs(right.weight) - Math.abs(left.weight) || left.feature.localeCompare(right.feature),
    )
    .slice(0, Math.max(0, Math.floor(limit)));

const reasonDefinitions: readonly ReasonDefinition[] = [
  {
    code: 'OPENER_CHAIN',
    features: ['opener_chain_depth'],
    payload: (features) =>
      features.opener_chain_depth > 0 ? { depth: features.opener_chain_depth } : null,
  },
  {
    code: 'NAVIGATION_CHAIN',
    features: ['in_navigation_chain'],
    payload: (features) =>
      features.in_navigation_chain === 1 ? { feature: 'in_navigation_chain', value: 1 } : null,
  },
  {
    code: 'SAME_CANONICAL_URL',
    features: ['same_canonical_url'],
    payload: (features) =>
      features.same_canonical_url === 1 ? { feature: 'same_canonical_url', value: 1 } : null,
  },
  {
    code: 'SAME_HOST',
    features: ['same_host'],
    payload: (features) => (features.same_host === 1 ? { feature: 'same_host', value: 1 } : null),
  },
  {
    code: 'SAME_REPO',
    features: ['same_repo'],
    payload: (features) => (features.same_repo === 1 ? { feature: 'same_repo', value: 1 } : null),
  },
  {
    code: 'SAME_SEARCH_QUERY',
    features: ['same_search_query'],
    payload: (features) =>
      features.same_search_query === 1 ? { feature: 'same_search_query', value: 1 } : null,
  },
  {
    code: 'SAME_COPIED_SNIPPET',
    features: ['same_copied_snippet_count'],
    payload: (features) =>
      features.same_copied_snippet_count > 0 ? { count: features.same_copied_snippet_count } : null,
  },
  {
    code: 'SHARED_TITLE_TOKENS',
    features: ['shared_title_tokens'],
    payload: (features) =>
      features.shared_title_tokens > 0 ? { count: features.shared_title_tokens } : null,
  },
  {
    code: 'SHARED_PATH_TOKENS',
    features: ['shared_path_tokens'],
    payload: (features) =>
      features.shared_path_tokens > 0 ? { count: features.shared_path_tokens } : null,
  },
  {
    code: 'COSINE_SIMILARITY',
    features: ['cosine_similarity'],
    payload: (features) =>
      features.cosine_similarity > 0
        ? { value: roundDebugNumber(features.cosine_similarity) }
        : null,
  },
  {
    code: 'RECENCY',
    features: ['recency_score_from', 'recency_score_to'],
    payload: (features) =>
      features.recency_score_from > 0 || features.recency_score_to > 0
        ? {
            from: roundDebugNumber(features.recency_score_from),
            to: roundDebugNumber(features.recency_score_to),
          }
        : null,
  },
  {
    code: 'ENGAGEMENT_CLASS_MATCH',
    features: ['engagement_class_match'],
    payload: (features) =>
      features.engagement_class_match === 1
        ? { feature: 'engagement_class_match', value: 1 }
        : null,
  },
  {
    code: 'RETURN_COUNTS',
    features: ['return_count_from', 'return_count_to'],
    payload: (features) =>
      features.return_count_from > 0 || features.return_count_to > 0
        ? { from: features.return_count_from, to: features.return_count_to }
        : null,
  },
  {
    code: 'USER_ASSERTED_IN_THREAD',
    features: ['user_asserted_in_thread'],
    payload: (features) =>
      features.user_asserted_in_thread === 1
        ? { feature: 'user_asserted_in_thread', value: 1 }
        : null,
  },
];

const contributionWeightFor = (
  contributions: readonly ExplainRankingContribution[],
  features: readonly FeatureKey[],
): number => {
  const byFeature = new Map(contributions.map((entry) => [entry.feature, entry.weight] as const));
  let weight = 0;
  for (const feature of features) {
    weight = Math.max(weight, Math.abs(byFeature.get(feature) ?? 0));
  }
  return weight;
};

const sortedReasonCodes = (
  features: CandidatePairFeatures,
  score: number,
  contributions: readonly ExplainRankingContribution[],
): readonly ExplainRankingReasonCode[] => {
  const reasons = [
    {
      code: 'RANKER_SCORE',
      payload: {
        score,
        topContributions: topContributions(contributions, 3),
      },
      weight: Number.POSITIVE_INFINITY,
    },
    ...reasonDefinitions.flatMap((definition) => {
      const payload = definition.payload(features);
      if (payload === null) return [];
      return [
        {
          code: definition.code,
          payload,
          weight: contributionWeightFor(contributions, definition.features),
        },
      ];
    }),
  ];

  return reasons
    .sort((left, right) => right.weight - left.weight || left.code.localeCompare(right.code))
    .map(({ code, payload }) => ({ code, payload }));
};

export const explainRanking = async (
  rawInput: unknown,
  deps: ExplainRankingDeps,
): Promise<ExplainRankingOutput> => {
  const input = explainRankingInputSchema.parse(rawInput);
  const loadedRanker = await deps.loadActiveRanker();
  if (loadedRanker === null) {
    throw new ExplainRankingError(
      'ranker-unavailable',
      'No active closest-visit ranker revision is available.',
    );
  }

  try {
    const [mergedEvents, snapshot] = await Promise.all([
      deps.readMergedEvents(),
      deps.readConnectionsSnapshot(),
    ]);
    const candidate = candidateFor(input);
    const features = stableFeatureObject(
      extractFeatures(candidate, {
        merged: [...mergedEvents],
        snapshot,
      }),
    );
    const prediction = loadedRanker.ranker.predict(features, candidate);
    const score = roundDebugNumber(prediction.score);
    const contributions = contributionArray(prediction.contributions);

    return {
      features,
      modelVersion: loadedRanker.ranker.modelVersion,
      revisionId: loadedRanker.ranker.revisionId,
      score,
      contributions,
      sortedReasonCodes: sortedReasonCodes(features, score, contributions),
    };
  } finally {
    loadedRanker.dispose?.();
  }
};

export const loadActiveExplainRankingRanker = async (
  vaultRoot: string,
): Promise<LoadedExplainRankingRanker | null> => {
  const manifest = await readActiveClosestVisitRankerRevisionManifest(vaultRoot);
  if (manifest === null) return null;
  const revision = await readClosestVisitRankerRevision(vaultRoot, manifest.revisionId);
  if (revision === null) return null;
  const model = await loadRankerModel(revision);
  return {
    ranker: {
      revisionId: model.revisionId,
      modelVersion: model.modelVersion,
      predict: (features) => predictRanker(features, model),
    },
    dispose: () => {
      model.dispose();
    },
  };
};

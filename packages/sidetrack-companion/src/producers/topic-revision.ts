import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sha256Base64UrlPrefix } from '../connections/topicId.js';
import { createRevision } from '../domain/ids.js';

export const DEFAULT_TOPIC_COSINE_THRESHOLD = 0.85;
export const DEFAULT_TOPIC_ENGAGEMENT_GATE_MS = 5_000;
export const DEFAULT_TOPIC_WORKSTREAM_SHARE_THRESHOLD = 0.75;

// Env override mirroring SIDETRACK_SIMILARITY_THRESHOLD on the
// upstream producer. Keeps the production default at 0.85 (real
// e5-small embeddings cluster well above) while letting e2e fixtures
// that use the deterministic test embedder dial the gate down to
// what hashed token vectors can actually reach.
export const TOPIC_COSINE_THRESHOLD_ENV = 'SIDETRACK_TOPIC_COSINE_THRESHOLD';
export const resolveTopicCosineThreshold = (): number => {
  const raw = process.env[TOPIC_COSINE_THRESHOLD_ENV];
  if (raw === undefined || raw === '') return DEFAULT_TOPIC_COSINE_THRESHOLD;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    return DEFAULT_TOPIC_COSINE_THRESHOLD;
  }
  return parsed;
};
export const TOPIC_UNION_FIND_REVISION_KEY = 'topic-revision:v1:union-find' as const;
export const TOPIC_HDBSCAN_REVISION_KEY = 'topic-revision:v2:hdbscan' as const;
export const TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY =
  'topic-revision:shadow:idf-rkn-split' as const;
export const TOPIC_ALGORITHM_VERSION = TOPIC_UNION_FIND_REVISION_KEY;

export const TOPIC_REVISION_KEYS = [
  TOPIC_UNION_FIND_REVISION_KEY,
  TOPIC_HDBSCAN_REVISION_KEY,
  TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY,
] as const;

export type TopicAlgorithmVersion = (typeof TOPIC_REVISION_KEYS)[number];
export type TopicLineageKind = 'birth' | 'continue' | 'split' | 'merge' | 'death' | 'resurface';

export interface TopicNodeMetadata {
  readonly memberCount: number;
  readonly dominantWorkstreamId?: string;
  readonly medoidCanonicalUrl?: string;
  readonly stableSuggestionId?: string;
  readonly representativeTitles: readonly string[];
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly cohesion: number;
}

export type TopicSecondaryAffiliationReason =
  | 'edge_support'
  | 'member_similarity'
  | 'reciprocal_support'
  | 'term_overlap'
  | 'workstream_signal';

export interface TopicSecondaryAffiliation {
  readonly canonicalUrl: string;
  readonly score: number;
  readonly reasons: readonly TopicSecondaryAffiliationReason[];
  readonly supportCount: number;
  readonly maxCosine: number;
  readonly lexicalScore: number;
  readonly reciprocalSupport: number;
}

export interface TopicRevisionTopic {
  readonly topicId: string;
  readonly memberCanonicalUrls: readonly string[];
  readonly metadata: TopicNodeMetadata;
  readonly secondaryAffiliations?: readonly TopicSecondaryAffiliation[];
}

export interface TopicLineage {
  readonly fromTopicId: string;
  readonly toTopicId: string;
  readonly kind: TopicLineageKind;
  readonly observedAt: string;
}

export interface TopicRevision {
  readonly revisionId: string;
  readonly visitSimilarityRevisionId: string;
  readonly cosineThreshold: number;
  readonly algorithmVersion: TopicAlgorithmVersion;
  readonly topics: readonly TopicRevisionTopic[];
  readonly lineage: readonly TopicLineage[];
  readonly producedAt: number;
}

export interface TopicRevisionIdInput {
  readonly visitSimilarityRevisionId: string;
  readonly cosineThreshold: number;
  readonly algorithmVersion?: TopicAlgorithmVersion;
}

export const createTopicRevisionId = async (input: TopicRevisionIdInput): Promise<string> =>
  sha256Base64UrlPrefix(
    [
      input.visitSimilarityRevisionId,
      String(input.cosineThreshold),
      input.algorithmVersion ?? TOPIC_ALGORITHM_VERSION,
    ].join('\n'),
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isTopicLineageKind = (value: unknown): value is TopicLineageKind =>
  value === 'birth' ||
  value === 'continue' ||
  value === 'split' ||
  value === 'merge' ||
  value === 'death' ||
  value === 'resurface';

const isTopicAlgorithmVersion = (value: unknown): value is TopicAlgorithmVersion =>
  TOPIC_REVISION_KEYS.some((candidate) => candidate === value);

const isTopicNodeMetadata = (value: unknown): value is TopicNodeMetadata => {
  if (!isRecord(value)) return false;
  if (typeof value['memberCount'] !== 'number' || !Number.isInteger(value['memberCount'])) {
    return false;
  }
  if (
    value['dominantWorkstreamId'] !== undefined &&
    typeof value['dominantWorkstreamId'] !== 'string'
  ) {
    return false;
  }
  if (
    value['medoidCanonicalUrl'] !== undefined &&
    typeof value['medoidCanonicalUrl'] !== 'string'
  ) {
    return false;
  }
  if (
    value['stableSuggestionId'] !== undefined &&
    typeof value['stableSuggestionId'] !== 'string'
  ) {
    return false;
  }
  return (
    isStringArray(value['representativeTitles']) &&
    typeof value['firstObservedAt'] === 'string' &&
    typeof value['lastObservedAt'] === 'string' &&
    typeof value['cohesion'] === 'number' &&
    Number.isFinite(value['cohesion'])
  );
};

const isTopicRevisionTopic = (value: unknown): value is TopicRevisionTopic =>
  isRecord(value) &&
  typeof value['topicId'] === 'string' &&
  isStringArray(value['memberCanonicalUrls']) &&
  isTopicNodeMetadata(value['metadata']) &&
  (value['secondaryAffiliations'] === undefined ||
    (Array.isArray(value['secondaryAffiliations']) &&
      value['secondaryAffiliations'].every(isTopicSecondaryAffiliation)));

const TOPIC_SECONDARY_AFFILIATION_REASONS: readonly TopicSecondaryAffiliationReason[] = [
  'edge_support',
  'member_similarity',
  'reciprocal_support',
  'term_overlap',
  'workstream_signal',
];

const isTopicSecondaryAffiliationReason = (
  value: unknown,
): value is TopicSecondaryAffiliationReason =>
  typeof value === 'string' &&
  TOPIC_SECONDARY_AFFILIATION_REASONS.some((candidate) => candidate === value);

const isTopicSecondaryAffiliation = (value: unknown): value is TopicSecondaryAffiliation =>
  isRecord(value) &&
  typeof value['canonicalUrl'] === 'string' &&
  typeof value['score'] === 'number' &&
  Number.isFinite(value['score']) &&
  Array.isArray(value['reasons']) &&
  value['reasons'].every(isTopicSecondaryAffiliationReason) &&
  typeof value['supportCount'] === 'number' &&
  Number.isInteger(value['supportCount']) &&
  typeof value['maxCosine'] === 'number' &&
  Number.isFinite(value['maxCosine']) &&
  typeof value['lexicalScore'] === 'number' &&
  Number.isFinite(value['lexicalScore']) &&
  typeof value['reciprocalSupport'] === 'number' &&
  Number.isInteger(value['reciprocalSupport']);

const isTopicLineage = (value: unknown): value is TopicLineage =>
  isRecord(value) &&
  typeof value['fromTopicId'] === 'string' &&
  typeof value['toTopicId'] === 'string' &&
  isTopicLineageKind(value['kind']) &&
  typeof value['observedAt'] === 'string';

export const parseTopicRevision = (value: unknown): TopicRevision | null => {
  if (!isRecord(value)) return null;
  if (
    typeof value['revisionId'] !== 'string' ||
    typeof value['visitSimilarityRevisionId'] !== 'string' ||
    typeof value['cosineThreshold'] !== 'number' ||
    !Number.isFinite(value['cosineThreshold']) ||
    !isTopicAlgorithmVersion(value['algorithmVersion']) ||
    !Array.isArray(value['topics']) ||
    !value['topics'].every(isTopicRevisionTopic) ||
    !Array.isArray(value['lineage']) ||
    !value['lineage'].every(isTopicLineage) ||
    typeof value['producedAt'] !== 'number' ||
    !Number.isFinite(value['producedAt'])
  ) {
    return null;
  }
  return {
    revisionId: value['revisionId'],
    visitSimilarityRevisionId: value['visitSimilarityRevisionId'],
    cosineThreshold: value['cosineThreshold'],
    algorithmVersion: value['algorithmVersion'],
    topics: value['topics'],
    lineage: value['lineage'],
    producedAt: value['producedAt'],
  };
};

export interface TopicRevisionStore {
  readonly putRevision: (revision: TopicRevision) => Promise<void>;
  readonly putActiveRevision: (revision: TopicRevision) => Promise<void>;
  readonly putShadowRevision: (revision: TopicRevision) => Promise<void>;
  readonly putCandidateShadowRevision: (
    candidate: string,
    revision: TopicRevision,
  ) => Promise<void>;
  readonly readShadowRevision: () => Promise<TopicRevision | null>;
  readonly readCandidateShadowRevision: (candidate: string) => Promise<TopicRevision | null>;
  readonly readRevision: (revisionId: string) => Promise<TopicRevision | null>;
  readonly readActiveRevision: () => Promise<TopicRevision | null>;
  readonly listRevisionIds: () => Promise<readonly string[]>;
}

export const createTopicRevisionStore = (vaultRoot: string): TopicRevisionStore => {
  const root = join(vaultRoot, '_BAC', 'connections', 'topics');
  const currentPath = join(root, 'current.json');
  const shadowPath = join(root, 'current.shadow.json');
  const revisionPath = (revisionId: string): string => join(root, `${revisionId}.json`);
  const candidateKey = (candidate: string): string => candidate.replace(/[^a-zA-Z0-9_.-]/gu, '_');
  const candidateShadowPath = (candidate: string): string =>
    join(root, `current.${candidateKey(candidate)}.shadow.json`);

  const writeAtomic = async (path: string, body: string): Promise<void> => {
    await mkdir(join(path, '..'), { recursive: true });
    const tmp = `${path}.${createRevision()}.tmp`;
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, path);
  };

  const readTopicRevision = async (path: string): Promise<TopicRevision | null> => {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
      return parseTopicRevision(parsed);
    } catch {
      return null;
    }
  };

  const putRevision = async (revision: TopicRevision): Promise<void> => {
    await writeAtomic(revisionPath(revision.revisionId), JSON.stringify(revision, null, 2));
  };

  const putActiveRevision = async (revision: TopicRevision): Promise<void> => {
    await putRevision(revision);
    await writeAtomic(currentPath, JSON.stringify(revision, null, 2));
  };

  const putShadowRevision = async (revision: TopicRevision): Promise<void> => {
    await putRevision(revision);
    await writeAtomic(shadowPath, JSON.stringify(revision, null, 2));
  };

  const putCandidateShadowRevision = async (
    candidate: string,
    revision: TopicRevision,
  ): Promise<void> => {
    await putRevision(revision);
    await writeAtomic(candidateShadowPath(candidate), JSON.stringify(revision, null, 2));
  };

  const readRevision = async (revisionId: string): Promise<TopicRevision | null> =>
    readTopicRevision(revisionPath(revisionId));

  const readActiveRevision = async (): Promise<TopicRevision | null> =>
    readTopicRevision(currentPath);

  const readShadowRevision = async (): Promise<TopicRevision | null> =>
    readTopicRevision(shadowPath);

  const readCandidateShadowRevision = async (candidate: string): Promise<TopicRevision | null> =>
    readTopicRevision(candidateShadowPath(candidate));

  const listRevisionIds = async (): Promise<readonly string[]> => {
    const entries = await readdir(root).catch(() => [] as readonly string[]);
    return entries
      .filter((name) => name.endsWith('.json') && name !== 'current.json')
      .map((name) => name.replace(/\.json$/u, ''))
      .sort();
  };

  return {
    putRevision,
    putActiveRevision,
    putShadowRevision,
    putCandidateShadowRevision,
    readShadowRevision,
    readCandidateShadowRevision,
    readRevision,
    readActiveRevision,
    listRevisionIds,
  };
};

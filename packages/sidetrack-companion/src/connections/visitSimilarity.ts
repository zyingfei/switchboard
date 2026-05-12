import { createHash } from 'node:crypto';

import { buildAnnIndex } from '../recall/ann-index.js';
import { RECALL_MODEL } from '../recall/modelManifest.js';
import {
  buildLexicalIndex,
  rankHybrid,
  type IndexEntry,
} from '../recall/ranker.js';
import type { TimelineEntry } from '../timeline/projection.js';
import type { VisitSimilarityEdge, VisitSimilarityRevision } from './types.js';

export type VisitSimilarityEmbedder = (
  texts: readonly string[],
) => Promise<readonly Float32Array[]>;

export type VisitSimilarityEntry = TimelineEntry & {
  readonly dimensions?: unknown;
};

export interface BuildVisitSimilarityOptions {
  readonly threshold?: number;
  readonly topK?: number;
  readonly engagementGateMs?: number;
}

export const VISIT_SIMILARITY_MODEL_ID = 'Xenova/multilingual-e5-small' as const;
export const VISIT_SIMILARITY_FEATURE_SCHEMA_VERSION = 1;
export const VISIT_SIMILARITY_DEFAULT_THRESHOLD = 0.85;
export const VISIT_SIMILARITY_DEFAULT_TOP_K = 50;
export const VISIT_SIMILARITY_DEFAULT_ENGAGEMENT_GATE_MS = 5_000;

const PASSAGE_PREFIX = 'passage: ';
const QUERY_PREFIX = 'query: ';

interface NormalizedVisit {
  readonly visitKey: string;
  readonly lastSeenAt: string;
  readonly corpus: string;
  readonly focusedWindowMs: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stripFragmentAndTrailingSlash = (url: string): string =>
  url.replace(/#.*$/u, '').replace(/\/+$/u, '');

const normalizeSpaces = (value: string): string => value.replace(/\s+/gu, ' ').trim();

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const readFocusedWindowMs = (entry: VisitSimilarityEntry): number => {
  if (!isRecord(entry.dimensions)) return 0;
  const engagement = entry.dimensions['engagement'];
  if (!isRecord(engagement)) return 0;
  const focused = engagement['focusedWindowMs'];
  if (typeof focused !== 'number' || !Number.isFinite(focused) || focused < 0) {
    return 0;
  }
  return focused;
};

const pathTokensForUrl = (url: string): readonly string[] => {
  try {
    const parsed = new URL(url);
    return parsed.pathname
      .split('/')
      .map(safeDecode)
      .flatMap((part) => part.split(/[^A-Za-z0-9]+/u))
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length > 0);
  } catch {
    return [];
  }
};

const hostnameForUrl = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};

const corpusForEntry = (entry: VisitSimilarityEntry): string => {
  const url = entry.canonicalUrl ?? entry.url;
  return normalizeSpaces(
    [
      entry.title ?? '',
      hostnameForUrl(url),
      ...pathTokensForUrl(url),
    ].join(' '),
  );
};

const visitKeyForEntry = (entry: VisitSimilarityEntry): string =>
  stripFragmentAndTrailingSlash(entry.canonicalUrl ?? entry.url);

const preferNewEntry = (
  existing: NormalizedVisit,
  candidate: NormalizedVisit,
): NormalizedVisit => {
  const focusedWindowMs = Math.max(existing.focusedWindowMs, candidate.focusedWindowMs);
  if (candidate.lastSeenAt > existing.lastSeenAt) {
    return { ...candidate, focusedWindowMs };
  }
  if (candidate.lastSeenAt < existing.lastSeenAt) {
    return { ...existing, focusedWindowMs };
  }
  if (candidate.corpus.length > existing.corpus.length) {
    return { ...candidate, focusedWindowMs };
  }
  if (candidate.corpus.length < existing.corpus.length) {
    return { ...existing, focusedWindowMs };
  }
  return candidate.corpus < existing.corpus
    ? { ...candidate, focusedWindowMs }
    : { ...existing, focusedWindowMs };
};

const normalizeEntries = (
  entries: readonly VisitSimilarityEntry[],
): readonly NormalizedVisit[] => {
  const byKey = new Map<string, NormalizedVisit>();
  for (const entry of entries) {
    const visitKey = visitKeyForEntry(entry);
    if (visitKey.length === 0) continue;
    const candidate: NormalizedVisit = {
      visitKey,
      lastSeenAt: entry.lastSeenAt,
      corpus: corpusForEntry(entry),
      focusedWindowMs: readFocusedWindowMs(entry),
    };
    const existing = byKey.get(visitKey);
    byKey.set(visitKey, existing === undefined ? candidate : preferNewEntry(existing, candidate));
  }
  return [...byKey.values()].sort((left, right) =>
    left.visitKey < right.visitKey ? -1 : left.visitKey > right.visitKey ? 1 : 0,
  );
};

const clampThreshold = (threshold: number | undefined): number => {
  if (threshold === undefined) return VISIT_SIMILARITY_DEFAULT_THRESHOLD;
  if (!Number.isFinite(threshold)) return VISIT_SIMILARITY_DEFAULT_THRESHOLD;
  return Math.min(Math.max(threshold, 0), 1);
};

const clampTopK = (topK: number | undefined): number => {
  if (topK === undefined || !Number.isFinite(topK)) {
    return VISIT_SIMILARITY_DEFAULT_TOP_K;
  }
  return Math.max(1, Math.trunc(topK));
};

const clampEngagementGate = (engagementGateMs: number | undefined): number => {
  if (engagementGateMs === undefined || !Number.isFinite(engagementGateMs)) {
    return VISIT_SIMILARITY_DEFAULT_ENGAGEMENT_GATE_MS;
  }
  return Math.max(0, engagementGateMs);
};

const roundedCosine = (value: number): number => Number(value.toFixed(6));

const revisionIdFor = (input: {
  readonly modelRevision: string;
  readonly threshold: number;
  readonly topK: number;
  readonly engagementGateMs: number;
  readonly visits: readonly NormalizedVisit[];
}): string => {
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify({
      modelId: VISIT_SIMILARITY_MODEL_ID,
      modelRevision: input.modelRevision,
      featureSchemaVersion: VISIT_SIMILARITY_FEATURE_SCHEMA_VERSION,
      threshold: input.threshold,
      topK: input.topK,
      engagementGateMs: input.engagementGateMs,
      visits: input.visits.map((visit) => ({
        visitKey: visit.visitKey,
        corpus: visit.corpus,
        focusedWindowMs: visit.focusedWindowMs,
      })),
    }),
  );
  return hash.digest('hex').slice(0, 16);
};

const emptyRevision = (input: {
  readonly revisionId: string;
  readonly modelRevision: string;
  readonly threshold: number;
}): VisitSimilarityRevision => ({
  revisionId: input.revisionId,
  modelId: VISIT_SIMILARITY_MODEL_ID,
  modelRevision: input.modelRevision,
  featureSchemaVersion: VISIT_SIMILARITY_FEATURE_SCHEMA_VERSION,
  threshold: input.threshold,
  edges: [],
  producedAt: Date.now(),
});

const logMaterializerError = (error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.warn(`[materializer-error] visit-similarity embed failed: ${message}`);
};

const indexEntriesForVisits = (
  visits: readonly NormalizedVisit[],
  passageVectors: readonly Float32Array[],
): readonly IndexEntry[] =>
  visits.flatMap((visit, index): readonly IndexEntry[] => {
    const embedding = passageVectors[index];
    if (embedding === undefined) return [];
    return [
      {
        id: visit.visitKey,
        threadId: visit.visitKey,
        capturedAt: visit.lastSeenAt,
        embedding,
        replicaId: 'local',
        lamport: index + 1,
        tombstoned: false,
        metadata: {
          sourceBacId: visit.visitKey,
          title: visit.corpus,
          turnOrdinal: 0,
          headingPath: [],
          paragraphIndex: 0,
          charStart: 0,
          charEnd: visit.corpus.length,
          textHash: createHash('sha256').update(visit.corpus).digest('hex'),
          text: visit.corpus,
        },
      },
    ];
  });

// Stage 5.2 W3 — expose the revisionId computation so the materializer
// can compute the expected id and skip buildVisitSimilarity entirely
// when a revision with the same inputs already exists on disk. The
// hash is byte-deterministic over (model + threshold + topK + gate +
// per-visit corpus/focus), so two runs with the same input set yield
// the same revisionId.
export const computeVisitSimilarityRevisionId = (
  entries: readonly VisitSimilarityEntry[],
  options: BuildVisitSimilarityOptions = {},
): string => {
  const threshold = clampThreshold(options.threshold);
  const topK = clampTopK(options.topK);
  const engagementGateMs = clampEngagementGate(options.engagementGateMs);
  const modelRevision = RECALL_MODEL.revision;
  const visits = normalizeEntries(entries);
  return revisionIdFor({ modelRevision, threshold, topK, engagementGateMs, visits });
};

export const buildVisitSimilarity = async (
  entries: readonly VisitSimilarityEntry[],
  embed: VisitSimilarityEmbedder,
  options: BuildVisitSimilarityOptions = {},
): Promise<VisitSimilarityRevision> => {
  const threshold = clampThreshold(options.threshold);
  const topK = clampTopK(options.topK);
  const engagementGateMs = clampEngagementGate(options.engagementGateMs);
  const modelRevision = RECALL_MODEL.revision;
  const visits = normalizeEntries(entries);
  const revisionId = revisionIdFor({
    modelRevision,
    threshold,
    topK,
    engagementGateMs,
    visits,
  });
  const base = {
    revisionId,
    modelId: VISIT_SIMILARITY_MODEL_ID,
    modelRevision,
    featureSchemaVersion: VISIT_SIMILARITY_FEATURE_SCHEMA_VERSION,
    threshold,
    producedAt: Date.now(),
  } satisfies Omit<VisitSimilarityRevision, 'edges'>;

  const eligible = visits.filter((visit) => visit.focusedWindowMs >= engagementGateMs);
  if (eligible.length < 2) {
    return { ...base, edges: [] };
  }

  const passageTexts = eligible.map((visit) => `${PASSAGE_PREFIX}${visit.corpus}`);
  const queryTexts = eligible.map((visit) => `${QUERY_PREFIX}${visit.corpus}`);
  let embedded: readonly Float32Array[];
  try {
    embedded = await embed([...passageTexts, ...queryTexts]);
  } catch (error) {
    logMaterializerError(error);
    return emptyRevision({ revisionId, modelRevision, threshold });
  }
  if (embedded.length !== passageTexts.length + queryTexts.length) {
    logMaterializerError(
      new Error(
        `expected ${String(passageTexts.length + queryTexts.length)} embeddings, received ${String(embedded.length)}`,
      ),
    );
    return emptyRevision({ revisionId, modelRevision, threshold });
  }

  const passageVectors = embedded.slice(0, passageTexts.length);
  const queryVectors = embedded.slice(passageTexts.length);
  const indexEntries = indexEntriesForVisits(eligible, passageVectors);
  const vectorIndex = await buildAnnIndex({
    revisionId,
    items: indexEntries,
  });
  const edges: VisitSimilarityEdge[] = [];

  for (let sourceIndex = 0; sourceIndex < eligible.length; sourceIndex += 1) {
    const source = eligible[sourceIndex]!;
    const queryVector = queryVectors[sourceIndex];
    if (queryVector === undefined) continue;
    const candidateEntries = indexEntries.filter((entry) => entry.id !== source.visitKey);
    const ranked = [
      ...rankHybrid(
        source.corpus,
        queryVector,
        candidateEntries,
        new Date(source.lastSeenAt),
        {
          limit: topK,
          lexical: buildLexicalIndex(candidateEntries),
          vectorIndex,
          excludeIds: new Set<string>([source.visitKey]),
        },
      ),
    ].sort((left, right) => {
      if (right.similarity !== left.similarity) return right.similarity - left.similarity;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });

    for (const candidate of ranked) {
      if (candidate.id <= source.visitKey) continue;
      if (candidate.similarity < threshold) continue;
      edges.push({
        fromVisitKey: source.visitKey,
        toVisitKey: candidate.id,
        cosine: roundedCosine(candidate.similarity),
      });
    }
  }

  edges.sort((left, right) => {
    if (left.fromVisitKey !== right.fromVisitKey) {
      return left.fromVisitKey < right.fromVisitKey ? -1 : 1;
    }
    if (left.toVisitKey !== right.toVisitKey) {
      return left.toVisitKey < right.toVisitKey ? -1 : 1;
    }
    return left.cosine - right.cosine;
  });

  return { ...base, edges };
};

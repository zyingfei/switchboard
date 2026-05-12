import { createHash } from 'node:crypto';

import { buildAnnIndex } from '../recall/ann-index.js';
import { RECALL_MODEL } from '../recall/modelManifest.js';
import {
  buildLexicalIndex,
  rankHybrid,
  type IndexEntry,
} from '../recall/ranker.js';
import type { TimelineEntry } from '../timeline/projection.js';
import type {
  VisitSimilarityEdge,
  VisitSimilarityProducer,
  VisitSimilarityRevision,
} from './types.js';

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
  // Stage 5 / T2. When `lexicalThreshold` is omitted, the env var
  // VISIT_SIMILARITY_LEXICAL_THRESHOLD_ENV wins; otherwise
  // VISIT_SIMILARITY_DEFAULT_LEXICAL_THRESHOLD.
  readonly lexicalThreshold?: number;
  // Set to `false` to disable the metadata-Jaccard fallback in tests
  // that simulate "embedder is unavailable, no edges expected." Default
  // honors the env var (enabled unless explicitly disabled).
  readonly lexicalFallbackEnabled?: boolean;
}

export const VISIT_SIMILARITY_MODEL_ID = 'Xenova/multilingual-e5-small' as const;
export const VISIT_SIMILARITY_FEATURE_SCHEMA_VERSION = 1;
export const VISIT_SIMILARITY_DEFAULT_THRESHOLD = 0.85;
export const VISIT_SIMILARITY_DEFAULT_TOP_K = 50;
export const VISIT_SIMILARITY_DEFAULT_ENGAGEMENT_GATE_MS = 5_000;
// Stage 5 / T2 — lexical fallback. Token-set Jaccard over the same
// (title + host + path-tokens) corpus the embedding pipeline uses.
// Default threshold is intentionally generous: the fallback's purpose
// is to *light up downstream diagnostics* when the embedder is
// unavailable, not to ship high-confidence edges. Production runs are
// expected to be on the embedding path; lexical revisions are flagged
// with `producer: 'lexical'` so consumers can distinguish.
export const VISIT_SIMILARITY_DEFAULT_LEXICAL_THRESHOLD = 0.3;

export const VISIT_SIMILARITY_THRESHOLD_ENV = 'SIDETRACK_SIMILARITY_THRESHOLD';
export const VISIT_SIMILARITY_TOP_K_ENV = 'SIDETRACK_SIMILARITY_TOP_K';
export const VISIT_SIMILARITY_ENGAGEMENT_GATE_MS_ENV =
  'SIDETRACK_SIMILARITY_MIN_ENGAGEMENT_MS';
export const VISIT_SIMILARITY_LEXICAL_THRESHOLD_ENV =
  'SIDETRACK_SIMILARITY_LEXICAL_THRESHOLD';
export const VISIT_SIMILARITY_LEXICAL_FALLBACK_ENV =
  'SIDETRACK_SIMILARITY_LEXICAL_FALLBACK';

const readEnvNumber = (name: string): number | undefined => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
};

const lexicalFallbackEnabled = (): boolean => {
  const raw = process.env[VISIT_SIMILARITY_LEXICAL_FALLBACK_ENV];
  if (raw === undefined || raw === '') return true;
  return raw !== '0' && raw.toLowerCase() !== 'false';
};

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

const clampUnit = (value: number): number => Math.min(Math.max(value, 0), 1);

const clampThreshold = (threshold: number | undefined): number => {
  if (threshold !== undefined && Number.isFinite(threshold)) return clampUnit(threshold);
  const envValue = readEnvNumber(VISIT_SIMILARITY_THRESHOLD_ENV);
  if (envValue !== undefined) return clampUnit(envValue);
  return VISIT_SIMILARITY_DEFAULT_THRESHOLD;
};

const clampTopK = (topK: number | undefined): number => {
  if (topK !== undefined && Number.isFinite(topK)) return Math.max(1, Math.trunc(topK));
  const envValue = readEnvNumber(VISIT_SIMILARITY_TOP_K_ENV);
  if (envValue !== undefined) return Math.max(1, Math.trunc(envValue));
  return VISIT_SIMILARITY_DEFAULT_TOP_K;
};

const clampEngagementGate = (engagementGateMs: number | undefined): number => {
  if (engagementGateMs !== undefined && Number.isFinite(engagementGateMs)) {
    return Math.max(0, engagementGateMs);
  }
  const envValue = readEnvNumber(VISIT_SIMILARITY_ENGAGEMENT_GATE_MS_ENV);
  if (envValue !== undefined) return Math.max(0, envValue);
  return VISIT_SIMILARITY_DEFAULT_ENGAGEMENT_GATE_MS;
};

const clampLexicalThreshold = (lexicalThreshold: number | undefined): number => {
  if (lexicalThreshold !== undefined && Number.isFinite(lexicalThreshold)) {
    return clampUnit(lexicalThreshold);
  }
  const envValue = readEnvNumber(VISIT_SIMILARITY_LEXICAL_THRESHOLD_ENV);
  if (envValue !== undefined) return clampUnit(envValue);
  return VISIT_SIMILARITY_DEFAULT_LEXICAL_THRESHOLD;
};

// Stage 5.0 follow-up — single source of truth for the effective
// similarity config. The materializer calls this once and forwards
// the same struct to `buildVisitSimilarity` AND
// `collectMaterializerDiagnostics`, so the diagnostic artifact
// reports the values actually used (not the constant defaults).
//
// Explicit `options` fields trump env vars; env vars trump defaults.
export interface EffectiveVisitSimilarityConfig {
  readonly threshold: number;
  readonly topK: number;
  readonly engagementGateMs: number;
  readonly lexicalThreshold: number;
  readonly lexicalFallbackEnabled: boolean;
}

export const resolveVisitSimilarityConfig = (
  options: BuildVisitSimilarityOptions = {},
): EffectiveVisitSimilarityConfig => ({
  threshold: clampThreshold(options.threshold),
  topK: clampTopK(options.topK),
  engagementGateMs: clampEngagementGate(options.engagementGateMs),
  lexicalThreshold: clampLexicalThreshold(options.lexicalThreshold),
  lexicalFallbackEnabled: options.lexicalFallbackEnabled ?? lexicalFallbackEnabled(),
});

const roundedCosine = (value: number): number => Number(value.toFixed(6));

// Stage 5.0 follow-up — the revision-id hash now includes `producer`
// + the lexical config so two materially different revisions
// (embedding @ 0.85 vs lexical @ 0.30, same visits) get distinct ids,
// AND tuning `SIDETRACK_SIMILARITY_LEXICAL_THRESHOLD` produces a new
// revision id even when only the lexical path could fire. Older
// embedding-only revisions on disk are unaffected because their
// hashing was identical (producer === 'embedding', no lexical input);
// the included fields are additive and stable.
const revisionIdFor = (input: {
  readonly modelRevision: string;
  readonly producer: VisitSimilarityProducer;
  readonly threshold: number;
  readonly topK: number;
  readonly engagementGateMs: number;
  readonly lexicalThreshold: number;
  readonly lexicalFallbackEnabled: boolean;
  readonly visits: readonly NormalizedVisit[];
}): string => {
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify({
      modelId: VISIT_SIMILARITY_MODEL_ID,
      modelRevision: input.modelRevision,
      featureSchemaVersion: VISIT_SIMILARITY_FEATURE_SCHEMA_VERSION,
      producer: input.producer,
      threshold: input.threshold,
      topK: input.topK,
      engagementGateMs: input.engagementGateMs,
      lexicalThreshold: input.lexicalThreshold,
      lexicalFallbackEnabled: input.lexicalFallbackEnabled,
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
  readonly producer?: VisitSimilarityProducer;
}): VisitSimilarityRevision => ({
  revisionId: input.revisionId,
  modelId: VISIT_SIMILARITY_MODEL_ID,
  modelRevision: input.modelRevision,
  featureSchemaVersion: VISIT_SIMILARITY_FEATURE_SCHEMA_VERSION,
  threshold: input.threshold,
  edges: [],
  producedAt: Date.now(),
  ...(input.producer === undefined ? {} : { producer: input.producer }),
});

// Stage 5 / T2 — token-set Jaccard fallback. Produces the same edge
// shape as the embedding path so downstream reducers and the snapshot
// emitter handle both uniformly. The revision is tagged
// `producer: 'lexical'`; the cosine field re-uses the Jaccard score in
// [0, 1] so the snapshot's `cosine < threshold` filter remains
// honored.
const tokenize = (corpus: string): ReadonlySet<string> => {
  const tokens = new Set<string>();
  for (const raw of corpus.split(/\s+/u)) {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed.length === 0) continue;
    tokens.add(trimmed);
  }
  return tokens;
};

const jaccard = (left: ReadonlySet<string>, right: ReadonlySet<string>): number => {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  const smaller = left.size <= right.size ? left : right;
  const larger = smaller === left ? right : left;
  for (const token of smaller) {
    if (larger.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

const buildLexicalEdges = (
  visits: readonly NormalizedVisit[],
  threshold: number,
  topK: number,
): readonly VisitSimilarityEdge[] => {
  if (visits.length < 2) return [];
  const tokensByVisit = new Map<string, ReadonlySet<string>>();
  for (const visit of visits) {
    tokensByVisit.set(visit.visitKey, tokenize(visit.corpus));
  }
  const edges: VisitSimilarityEdge[] = [];
  for (const source of visits) {
    const sourceTokens = tokensByVisit.get(source.visitKey);
    if (sourceTokens === undefined || sourceTokens.size === 0) continue;
    const ranked: { readonly id: string; readonly similarity: number }[] = [];
    for (const candidate of visits) {
      if (candidate.visitKey === source.visitKey) continue;
      const candTokens = tokensByVisit.get(candidate.visitKey);
      if (candTokens === undefined || candTokens.size === 0) continue;
      const similarity = jaccard(sourceTokens, candTokens);
      if (similarity < threshold) continue;
      ranked.push({ id: candidate.visitKey, similarity });
    }
    ranked.sort((left, right) => {
      if (right.similarity !== left.similarity) return right.similarity - left.similarity;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
    for (const candidate of ranked.slice(0, topK)) {
      // Deduplicate the undirected edge by emitting only when source<candidate.
      if (candidate.id <= source.visitKey) continue;
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
  return edges;
};

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
  // Merged PR #141 + main: PR #141 added producer/lexicalThreshold/
  // lexicalFallbackEnabled to the revision-id hash so changes to the
  // fallback config invalidate cached revisions even when the
  // embedder succeeded. Mirror those here so the cache-probe revisionId
  // matches buildVisitSimilarity's embedding-path id.
  const config = resolveVisitSimilarityConfig(options);
  const modelRevision = RECALL_MODEL.revision;
  const visits = normalizeEntries(entries);
  return revisionIdFor({
    modelRevision,
    producer: 'embedding',
    threshold: config.threshold,
    topK: config.topK,
    engagementGateMs: config.engagementGateMs,
    lexicalThreshold: config.lexicalThreshold,
    lexicalFallbackEnabled: config.lexicalFallbackEnabled,
    visits,
  });
};

export const buildVisitSimilarity = async (
  entries: readonly VisitSimilarityEntry[],
  embed: VisitSimilarityEmbedder,
  options: BuildVisitSimilarityOptions = {},
): Promise<VisitSimilarityRevision> => {
  const config = resolveVisitSimilarityConfig(options);
  const { threshold, topK, engagementGateMs, lexicalThreshold } = config;
  const fallbackAllowed = config.lexicalFallbackEnabled;
  const modelRevision = RECALL_MODEL.revision;
  const visits = normalizeEntries(entries);
  // Stage 5.0 follow-up — embedding-path id is computed up front and
  // ALSO includes lexicalThreshold/lexicalFallbackEnabled in its
  // hash. That keeps it sensitive to changes the operator made to the
  // fallback config even when the embedder succeeded, so a future
  // re-run that lost the embedder produces a distinct id.
  const embeddingRevisionId = revisionIdFor({
    modelRevision,
    producer: 'embedding',
    threshold,
    topK,
    engagementGateMs,
    lexicalThreshold,
    lexicalFallbackEnabled: fallbackAllowed,
    visits,
  });
  const embeddingBase = {
    revisionId: embeddingRevisionId,
    modelId: VISIT_SIMILARITY_MODEL_ID,
    modelRevision,
    featureSchemaVersion: VISIT_SIMILARITY_FEATURE_SCHEMA_VERSION,
    threshold,
    producedAt: Date.now(),
    producer: 'embedding' as VisitSimilarityProducer,
  } satisfies Omit<VisitSimilarityRevision, 'edges'>;

  // Lexical fallback path: produces edges whose `cosine` field is a
  // Jaccard score in [0, 1]. The revision's `threshold` matches the
  // lexical threshold so the snapshot's `cosine < threshold` filter
  // gates correctly without changing the reducer. The revision id is
  // computed with `producer: 'lexical'` and the lexical threshold in
  // the hash, so embedding and lexical revisions over the same visits
  // are always distinct.
  const lexicalRevision = (): VisitSimilarityRevision => {
    const eligibleForLexical = visits.filter((visit) => visit.focusedWindowMs >= engagementGateMs);
    const lexicalRevisionId = revisionIdFor({
      modelRevision,
      producer: 'lexical',
      threshold: lexicalThreshold,
      topK,
      engagementGateMs,
      lexicalThreshold,
      lexicalFallbackEnabled: fallbackAllowed,
      visits,
    });
    return {
      revisionId: lexicalRevisionId,
      modelId: VISIT_SIMILARITY_MODEL_ID,
      modelRevision,
      featureSchemaVersion: VISIT_SIMILARITY_FEATURE_SCHEMA_VERSION,
      threshold: lexicalThreshold,
      producedAt: Date.now(),
      producer: 'lexical',
      edges: fallbackAllowed
        ? buildLexicalEdges(eligibleForLexical, lexicalThreshold, topK)
        : [],
    };
  };

  const eligible = visits.filter((visit) => visit.focusedWindowMs >= engagementGateMs);
  if (eligible.length < 2) {
    return { ...embeddingBase, edges: [] };
  }

  const passageTexts = eligible.map((visit) => `${PASSAGE_PREFIX}${visit.corpus}`);
  const queryTexts = eligible.map((visit) => `${QUERY_PREFIX}${visit.corpus}`);
  let embedded: readonly Float32Array[];
  try {
    embedded = await embed([...passageTexts, ...queryTexts]);
  } catch (error) {
    logMaterializerError(error);
    if (fallbackAllowed) return lexicalRevision();
    return emptyRevision({
      revisionId: embeddingRevisionId,
      modelRevision,
      threshold,
      producer: 'embedding',
    });
  }
  if (embedded.length !== passageTexts.length + queryTexts.length) {
    logMaterializerError(
      new Error(
        `expected ${String(passageTexts.length + queryTexts.length)} embeddings, received ${String(embedded.length)}`,
      ),
    );
    if (fallbackAllowed) return lexicalRevision();
    return emptyRevision({
      revisionId: embeddingRevisionId,
      modelRevision,
      threshold,
      producer: 'embedding',
    });
  }

  const passageVectors = embedded.slice(0, passageTexts.length);
  const queryVectors = embedded.slice(passageTexts.length);
  const indexEntries = indexEntriesForVisits(eligible, passageVectors);
  const vectorIndex = await buildAnnIndex({
    revisionId: embeddingRevisionId,
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

  return { ...embeddingBase, edges };
};

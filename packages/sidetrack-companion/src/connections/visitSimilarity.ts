import { createHash } from 'node:crypto';

import { buildAnnIndex } from '../recall/ann-index.js';
import { evidenceCorpusForRecord } from '../page-evidence/extract.js';
import {
  DEFAULT_UNKNOWN_IDF,
  userIdf,
  weightedContainment,
  weightedJaccard,
} from '../page-evidence/idf.js';
import {
  PAGE_EVIDENCE_COLD_START_SCORING_POLICY,
  confidenceForPageEvidencePair,
  extractionReliabilityForQuality,
  fusePageEvidenceChannelScores,
} from '../page-evidence/scoringPolicy.js';
import { compatibleVectorRefs } from '../page-evidence/vectorRef.js';
import type {
  PageEvidenceRecord,
  PageEvidenceSimilarityMetadata,
  WeightedEntity,
  WeightedTerm,
} from '../page-evidence/types.js';
import { stripSiteTitleSuffix } from '../ranker/aggregatorProfiles.js';
import { RECALL_MODEL } from '../recall/modelManifest.js';
import { buildLexicalIndex, rankHybrid, type IndexEntry } from '../recall/ranker.js';
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
  readonly evidenceByCanonicalUrl?: ReadonlyMap<string, PageEvidenceRecord>;
  readonly evidenceVectorsByVectorId?: ReadonlyMap<string, Float32Array>;
  readonly pageContentChunksByCanonicalUrl?: ReadonlyMap<
    string,
    readonly VisitSimilarityChunkEvidence[]
  >;
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
export const VISIT_SIMILARITY_ENGAGEMENT_GATE_MS_ENV = 'SIDETRACK_SIMILARITY_MIN_ENGAGEMENT_MS';
export const VISIT_SIMILARITY_LEXICAL_THRESHOLD_ENV = 'SIDETRACK_SIMILARITY_LEXICAL_THRESHOLD';
export const VISIT_SIMILARITY_LEXICAL_FALLBACK_ENV = 'SIDETRACK_SIMILARITY_LEXICAL_FALLBACK';

// -- Anisotropy baseline for the recall encoder (Xenova/multilingual-
// e5-small) -----------------------------------------------------------
//
// Embedding cosine is NOT centered at 0 for this encoder: the vector
// space is anisotropic, so even random UNRELATED page pairs sit at a
// high mean cosine with a narrow spread. Measured over the live test
// vault on 2026-07-14 ("anisotropy study"), random unrelated pairs had
//   mean 0.825, sd 0.029  (p90 0.860, p99 0.901).
// The historical raw gate VISIT_SIMILARITY_DEFAULT_THRESHOLD=0.85 is
// therefore ≈ (0.85 − 0.825) / 0.029 ≈ z 0.86 ≈ the p80 of NOISE — it
// admits a large fraction of unrelated pairs. A z-score re-centers the
// cosine against this baseline so edge quality is measurable and the
// gate can be recalibrated on evidence rather than on the raw scale.
//
// These are documented constants with env overrides; the sd/mean are a
// property of the encoder + corpus, not of a single drain.
// TODO(eval-spine): replace this frozen 2026-07-14 vault baseline with a
// drain-time empirical estimate (sample random unrelated pairs per
// drain, EWMA the mean/sd) once the connections-precision spine can
// score the shift. Until then the study constants are the source of
// truth and the z-gate below stays default-OFF.
export const SIMILARITY_ANISOTROPY_MEAN = 0.825;
export const SIMILARITY_ANISOTROPY_SD = 0.029;

export const SIMILARITY_ANISOTROPY_MEAN_ENV = 'SIDETRACK_SIMILARITY_ANISOTROPY_MEAN';
export const SIMILARITY_ANISOTROPY_SD_ENV = 'SIDETRACK_SIMILARITY_ANISOTROPY_SD';
// Optional serving gate (default ABSENT = OFF): when set to a finite
// number the visit-similarity producer gates on z >= value INSTEAD of
// the raw cosine >= threshold. Flipping it is a SERVING change awaiting
// the eval spine — leave unset to preserve byte-identical default edges.
export const SIMILARITY_Z_MIN_ENV = 'SIDETRACK_SIMILARITY_Z_MIN';

const readEnvNumber = (name: string): number | undefined => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
};

// Resolve the anisotropy baseline (env override wins, else the study
// constant). SD is floored away from 0 so z is always finite.
export const resolveAnisotropyBaseline = (): { readonly mean: number; readonly sd: number } => {
  const mean = readEnvNumber(SIMILARITY_ANISOTROPY_MEAN_ENV) ?? SIMILARITY_ANISOTROPY_MEAN;
  const sdRaw = readEnvNumber(SIMILARITY_ANISOTROPY_SD_ENV) ?? SIMILARITY_ANISOTROPY_SD;
  const sd = Number.isFinite(sdRaw) && sdRaw > 0 ? sdRaw : SIMILARITY_ANISOTROPY_SD;
  return { mean, sd };
};

// Standardize a raw cosine against the anisotropy baseline: how many
// standard deviations above (or below) the noise floor this pair sits.
// Rounded to 2dp — the stamped metadata is a diagnostic, not a key.
export const anisotropyZScore = (
  cosine: number,
  baseline: { readonly mean: number; readonly sd: number } = resolveAnisotropyBaseline(),
): number => {
  if (!Number.isFinite(cosine)) return 0;
  const z = (cosine - baseline.mean) / baseline.sd;
  return Number.isFinite(z) ? Number(z.toFixed(2)) : 0;
};

// Optional z-gate minimum (default undefined = OFF). See SIMILARITY_Z_MIN_ENV.
export const resolveSimilarityZMin = (): number | undefined =>
  readEnvNumber(SIMILARITY_Z_MIN_ENV);

const lexicalFallbackEnabled = (): boolean => {
  const raw = process.env[VISIT_SIMILARITY_LEXICAL_FALLBACK_ENV];
  if (raw === undefined || raw === '') return true;
  return raw !== '0' && raw.toLowerCase() !== 'false';
};

const PASSAGE_PREFIX = 'passage: ';
const QUERY_PREFIX = 'query: ';
const CHUNK_SUPPORT_THRESHOLD = 0.2;
const CHUNK_VECTOR_SUPPORT_THRESHOLD = 0.75;

interface NormalizedVisit {
  readonly visitKey: string;
  readonly lastSeenAt: string;
  readonly corpus: string;
  readonly focusedWindowMs: number;
  readonly evidence?: PageEvidenceRecord;
}

export interface VisitSimilarityChunkEvidence {
  readonly terms?: readonly WeightedTerm[];
  readonly qualityWeight?: number;
  readonly embeddingVector?: Float32Array;
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

// Content-corpus serving gate. Whether visit-similarity may draw the
// similarity corpus (and, downstream, the content-enriched pair scoring)
// from loaded page-evidence CONTENT rather than the title/host/path
// skeleton. Default OFF: this is the evidence-gated connect of a built-
// but-unserved path (the corpus code has ALWAYS preferred content when a
// content-backed record was loaded — it simply never was, because doc
// embeddings sat at ~13.6% coverage; the background-embedding lane now
// fills them). Under the OWNER DIRECTIVE / ADR-0011, the serving flip
// ships behind a flag whose default is set by the eval-spine verdict
// (connections-precision over the 70 confirmed pairs), NOT by optimism.
// While OFF, corpusForVisitEntry returns the frozen title-only skeleton,
// so a partially-embedded backlog cannot silently shift served edges
// before the eval spine can score the change. Flip with
// SIDETRACK_SIMILARITY_CONTENT_CORPUS=1 (+ restart) once the verdict
// clears it. See ADR-0011 amendment 2026-07-12b.
//
// RECORDED VERDICT (ADR-0011 amendment 2026-07-13b): stays OFF. The
// connections-precision spine, run offline against a read-only snapshot
// of the live test vault, reported servedSimilarityEdges=0 — the
// similarity lane serves ZERO edges on this vault (the July regression;
// page-access-off → the engagement gate never trips), so precision by
// evidence tier is UNDEFINED (n/a), not low. There is nothing for the
// content tier to out-precise yet. Re-score once the requalify lanes
// restore served edges (June baseline ~30k), then flip on the recorded
// number.
export const similarityContentCorpusEnabled = (): boolean =>
  process.env['SIDETRACK_SIMILARITY_CONTENT_CORPUS'] === '1';

// Corpus-cleaning gate (default OFF). See corpusForVisitEntry below for the
// measured root-cause. When ON, the embedded title-only corpus drops the
// hostname + path-token skeleton and strips known site-title suffixes, so the
// shared URL skeleton stops inflating same-site cosine. This is a SERVING-edge
// change: every visit's corpus TEXT changes, so every visit must be re-embedded
// and the served edges recomputed. Per the repo's serving-flip discipline
// (ADR-0011 / DEBUGGING_DOCTRINE) it ships DEFAULT-OFF: served edges stay
// byte-identical until the connections-precision eval spine clears the flip.
// Enable with SIDETRACK_SIMILARITY_CLEAN_CORPUS=1 (+ restart).
//
// PROPAGATION (do not repeat the earlier design error): flipping this flag does
// NOT by itself re-embed the ~3k already-persisted visits. The FEATURE_SCHEMA_
// VERSION is a fixed constant (it is not bumped by the flag), the HNSW store is
// keyed by embedding DIMENSION (unchanged by a corpus flip), and the warm /
// incremental paths are append-only + idempotent on existing visitKeys — so the
// persisted store keeps the OLD dirty vectors and only NEW visitKeys would get
// the clean corpus. The flip is made to actually take effect by
// `similarityCorpusConfigSignature()` below: the materializer records the served
// signature in durable floor state and, when it differs from the live one,
// (a) pushes a `corpus-config-change` reset reason so the floor guard PUBLISHES
// the recompute instead of carrying the dirty revision forward, (b) forces a
// full HNSW rebuild so every visit re-embeds under the clean corpus, and
// (c) rejects reusing a persisted revision built under the other corpus config.
export const SIMILARITY_CLEAN_CORPUS_ENV = 'SIDETRACK_SIMILARITY_CLEAN_CORPUS';
export const similarityCleanCorpusEnabled = (): boolean =>
  process.env[SIMILARITY_CLEAN_CORPUS_ENV] === '1';

// A stable signature of the CORPUS-shaping config — the set of flags that change
// the embedded corpus TEXT for existing visits (and therefore every served
// same-site cosine). Recorded in durable floor state so the materializer can
// detect a config flip across restarts and drive a recorded reset (see the
// PROPAGATION note above). Default config yields the frozen `legacy-skeleton`
// signature so a default-OFF process is byte-identical (no reset ever fires).
export const similarityCorpusConfigSignature = (): string => {
  const parts: string[] = [];
  parts.push(similarityCleanCorpusEnabled() ? 'clean-title-only' : 'legacy-skeleton');
  parts.push(similarityContentCorpusEnabled() ? 'content-corpus' : 'title-corpus');
  return parts.join('|');
};

// Stage 5.2 W3 fast-path needs both helpers to embed + key new entries
// from outside this module. They're stateless + cheap; expose as named
// exports so the materializer can compute pre-embedding inputs.
//
// The content-corpus gate lives HERE so a single check governs BOTH
// consumers of a visit's evidence: the similarity corpus
// (corpusForVisitEntry) AND the content-enriched pair scoring (which
// reads NormalizedVisit.evidence). While the flag is OFF, evidence is
// invisible to the similarity path end-to-end — the served edges are the
// frozen title-only baseline, so a partially-embedded backlog cannot
// shift them before the eval spine scores the flip.
const evidenceForEntry = (
  entry: VisitSimilarityEntry,
  evidenceByCanonicalUrl: ReadonlyMap<string, PageEvidenceRecord> | undefined,
): PageEvidenceRecord | undefined => {
  if (evidenceByCanonicalUrl === undefined) return undefined;
  if (!similarityContentCorpusEnabled()) return undefined;
  const visitKey = visitKeyForVisitEntry(entry);
  return evidenceByCanonicalUrl.get(visitKey);
};

// The embedded corpus for a visit when no content evidence is available
// (the title-only skeleton path).
//
// ROOT-CAUSE (measured, 2026-07-24 with the real multilingual-e5-small
// encoder over real HN item titles): appending `hostname + pathTokens`
// (`news.ycombinator.com item`) to the title inflates same-site cosine by
// ≈ +0.03 — enough to push unrelated HN item pairs from 0/45 above the 0.85
// gate to ~7/45. Stripping the shared `| Hacker News` title suffix helps a
// little more (≈ +0.02). This host/path skeleton — NOT the title suffix — is the
// primary false-friend engine the B1–B4 aggregator guards were compensating
// for downstream. Baking host/path into the embedding ALSO double-counts them:
// they already flow as separate structured candidate sources
// (same_repo_or_domain, same_title_path_tokens) with their own weights.
//
// The clean path therefore embeds the title ONLY, with a known site-title
// suffix stripped. Guarded behind SIDETRACK_SIMILARITY_CLEAN_CORPUS so the flip
// is byte-identical until the eval spine scores it (see the flag above).
export const cleanCorpusText = (title: string, url: string): string => {
  if (similarityCleanCorpusEnabled()) {
    return normalizeSpaces(stripSiteTitleSuffix(title, hostnameForUrl(url)));
  }
  // Frozen legacy skeleton (default): title + host + path tokens.
  return normalizeSpaces([title, hostnameForUrl(url), ...pathTokensForUrl(url)].join(' '));
};

export const corpusForVisitEntry = (
  entry: VisitSimilarityEntry,
  evidenceByCanonicalUrl?: ReadonlyMap<string, PageEvidenceRecord>,
): string => {
  const evidence = evidenceForEntry(entry, evidenceByCanonicalUrl);
  if (evidence !== undefined) return evidenceCorpusForRecord(evidence);
  const url = entry.canonicalUrl ?? entry.url;
  return cleanCorpusText(entry.title ?? '', url);
};

export const visitKeyForVisitEntry = (entry: VisitSimilarityEntry): string =>
  stripFragmentAndTrailingSlash(entry.canonicalUrl ?? entry.url);

// Internal aliases for in-module call sites (preserve existing
// names below).
const corpusForEntry = corpusForVisitEntry;
const visitKeyForEntry = visitKeyForVisitEntry;

const preferNewEntry = (existing: NormalizedVisit, candidate: NormalizedVisit): NormalizedVisit => {
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

const roundWeight = (value: number): number => Number(value.toFixed(6));

const corpusAdjustedTerms = (
  terms: readonly WeightedTerm[],
  dfByTerm: ReadonlyMap<string, number>,
  documentCount: number,
): readonly WeightedTerm[] =>
  terms.map((term) => {
    const df = dfByTerm.get(term.normalized) ?? 0;
    const idf = userIdf({ documentCount, documentFrequency: df });
    const previousIdf =
      typeof term.idf === 'number' && Number.isFinite(term.idf) && term.idf > 0
        ? term.idf
        : DEFAULT_UNKNOWN_IDF;
    return {
      ...term,
      df,
      idf: roundWeight(idf),
      weight: roundWeight(term.weight * (idf / Math.max(previousIdf, 0.000001))),
    };
  });

const applyCorpusIdfToVisits = (visits: readonly NormalizedVisit[]): readonly NormalizedVisit[] => {
  const contentVisits = visits.filter((visit) => visit.evidence?.content !== undefined);
  if (contentVisits.length === 0) return visits;
  const dfByTerm = new Map<string, number>();
  for (const visit of contentVisits) {
    const terms = new Set<string>();
    for (const term of visit.evidence?.content?.terms ?? []) terms.add(term.normalized);
    for (const term of visit.evidence?.content?.keyphrases ?? []) terms.add(term.normalized);
    for (const term of terms) dfByTerm.set(term, (dfByTerm.get(term) ?? 0) + 1);
  }
  const documentCount = contentVisits.length;
  return visits.map((visit) => {
    const evidence = visit.evidence;
    if (evidence?.content === undefined) return visit;
    return {
      ...visit,
      evidence: {
        ...evidence,
        content: {
          ...evidence.content,
          terms: corpusAdjustedTerms(evidence.content.terms, dfByTerm, documentCount),
          keyphrases: corpusAdjustedTerms(evidence.content.keyphrases, dfByTerm, documentCount),
        },
      },
    };
  });
};

const normalizeEntries = (
  entries: readonly VisitSimilarityEntry[],
  evidenceByCanonicalUrl?: ReadonlyMap<string, PageEvidenceRecord>,
): readonly NormalizedVisit[] => {
  const byKey = new Map<string, NormalizedVisit>();
  for (const entry of entries) {
    const visitKey = visitKeyForEntry(entry);
    if (visitKey.length === 0) continue;
    const evidence = evidenceForEntry(entry, evidenceByCanonicalUrl);
    const candidate: NormalizedVisit = {
      visitKey,
      lastSeenAt: entry.lastSeenAt,
      corpus: corpusForEntry(entry, evidenceByCanonicalUrl),
      focusedWindowMs: readFocusedWindowMs(entry),
      ...(evidence === undefined ? {} : { evidence }),
    };
    const existing = byKey.get(visitKey);
    byKey.set(visitKey, existing === undefined ? candidate : preferNewEntry(existing, candidate));
  }
  const visits = [...byKey.values()].sort((left, right) =>
    left.visitKey < right.visitKey ? -1 : left.visitKey > right.visitKey ? 1 : 0,
  );
  return applyCorpusIdfToVisits(visits);
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
  readonly pageContentChunksByCanonicalUrl?:
    | ReadonlyMap<string, readonly VisitSimilarityChunkEvidence[]>
    | undefined;
}): string => {
  const chunkSignatureFor = (visitKey: string): string | undefined => {
    const chunks = input.pageContentChunksByCanonicalUrl?.get(visitKey);
    if (chunks === undefined || chunks.length === 0) return undefined;
    return chunks
      .map((chunk) =>
        (chunk.terms ?? [])
          .slice(0, 12)
          .map((term) => `${term.normalized}:${term.weight.toFixed(4)}`)
          .join(','),
      )
      .join('|');
  };
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
        evidenceRevision:
          visit.evidence?.semanticFeatureRevision ?? visit.evidence?.evidenceRevision,
        indexedChunkSignature: chunkSignatureFor(visit.visitKey),
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

const cosine = (
  left: Float32Array | undefined,
  right: Float32Array | undefined,
): number | undefined => {
  if (
    left === undefined ||
    right === undefined ||
    left.length !== right.length ||
    left.length === 0
  ) {
    return undefined;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  if (leftNorm <= 0 || rightNorm <= 0) return undefined;
  return dot / Math.sqrt(leftNorm * rightNorm);
};

const sortedOverlap = (
  left: readonly { readonly normalized: string; readonly weight: number; readonly term?: string }[],
  right: readonly {
    readonly normalized: string;
    readonly weight: number;
    readonly term?: string;
  }[],
): readonly string[] => {
  const rightByTerm = new Map(right.map((item) => [item.normalized, item] as const));
  return left
    .flatMap((item): readonly { readonly label: string; readonly weight: number }[] => {
      const match = rightByTerm.get(item.normalized);
      if (match === undefined) return [];
      return [{ label: item.term ?? item.normalized, weight: Math.min(item.weight, match.weight) }];
    })
    .sort((a, b) => b.weight - a.weight || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    .map((item) => item.label)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 8);
};

const entityOverlap = (
  left: readonly WeightedEntity[],
  right: readonly WeightedEntity[],
): number => {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right.map((entity) => entity.normalized));
  const overlap = left.filter((entity) => rightSet.has(entity.normalized)).length;
  return overlap / Math.min(left.length, right.length);
};

export const chunkSupportFor = (
  leftChunks: readonly VisitSimilarityChunkEvidence[] | undefined,
  rightChunks: readonly VisitSimilarityChunkEvidence[] | undefined,
):
  | {
      readonly score: number;
      readonly supportCount: number;
      readonly maxPairScore: number;
      readonly meanTop3Score: number;
      readonly maxVectorCosine: number;
      readonly top3MeanVectorCosine: number;
      readonly vectorSupportCount: number;
    }
  | undefined => {
  if (leftChunks === undefined || rightChunks === undefined) return undefined;
  if (leftChunks.length === 0 || rightChunks.length === 0) return undefined;
  const scores: number[] = [];
  const vectorScores: number[] = [];
  for (const left of leftChunks) {
    const leftTerms = left.terms ?? [];
    for (const right of rightChunks) {
      const vectorScore = cosine(left.embeddingVector, right.embeddingVector);
      if (vectorScore !== undefined) vectorScores.push(vectorScore);

      if (leftTerms.length === 0) continue;
      const rightTerms = right.terms ?? [];
      if (rightTerms.length === 0) continue;
      const lexical = Math.max(
        weightedJaccard(leftTerms, rightTerms),
        weightedContainment(leftTerms, rightTerms),
      );
      if (lexical <= 0) continue;
      scores.push(lexical);
    }
  }
  if (scores.length === 0 && vectorScores.length === 0) return undefined;
  scores.sort((left, right) => right - left);
  vectorScores.sort((left, right) => right - left);
  const top3 = scores.slice(0, 3);
  const top3Vector = vectorScores.slice(0, 3);
  const meanTop3Score =
    top3.length === 0 ? 0 : top3.reduce((sum, value) => sum + value, 0) / top3.length;
  const top3MeanVectorCosine =
    top3Vector.length === 0
      ? 0
      : top3Vector.reduce((sum, value) => sum + value, 0) / top3Vector.length;
  const maxPairScore = scores[0] ?? 0;
  const maxVectorCosine = vectorScores[0] ?? 0;
  const supportCount = scores.filter((score) => score >= CHUNK_SUPPORT_THRESHOLD).length;
  const vectorSupportCount = vectorScores.filter(
    (score) => score >= CHUNK_VECTOR_SUPPORT_THRESHOLD,
  ).length;
  return {
    score: Math.min(1, meanTop3Score),
    supportCount,
    maxPairScore,
    meanTop3Score,
    maxVectorCosine,
    top3MeanVectorCosine,
    vectorSupportCount,
  };
};

const metadataTermsForEvidence = (evidence: PageEvidenceRecord): readonly WeightedTerm[] => [
  ...evidence.metadata.titleTokens.map((term) => ({
    term,
    normalized: term,
    weight: 1,
    source: 'title' as const,
  })),
  ...evidence.metadata.pathTokens.map((term) => ({
    term,
    normalized: term,
    weight: 1,
    source: 'url_path' as const,
  })),
  ...(evidence.metadata.host.length === 0
    ? []
    : evidence.metadata.host.split('.').map((term) => ({
        term,
        normalized: term,
        weight: 1,
        source: 'host' as const,
      }))),
];

const evidenceMetadataForPair = (
  left: NormalizedVisit,
  right: NormalizedVisit,
  vectorSimilarity: number | undefined,
  evidenceVectorsByVectorId?: ReadonlyMap<string, Float32Array>,
  pageContentChunksByCanonicalUrl?: ReadonlyMap<string, readonly VisitSimilarityChunkEvidence[]>,
): { readonly score: number; readonly metadata: PageEvidenceSimilarityMetadata } => {
  const leftEvidence = left.evidence;
  const rightEvidence = right.evidence;
  if (leftEvidence === undefined || rightEvidence === undefined) {
    const metadataScore = jaccard(tokenize(left.corpus), tokenize(right.corpus));
    const channels = {
      ...(vectorSimilarity === undefined ? {} : { behavior: roundedCosine(vectorSimilarity) }),
      metadata: roundedCosine(metadataScore),
    };
    const score = fusePageEvidenceChannelScores(channels);
    const confidenceSignals = confidenceForPageEvidencePair({
      channels,
      extractionReliability: 1,
    });
    return {
      score,
      metadata: {
        producer: 'metadata-only',
        policyId: PAGE_EVIDENCE_COLD_START_SCORING_POLICY.policyId,
        policyMode: PAGE_EVIDENCE_COLD_START_SCORING_POLICY.policyMode,
        defaultEligible: PAGE_EVIDENCE_COLD_START_SCORING_POLICY.defaultEligible,
        score: roundedCosine(score),
        semanticScore: roundedCosine(score),
        confidence: roundedCosine(confidenceSignals.confidence),
        confidenceSignals: {
          evidenceCoverage: roundedCosine(confidenceSignals.evidenceCoverage),
          extractionReliability: roundedCosine(confidenceSignals.extractionReliability),
          vectorCompatible: false,
        },
        evidenceTierFrom: 'metadata_only',
        evidenceTierTo: 'metadata_only',
        channels,
        featureSchemaVersion: 2,
      },
    };
  }

  const leftContentTerms = leftEvidence.content?.terms ?? [];
  const rightContentTerms = rightEvidence.content?.terms ?? [];
  if (leftEvidence.content === undefined && rightEvidence.content === undefined) {
    const metadataScore = weightedJaccard(
      metadataTermsForEvidence(leftEvidence),
      metadataTermsForEvidence(rightEvidence),
    );
    const channels = {
      ...(vectorSimilarity === undefined ? {} : { behavior: roundedCosine(vectorSimilarity) }),
      metadata: roundedCosine(metadataScore),
    };
    const score = fusePageEvidenceChannelScores(channels);
    const confidenceSignals = confidenceForPageEvidencePair({
      channels,
      extractionReliability: 1,
    });
    return {
      score,
      metadata: {
        producer: 'metadata-only',
        policyId: PAGE_EVIDENCE_COLD_START_SCORING_POLICY.policyId,
        policyMode: PAGE_EVIDENCE_COLD_START_SCORING_POLICY.policyMode,
        defaultEligible: PAGE_EVIDENCE_COLD_START_SCORING_POLICY.defaultEligible,
        score: roundedCosine(score),
        semanticScore: roundedCosine(score),
        confidence: roundedCosine(confidenceSignals.confidence),
        confidenceSignals: {
          evidenceCoverage: roundedCosine(confidenceSignals.evidenceCoverage),
          extractionReliability: roundedCosine(confidenceSignals.extractionReliability),
          vectorCompatible: false,
        },
        evidenceTierFrom: leftEvidence.evidenceTier,
        evidenceTierTo: rightEvidence.evidenceTier,
        channels,
        featureSchemaVersion: 2,
      },
    };
  }
  const leftKeyphrases = leftEvidence.content?.keyphrases ?? [];
  const rightKeyphrases = rightEvidence.content?.keyphrases ?? [];
  const leftEntities = leftEvidence.content?.entities ?? [];
  const rightEntities = rightEvidence.content?.entities ?? [];
  const metadataScore = weightedJaccard(
    metadataTermsForEvidence(leftEvidence),
    metadataTermsForEvidence(rightEvidence),
  );
  const pairExtractionReliability = Math.min(
    extractionReliabilityForQuality(leftEvidence.content?.quality),
    extractionReliabilityForQuality(rightEvidence.content?.quality),
  );
  const contentTermsRaw = Math.max(
    weightedJaccard(leftContentTerms, rightContentTerms),
    weightedContainment(leftContentTerms, rightContentTerms),
  );
  const keyphraseRaw = Math.max(
    weightedJaccard(leftKeyphrases, rightKeyphrases),
    weightedContainment(leftKeyphrases, rightKeyphrases),
  );
  const contentTerms = contentTermsRaw;
  const keyphrases = keyphraseRaw;
  const entities = entityOverlap(leftEntities, rightEntities);
  const leftVectorRef = leftEvidence.content?.docEmbeddingRef;
  const rightVectorRef = rightEvidence.content?.docEmbeddingRef;
  const contentVector =
    leftVectorRef !== undefined &&
    rightVectorRef !== undefined &&
    compatibleVectorRefs(leftVectorRef, rightVectorRef)
      ? cosine(
          evidenceVectorsByVectorId?.get(leftVectorRef.vectorId),
          evidenceVectorsByVectorId?.get(rightVectorRef.vectorId),
        )
      : undefined;
  const chunkSupport =
    leftEvidence.evidenceTier === 'indexed_chunks' &&
    rightEvidence.evidenceTier === 'indexed_chunks'
      ? chunkSupportFor(
          pageContentChunksByCanonicalUrl?.get(leftEvidence.canonicalUrl),
          pageContentChunksByCanonicalUrl?.get(rightEvidence.canonicalUrl),
        )
      : undefined;
  const channels = {
    ...(contentVector === undefined ? {} : { contentVector: roundedCosine(contentVector) }),
    ...(leftContentTerms.length === 0 || rightContentTerms.length === 0
      ? {}
      : { contentTerms: roundedCosine(contentTerms) }),
    ...(leftKeyphrases.length === 0 || rightKeyphrases.length === 0
      ? {}
      : { keyphrases: roundedCosine(keyphrases) }),
    ...(leftEntities.length === 0 || rightEntities.length === 0
      ? {}
      : { entities: roundedCosine(entities) }),
    ...(chunkSupport === undefined ? {} : { chunkSupport: roundedCosine(chunkSupport.score) }),
    metadata: roundedCosine(metadataScore),
  };
  const score = fusePageEvidenceChannelScores(channels);
  const confidenceSignals = confidenceForPageEvidencePair({
    channels,
    extractionReliability: pairExtractionReliability,
  });
  const matchedTerms = sortedOverlap(leftContentTerms, rightContentTerms);
  const matchedKeyphrases = sortedOverlap(leftKeyphrases, rightKeyphrases);
  const matchedEntities = sortedOverlap(
    leftEntities.map((entity) => ({
      normalized: entity.normalized,
      weight: entity.weight,
      term: entity.text,
    })),
    rightEntities.map((entity) => ({
      normalized: entity.normalized,
      weight: entity.weight,
      term: entity.text,
    })),
  );
  return {
    score,
    metadata: {
      producer: 'content-enriched',
      policyId: PAGE_EVIDENCE_COLD_START_SCORING_POLICY.policyId,
      policyMode: PAGE_EVIDENCE_COLD_START_SCORING_POLICY.policyMode,
      defaultEligible: PAGE_EVIDENCE_COLD_START_SCORING_POLICY.defaultEligible,
      score: roundedCosine(score),
      semanticScore: roundedCosine(score),
      confidence: roundedCosine(confidenceSignals.confidence),
      confidenceSignals: {
        evidenceCoverage: roundedCosine(confidenceSignals.evidenceCoverage),
        extractionReliability: roundedCosine(confidenceSignals.extractionReliability),
        vectorCompatible:
          leftVectorRef !== undefined &&
          rightVectorRef !== undefined &&
          compatibleVectorRefs(leftVectorRef, rightVectorRef),
      },
      evidenceTierFrom: leftEvidence.evidenceTier,
      evidenceTierTo: rightEvidence.evidenceTier,
      channels,
      ...(matchedTerms.length === 0 ? {} : { matchedTerms }),
      ...(matchedKeyphrases.length === 0 ? {} : { matchedKeyphrases }),
      ...(matchedEntities.length === 0 ? {} : { matchedEntities }),
      ...(chunkSupport === undefined
        ? {}
        : {
            chunkSupportCount: chunkSupport.supportCount,
            maxChunkPairScore: roundedCosine(chunkSupport.maxPairScore),
            maxChunkPairVectorCosine: roundedCosine(chunkSupport.maxVectorCosine),
            top3MeanChunkPairVectorCosine: roundedCosine(chunkSupport.top3MeanVectorCosine),
            chunkPairVectorSupportCount: chunkSupport.vectorSupportCount,
          }),
      featureSchemaVersion: 2,
    },
  };
};

const buildLexicalEdges = (
  visits: readonly NormalizedVisit[],
  threshold: number,
  topK: number,
  evidenceVectorsByVectorId?: ReadonlyMap<string, Float32Array>,
  pageContentChunksByCanonicalUrl?: ReadonlyMap<string, readonly VisitSimilarityChunkEvidence[]>,
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
      const baseSimilarity = jaccard(sourceTokens, candTokens);
      const hasEvidence = source.evidence !== undefined || candidate.evidence !== undefined;
      const evidenceScore = hasEvidence
        ? evidenceMetadataForPair(
            source,
            candidate,
            undefined,
            evidenceVectorsByVectorId,
            pageContentChunksByCanonicalUrl,
          )
        : undefined;
      const similarity = evidenceScore?.score ?? baseSimilarity;
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
      const target = visits.find((visit) => visit.visitKey === candidate.id) ?? source;
      const emittedEvidence =
        source.evidence !== undefined || target.evidence !== undefined
          ? evidenceMetadataForPair(
              source,
              target,
              undefined,
              evidenceVectorsByVectorId,
              pageContentChunksByCanonicalUrl,
            )
          : undefined;
      edges.push({
        fromVisitKey: source.visitKey,
        toVisitKey: candidate.id,
        cosine: roundedCosine(candidate.similarity),
        ...(emittedEvidence === undefined ? {} : { metadata: emittedEvidence.metadata }),
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
  const visits = normalizeEntries(entries, options.evidenceByCanonicalUrl);
  return revisionIdFor({
    modelRevision,
    producer: 'embedding',
    threshold: config.threshold,
    topK: config.topK,
    engagementGateMs: config.engagementGateMs,
    lexicalThreshold: config.lexicalThreshold,
    lexicalFallbackEnabled: config.lexicalFallbackEnabled,
    visits,
    pageContentChunksByCanonicalUrl: options.pageContentChunksByCanonicalUrl,
  });
};

// -- Stage 5.2 W3 — incremental cosine-only fast path ---------------
// Pairs with IncrementalVisitSimilarityIndex. This is NOT byte-equal
// with buildVisitSimilarity below: that path uses a hybrid lexical +
// vector ANN rank (with rerank by source.corpus / queryVector / lexical
// fallback). The incremental path is cosine-only — same ranking
// semantics as the in-memory index. The trade-off:
//
//   - buildVisitSimilarity: byte-deterministic over the legacy
//     hybrid algorithm; expensive pairwise rebuild per drain.
//   - buildVisitSimilarityIncremental: O(1) per new visit insert;
//     produces a different revisionId (the modelRevision string is
//     suffixed `:incremental`) so the on-disk cache can keep both
//     side-by-side until the materializer decides which to use.
//
// The materializer's hot path consults `decideHotPathEmbed(budget)`
// to pick this path on warm + small-corpus drains. Worker
// reconciliation always uses buildVisitSimilarity (the byte-equality
// reference path).

import type { IncrementalVisitSimilarityIndex } from './visitSimilarity.incremental.js';

export interface BuildVisitSimilarityIncrementalInput {
  /** Persistent in-memory index maintained by the materializer across drains. */
  readonly index: IncrementalVisitSimilarityIndex;
  /** Entries to ensure are present in the index. New entries are inserted; existing entries are no-ops. */
  readonly entries: readonly VisitSimilarityEntry[];
  /** Pre-computed embeddings keyed by visitKey (passage prefix). Caller is responsible for embedding new entries. */
  readonly embeddingsByVisitKey: ReadonlyMap<string, Float32Array>;
  readonly options?: BuildVisitSimilarityOptions;
}

export const buildVisitSimilarityIncremental = (
  input: BuildVisitSimilarityIncrementalInput,
): VisitSimilarityRevision => {
  const config = resolveVisitSimilarityConfig(input.options ?? {});
  const { threshold, topK, engagementGateMs } = config;
  const modelRevision = `${RECALL_MODEL.revision}:incremental`;
  const visits = normalizeEntries(input.entries, input.options?.evidenceByCanonicalUrl);
  // PR #141 enriched revisionIdFor with producer + lexical params.
  // The incremental path is cosine-only so producer='embedding'
  // matches; lexical params still need to flow through for the id
  // to be a deterministic function of the resolved config.
  const revisionId = revisionIdFor({
    modelRevision,
    producer: 'embedding',
    threshold,
    topK,
    engagementGateMs,
    lexicalThreshold: config.lexicalThreshold,
    lexicalFallbackEnabled: config.lexicalFallbackEnabled,
    visits,
    pageContentChunksByCanonicalUrl: input.options?.pageContentChunksByCanonicalUrl,
  });
  const eligible = visits.filter((visit) => visit.focusedWindowMs >= engagementGateMs);
  // Insert each eligible visit into the index. Existing visits no-op.
  for (const visit of eligible) {
    const embedding = input.embeddingsByVisitKey.get(visit.visitKey);
    if (embedding === undefined) continue;
    input.index.insert({
      visitKey: visit.visitKey,
      embedding,
      // The caller-supplied budget context is fixed when invoking this
      // function; we expect the caller to have already gated via
      // decideHotPathEmbed before calling, so we pass a synthetic
      // always-warm budget here to skip the gate inside insert().
      budget: {
        corpusSize: 0,
        embedderWarmUntilMs: Number.MAX_SAFE_INTEGER,
        recentEmbedP99Ms: 0,
      },
    });
  }
  const visitByKey = new Map(visits.map((visit) => [visit.visitKey, visit] as const));
  const edges = input.index.edges().map((edge): VisitSimilarityEdge => {
    const left = visitByKey.get(edge.fromVisitKey);
    const right = visitByKey.get(edge.toVisitKey);
    if (left === undefined || right === undefined) return edge;
    if (left.evidence === undefined && right.evidence === undefined) return edge;
    const evidenceScore = evidenceMetadataForPair(
      left,
      right,
      edge.cosine,
      input.options?.evidenceVectorsByVectorId,
      input.options?.pageContentChunksByCanonicalUrl,
    );
    return {
      ...edge,
      metadata: evidenceScore.metadata,
    };
  });
  return {
    revisionId,
    modelId: VISIT_SIMILARITY_MODEL_ID,
    modelRevision,
    featureSchemaVersion: VISIT_SIMILARITY_FEATURE_SCHEMA_VERSION,
    threshold,
    edges,
    producedAt: Date.now(),
  };
};

export const buildVisitSimilarity = async (
  entries: readonly VisitSimilarityEntry[],
  embed: VisitSimilarityEmbedder,
  options: BuildVisitSimilarityOptions = {},
): Promise<VisitSimilarityRevision> => {
  const config = resolveVisitSimilarityConfig(options);
  const { threshold, topK, engagementGateMs, lexicalThreshold } = config;
  const fallbackAllowed = config.lexicalFallbackEnabled;
  // Optional anisotropy z-gate (default undefined = OFF). When set, the
  // producer admits an edge on z >= zMin INSTEAD of the raw cosine >=
  // threshold. Unset keeps the served edges byte-identical to the raw
  // 0.85 gate. Flipping it is a serving change awaiting the eval spine.
  const zMin = resolveSimilarityZMin();
  const zBaseline = resolveAnisotropyBaseline();
  const admitByScore = (score: number): boolean =>
    zMin === undefined ? score >= threshold : anisotropyZScore(score, zBaseline) >= zMin;
  const modelRevision = RECALL_MODEL.revision;
  const visits = normalizeEntries(entries, options.evidenceByCanonicalUrl);
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
    pageContentChunksByCanonicalUrl: options.pageContentChunksByCanonicalUrl,
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
      pageContentChunksByCanonicalUrl: options.pageContentChunksByCanonicalUrl,
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
        ? buildLexicalEdges(
            eligibleForLexical,
            lexicalThreshold,
            topK,
            options.evidenceVectorsByVectorId,
            options.pageContentChunksByCanonicalUrl,
          )
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
  // Build the lexical index ONCE — not once per source. The
  // pre-optimization loop rebuilt a fresh MiniSearch index
  // (`buildLexicalIndex`) on every source iteration over
  // `indexEntries \ {source}`: an O(n) index build inside an O(n)
  // loop, i.e. an accidental O(n²) that profiled at 71-83% of
  // buildVisitSimilarity's wall time, with clean quadratic scaling
  // (34s at 1200 visits, all of it the per-source rebuild). The
  // index is the same for every source; the self-pair is excluded
  // per query via `excludeIds`, which rankHybrid now honors on the
  // lexical arm as well as the vector arm. MiniSearch `.search()` is
  // read-only, so one shared index is safe across every source
  // query. This drops the pass to O(n) (~10x faster end to end).
  //
  // One measured behavioural caveat: MiniSearch's BM25 IDF is
  // corpus-size dependent, and the old per-source rebuild also
  // excluded the source document from the corpus, not just the
  // results. A shared index computes IDF over all n visits instead
  // of n-1, which shifts a small fraction (~2-8%) of edges that sit
  // exactly on the topK ranking boundary. That boundary is itself
  // unstable in the old code (its per-source corpus varied by which
  // visit was the source), and no shared-index variant — including
  // per-query MiniSearch remove/re-add — is byte-identical to the
  // rebuild; this was the accepted tradeoff for the 10x speedup.
  const lexicalIndex = buildLexicalIndex(indexEntries);
  // O(1) source lookup by visitKey — replaces the per-candidate
  // `eligible.find` linear scan (the loop's other accidental O(n²)).
  const eligibleByKey = new Map(eligible.map((visit) => [visit.visitKey, visit] as const));
  const edges: VisitSimilarityEdge[] = [];

  for (let sourceIndex = 0; sourceIndex < eligible.length; sourceIndex += 1) {
    const source = eligible[sourceIndex]!;
    const queryVector = queryVectors[sourceIndex];
    if (queryVector === undefined) continue;
    // `indexEntries` is the rankHybrid `items` fallback for a flat
    // vector scan; unused here because `vectorIndex` is always
    // supplied. The self-pair is excluded from both arms via
    // `excludeIds`.
    const ranked = [
      ...rankHybrid(source.corpus, queryVector, indexEntries, new Date(source.lastSeenAt), {
        limit: topK,
        lexical: lexicalIndex,
        vectorIndex,
        excludeIds: new Set<string>([source.visitKey]),
      }),
    ].sort((left, right) => {
      if (right.similarity !== left.similarity) return right.similarity - left.similarity;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });

    for (const candidate of ranked) {
      if (candidate.id <= source.visitKey) continue;
      const target = eligibleByKey.get(candidate.id);
      if (target === undefined) continue;
      const hasEvidence = source.evidence !== undefined || target.evidence !== undefined;
      const evidenceScore = hasEvidence
        ? evidenceMetadataForPair(
            source,
            target,
            candidate.similarity,
            options.evidenceVectorsByVectorId,
            options.pageContentChunksByCanonicalUrl,
          )
        : undefined;
      const score = admitByScore(candidate.similarity)
        ? candidate.similarity
        : (evidenceScore?.score ?? candidate.similarity);
      if (!admitByScore(score)) continue;
      edges.push({
        fromVisitKey: source.visitKey,
        toVisitKey: candidate.id,
        cosine: roundedCosine(score),
        ...(evidenceScore === undefined ? {} : { metadata: evidenceScore.metadata }),
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

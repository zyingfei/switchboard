import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { mapInChunks } from '../domain/asyncChunks.js';
import { createRevision } from '../domain/ids.js';
import { classifyPageContentQuality } from '../page-content/quality.js';
import { readPageContentExtractedPayloadForEvidence } from '../page-content/store.js';
import type { TimelineEntry } from '../timeline/projection.js';
import { sanitizeTimelineUrl } from '../timeline/sanitize.js';
import {
  isCurrentPageEvidenceVectorRef,
  readPageEvidenceDocVector,
  writePageEvidenceDocEmbedding,
  type PageEvidenceEmbedder,
} from './embedding.js';
import {
  buildExtractedPageEvidence,
  buildMetadataOnlyEvidence,
  evidenceCorpusForRecord,
} from './extract.js';
import {
  PAGE_EVIDENCE_EXTRACTION_CODE_VERSION,
  PAGE_EVIDENCE_FEATURE_SCHEMA_VERSION,
  PAGE_EVIDENCE_SCHEMA_VERSION,
  PAGE_EVIDENCE_TOKENIZER_VERSION,
  type PageEvidenceExtractedRequest,
  type PageEvidenceMetadataInput,
  type PageEvidenceRecord,
  type PageEvidenceTier,
  type ReadPageEvidenceResult,
  type VectorRef,
} from './types.js';

const pageEvidenceRoot = (vaultRoot: string): string => join(vaultRoot, '_BAC', 'page-evidence');
const byUrlDir = (vaultRoot: string): string => join(pageEvidenceRoot(vaultRoot), 'by-url');
const manifestPath = (vaultRoot: string): string =>
  join(pageEvidenceRoot(vaultRoot), 'manifest.json');

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const canonicalizeEvidenceUrl = (raw: string): string => {
  // Align with the URL projection's canonicalization
  // (sanitizeTimelineUrl: strips the fragment + sensitive/marketing
  // params but PRESERVES content-distinguishing params like Hacker
  // News `?id=` or `?p=`). A blanket `search=''` collapsed every
  // news.ycombinator.com/item?id=* into ONE evidence record (item X's
  // text served for item Y) and disagreed with the URL projection key.
  const sanitized = sanitizeTimelineUrl(raw);
  const trimmed = sanitized.replace(/\/$/u, '');
  return trimmed.length > 0 ? trimmed : sanitized;
};

export const pageEvidenceHash = (input: string): string =>
  createHash('sha256').update(input).digest('hex');

const recordPathForCanonicalUrl = (vaultRoot: string, canonicalUrl: string): string =>
  join(byUrlDir(vaultRoot), `${pageEvidenceHash(canonicalUrl)}.json`);

const atomicWriteJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${basename(path)}.${createRevision()}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
};

const readJson = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isTier = (value: unknown): value is PageEvidenceTier =>
  value === 'metadata_only' || value === 'content_features_only' || value === 'indexed_chunks';

const safePageEvidenceRecord = (value: unknown): PageEvidenceRecord | null => {
  if (!isRecord(value)) return null;
  if (
    value['schemaVersion'] !== PAGE_EVIDENCE_SCHEMA_VERSION ||
    typeof value['canonicalUrl'] !== 'string' ||
    typeof value['evidenceRevision'] !== 'string' ||
    typeof value['updatedAt'] !== 'string' ||
    !isTier(value['evidenceTier']) ||
    !isRecord(value['versions']) ||
    !isRecord(value['metadata'])
  ) {
    return null;
  }
  const record = value as unknown as PageEvidenceRecord;
  if (
    typeof value['semanticFeatureRevision'] === 'string' &&
    typeof value['behaviorMetadataRevision'] === 'string'
  ) {
    return record;
  }
  return {
    ...record,
    semanticFeatureRevision: record.evidenceRevision,
    behaviorMetadataRevision: record.evidenceRevision,
  };
};

const staleReasonFor = (record: PageEvidenceRecord): 'version' | 'vector' | null => {
  if (
    record.versions.extractionCodeVersion !== PAGE_EVIDENCE_EXTRACTION_CODE_VERSION ||
    record.versions.tokenizerVersion !== PAGE_EVIDENCE_TOKENIZER_VERSION ||
    record.versions.featureSchemaVersion !== PAGE_EVIDENCE_FEATURE_SCHEMA_VERSION
  ) {
    return 'version';
  }
  if (
    record.content?.docEmbeddingRef !== undefined &&
    !isCurrentPageEvidenceVectorRef(record.content.docEmbeddingRef)
  ) {
    return 'vector';
  }
  return null;
};

const readRawPageEvidence = async (
  vaultRoot: string,
  canonicalUrl: string,
): Promise<PageEvidenceRecord | null> =>
  safePageEvidenceRecord(await readJson(recordPathForCanonicalUrl(vaultRoot, canonicalUrl)));

export const readPageEvidence = async (
  vaultRoot: string,
  rawCanonicalUrl: string,
): Promise<ReadPageEvidenceResult> => {
  const canonicalUrl = canonicalizeEvidenceUrl(rawCanonicalUrl);
  const record = await readRawPageEvidence(vaultRoot, canonicalUrl);
  if (record === null) return { record: null, stale: false };
  const staleReason = staleReasonFor(record);
  if (staleReason === null) return { record, stale: false };
  return { record, stale: true, staleReason };
};

export const readPageEvidenceMap = async (
  vaultRoot: string,
  rawCanonicalUrls: readonly string[],
): Promise<ReadonlyMap<string, PageEvidenceRecord>> => {
  const out = new Map<string, PageEvidenceRecord>();
  for (const raw of rawCanonicalUrls) {
    const result = await readPageEvidence(vaultRoot, raw);
    if (result.record !== null) out.set(result.record.canonicalUrl, result.record);
  }
  return out;
};

/** File-level listing for incremental consumers (recall-v2 backfill
 *  delta): one readdir + one stat per record file, NO JSON reads.
 *  Lets a caller diff (name, mtimeMs, size) against a persisted
 *  manifest and read only the records that actually changed. */
export interface PageEvidenceRecordFileStat {
  readonly name: string;
  readonly mtimeMs: number;
  readonly size: number;
}

export const listPageEvidenceRecordFiles = async (
  vaultRoot: string,
): Promise<readonly PageEvidenceRecordFileStat[]> => {
  const dir = byUrlDir(vaultRoot);
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) =>
    name.endsWith('.json'),
  );
  // Chunked PARALLEL stats — see mapInChunks: a sequential
  // await-per-file loop over ~1800 records measured 36.9 s under
  // boot catch-up contention.
  const stats = await mapInChunks(names, 100, async (name) => {
    try {
      const s = await stat(join(dir, name));
      return { name, mtimeMs: Math.trunc(s.mtimeMs), size: s.size };
    } catch {
      // Raced with a delete — treat as absent.
      return null;
    }
  });
  return stats
    .filter((entry): entry is PageEvidenceRecordFileStat => entry !== null)
    .sort((left, right) => compareText(left.name, right.name));
};

/** Read + validate one record by its by-url/ file name. Null when the
 *  file is missing or fails the schema check (same tolerance as
 *  listPageEvidenceRecords). */
export const readPageEvidenceRecordByFileName = async (
  vaultRoot: string,
  name: string,
): Promise<PageEvidenceRecord | null> =>
  safePageEvidenceRecord(await readJson(join(byUrlDir(vaultRoot), name)));

export const listPageEvidenceRecords = async (
  vaultRoot: string,
): Promise<readonly PageEvidenceRecord[]> => {
  const dir = byUrlDir(vaultRoot);
  const names = await readdir(dir).catch(() => []);
  const records: PageEvidenceRecord[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith('.json')).sort(compareText)) {
    const record = safePageEvidenceRecord(await readJson(join(dir, name)));
    if (record !== null) records.push(record);
  }
  return records.sort((left, right) => compareText(left.canonicalUrl, right.canonicalUrl));
};

const rebuildManifest = async (vaultRoot: string): Promise<void> => {
  const records = await listPageEvidenceRecords(vaultRoot);
  const counts: Record<PageEvidenceTier, number> = {
    metadata_only: 0,
    content_features_only: 0,
    indexed_chunks: 0,
  };
  for (const record of records) counts[record.evidenceTier] += 1;
  await atomicWriteJson(manifestPath(vaultRoot), {
    version: 1,
    updatedAt: new Date().toISOString(),
    recordCount: records.length,
    byTier: counts,
    avgTopTermCount:
      records.length === 0
        ? 0
        : Number(
            (
              records.reduce((sum, record) => sum + (record.content?.terms.length ?? 0), 0) /
              records.length
            ).toFixed(2),
          ),
  });
};

const writeRecord = async (vaultRoot: string, record: PageEvidenceRecord): Promise<void> => {
  await atomicWriteJson(recordPathForCanonicalUrl(vaultRoot, record.canonicalUrl), record);
};

const shouldWriteRecord = (
  previous: PageEvidenceRecord | null,
  record: PageEvidenceRecord,
): boolean =>
  previous?.evidenceRevision !== record.evidenceRevision ||
  previous?.behaviorMetadataRevision !== record.behaviorMetadataRevision ||
  previous?.content?.embeddingState !== record.content?.embeddingState;

const writeRecordIfChanged = async (
  vaultRoot: string,
  previous: PageEvidenceRecord | null,
  record: PageEvidenceRecord,
  options: { readonly rebuildManifestAfterWrite?: boolean },
): Promise<boolean> => {
  if (!shouldWriteRecord(previous, record)) return false;
  await writeRecord(vaultRoot, record);
  if (options.rebuildManifestAfterWrite !== false) await rebuildManifest(vaultRoot);
  return true;
};

export const writeMetadataOnlyPageEvidence = async (
  vaultRoot: string,
  input: PageEvidenceMetadataInput,
  options: { readonly rebuildManifestAfterWrite?: boolean } = {},
): Promise<PageEvidenceRecord> => {
  const canonicalUrl = canonicalizeEvidenceUrl(input.canonicalUrl);
  const previous = await readRawPageEvidence(vaultRoot, canonicalUrl);
  const record = buildMetadataOnlyEvidence({ ...input, canonicalUrl }, previous ?? undefined);
  if (
    previous?.evidenceRevision !== record.evidenceRevision ||
    previous?.behaviorMetadataRevision !== record.behaviorMetadataRevision
  ) {
    await writeRecord(vaultRoot, record);
    if (options.rebuildManifestAfterWrite !== false) await rebuildManifest(vaultRoot);
  }
  return record;
};

type TimelineEvidenceEntry = TimelineEntry & { readonly dimensions?: unknown };

const focusedWindowMsForTimelineEntry = (entry: TimelineEvidenceEntry): number | undefined => {
  const dimensions = entry.dimensions;
  if (!isRecord(dimensions)) return undefined;
  const engagement = dimensions['engagement'];
  if (!isRecord(engagement)) return undefined;
  const focused = engagement['focusedWindowMs'];
  return typeof focused === 'number' && Number.isFinite(focused) && focused >= 0
    ? focused
    : undefined;
};

export const ensurePageEvidenceForTimelineEntries = async (
  vaultRoot: string,
  entries: readonly TimelineEvidenceEntry[],
  options: { readonly rebuildManifestAfterWrite?: boolean } = {},
): Promise<ReadonlyMap<string, PageEvidenceRecord>> => {
  const byCanonical = new Map<string, PageEvidenceMetadataInput>();
  for (const entry of entries) {
    const canonicalUrl = canonicalizeEvidenceUrl(entry.canonicalUrl ?? entry.url);
    const existing = byCanonical.get(canonicalUrl);
    const focusedWindowMs = focusedWindowMsForTimelineEntry(entry);
    const next: PageEvidenceMetadataInput = {
      canonicalUrl,
      url: entry.url,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      ...(entry.provider === undefined ? {} : { provider: entry.provider }),
      firstSeenAt:
        existing?.firstSeenAt === undefined || entry.firstSeenAt < existing.firstSeenAt
          ? entry.firstSeenAt
          : existing.firstSeenAt,
      lastSeenAt:
        existing?.lastSeenAt === undefined || entry.lastSeenAt > existing.lastSeenAt
          ? entry.lastSeenAt
          : existing.lastSeenAt,
      visitCount: Math.max(existing?.visitCount ?? 0, entry.visitCount ?? 0),
      focusedWindowMs: Math.max(existing?.focusedWindowMs ?? 0, focusedWindowMs ?? 0),
    };
    byCanonical.set(canonicalUrl, next);
  }
  const out = new Map<string, PageEvidenceRecord>();
  for (const input of [...byCanonical.values()].sort((left, right) =>
    compareText(left.canonicalUrl, right.canonicalUrl),
  )) {
    let record = await writeMetadataOnlyPageEvidence(vaultRoot, input, {
      rebuildManifestAfterWrite: false,
    });
    const indexedPayload = await readPageContentExtractedPayloadForEvidence(
      vaultRoot,
      input.canonicalUrl,
    );
    if (
      indexedPayload !== null &&
      (staleReasonFor(record) !== null ||
        record.evidenceTier !== 'indexed_chunks' ||
        record.content?.contentHash !== indexedPayload.content.contentHash)
    ) {
      record = await writeExtractedPageEvidenceFast(
        vaultRoot,
        {
          ...indexedPayload,
          storageMode: 'indexed_chunks',
        },
        { rebuildManifestAfterWrite: false },
      );
    }
    out.set(record.canonicalUrl, record);
  }
  // The ingest-time caller (importTimelineEvents) passes false: the
  // per-URL record files are written above and `readPageEvidence`
  // (the badge poll) reads those directly, so the page is visible
  // without the O(records) manifest walk. The connections reconcile
  // still runs this with the default and rebuilds the manifest once.
  if (options.rebuildManifestAfterWrite !== false) await rebuildManifest(vaultRoot);
  return out;
};

export const writeExtractedPageEvidence = async (
  vaultRoot: string,
  payload: PageEvidenceExtractedRequest,
  options: {
    readonly embedder?: PageEvidenceEmbedder;
    readonly embeddingsEnabled?: boolean;
    readonly rebuildManifestAfterWrite?: boolean;
  } = {},
): Promise<PageEvidenceRecord> => {
  const fastState = await writeExtractedPageEvidenceFastState(vaultRoot, payload, {
    rebuildManifestAfterWrite: false,
    ...(options.embeddingsEnabled === undefined
      ? {}
      : { embeddingsEnabled: options.embeddingsEnabled }),
  });
  const fast = fastState.record;
  if (
    fast.evidenceTier === 'metadata_only' ||
    options.embeddingsEnabled === false ||
    fast.content?.embeddingState === 'ready'
  ) {
    if (fastState.wrote && options.rebuildManifestAfterWrite !== false) {
      await rebuildManifest(vaultRoot);
    }
    return fast;
  }
  return await completeExtractedPageEvidenceEmbedding(vaultRoot, payload, options);
};

interface FastExtractedPageEvidenceWriteResult {
  readonly record: PageEvidenceRecord;
  readonly wrote: boolean;
}

const writeExtractedPageEvidenceFastState = async (
  vaultRoot: string,
  payload: PageEvidenceExtractedRequest,
  options: {
    readonly embeddingsEnabled?: boolean;
    readonly rebuildManifestAfterWrite?: boolean;
  } = {},
): Promise<FastExtractedPageEvidenceWriteResult> => {
  const canonicalUrl = canonicalizeEvidenceUrl(payload.canonicalUrl);
  const previous = await readRawPageEvidence(vaultRoot, canonicalUrl);
  const quality = classifyPageContentQuality(payload.qualitySignals);
  if (quality.state === 'metadata_only_error') {
    const record = buildMetadataOnlyEvidence(
      {
        canonicalUrl,
        url: payload.url,
        ...(payload.title === undefined ? {} : { title: payload.title }),
        ...(payload.provider === undefined ? {} : { provider: payload.provider }),
        lastSeenAt: payload.extractedAt,
      },
      previous ?? undefined,
    );
    const wrote = await writeRecordIfChanged(vaultRoot, previous, record, options);
    return { record, wrote };
  }
  const normalizedPayload = {
    ...payload,
    canonicalUrl,
    quality: quality.quality ?? payload.quality,
  };
  const previousDocEmbeddingRef = previous?.content?.docEmbeddingRef;
  const canCarryCurrentEmbedding =
    options.embeddingsEnabled !== false &&
    previous?.content?.contentHash === normalizedPayload.content.contentHash &&
    previousDocEmbeddingRef !== undefined &&
    isCurrentPageEvidenceVectorRef(previousDocEmbeddingRef);
  const record = buildExtractedPageEvidence(
    normalizedPayload,
    previous ?? undefined,
    options.embeddingsEnabled === false
      ? { embeddingState: 'disabled' }
      : canCarryCurrentEmbedding
        ? { docEmbeddingRef: previousDocEmbeddingRef, embeddingState: 'ready' }
        : { embeddingState: 'missing' },
  );
  const wrote = await writeRecordIfChanged(vaultRoot, previous, record, options);
  return { record, wrote };
};

export const writeExtractedPageEvidenceFast = async (
  vaultRoot: string,
  payload: PageEvidenceExtractedRequest,
  options: {
    readonly embeddingsEnabled?: boolean;
    readonly rebuildManifestAfterWrite?: boolean;
  } = {},
): Promise<PageEvidenceRecord> =>
  (await writeExtractedPageEvidenceFastState(vaultRoot, payload, options)).record;

const isCurrentEvidenceForEmbeddingCompletion = (
  record: PageEvidenceRecord | null,
  payload: PageEvidenceExtractedRequest,
): boolean => {
  if (record === null) return true;
  if (
    record.content?.contentHash !== undefined &&
    record.content.contentHash !== payload.content.contentHash
  ) {
    return false;
  }
  return record.updatedAt <= payload.extractedAt;
};

export const completeExtractedPageEvidenceEmbedding = async (
  vaultRoot: string,
  payload: PageEvidenceExtractedRequest,
  options: {
    readonly embedder?: PageEvidenceEmbedder;
    readonly embeddingsEnabled?: boolean;
    readonly rebuildManifestAfterWrite?: boolean;
  } = {},
): Promise<PageEvidenceRecord> => {
  if (options.embeddingsEnabled === false) {
    return await writeExtractedPageEvidenceFast(vaultRoot, payload, options);
  }
  const canonicalUrl = canonicalizeEvidenceUrl(payload.canonicalUrl);
  const initial = await readRawPageEvidence(vaultRoot, canonicalUrl);
  const quality = classifyPageContentQuality(payload.qualitySignals);
  if (quality.state === 'metadata_only_error') {
    return await writeExtractedPageEvidenceFast(vaultRoot, payload, options);
  }
  const normalizedPayload = {
    ...payload,
    canonicalUrl,
    quality: quality.quality ?? payload.quality,
  };
  if (initial !== null && !isCurrentEvidenceForEmbeddingCompletion(initial, normalizedPayload)) {
    return initial;
  }
  const initialDocEmbeddingRef = initial?.content?.docEmbeddingRef;
  if (
    initial !== null &&
    initial?.content?.contentHash === normalizedPayload.content.contentHash &&
    initialDocEmbeddingRef !== undefined &&
    isCurrentPageEvidenceVectorRef(initialDocEmbeddingRef)
  ) {
    const record = buildExtractedPageEvidence(normalizedPayload, initial, {
      docEmbeddingRef: initialDocEmbeddingRef,
      embeddingState: 'ready',
    });
    await writeRecordIfChanged(vaultRoot, initial, record, options);
    return record;
  }
  let docEmbeddingRef: VectorRef | undefined;
  let embeddingState: 'missing' | 'failed' | 'ready' = 'missing';
  try {
    docEmbeddingRef = await writePageEvidenceDocEmbedding(
      vaultRoot,
      normalizedPayload,
      options.embedder,
    );
    embeddingState = docEmbeddingRef === undefined ? 'missing' : 'ready';
  } catch {
    docEmbeddingRef = undefined;
    embeddingState = 'failed';
  }
  const latest = await readRawPageEvidence(vaultRoot, canonicalUrl);
  if (latest !== null && !isCurrentEvidenceForEmbeddingCompletion(latest, normalizedPayload)) {
    return latest;
  }
  const record = buildExtractedPageEvidence(
    normalizedPayload,
    latest ?? undefined,
    docEmbeddingRef === undefined ? { embeddingState } : { docEmbeddingRef, embeddingState },
  );
  await writeRecordIfChanged(vaultRoot, latest, record, options);
  return record;
};

export interface PageEvidenceStats {
  readonly bytes: number;
  readonly records: number;
  readonly metadataOnlyCount: number;
  readonly featuresOnlyCount: number;
  readonly indexedChunkCount: number;
  readonly contentVectorReadyCount: number;
  readonly contentVectorMissingCount: number;
  readonly contentVectorDisabledCount: number;
  readonly contentVectorFailedCount: number;
  readonly avgTopTermCount: number;
  readonly featureOnlyPages: number;
  readonly pageEvidenceRawTextPersistedBytes: 0;
}

export const pageEvidenceStorageStats = async (vaultRoot: string): Promise<PageEvidenceStats> => {
  const root = pageEvidenceRoot(vaultRoot);
  const walk = async (path: string): Promise<number> => {
    const info = await stat(path).catch(() => null);
    if (info === null) return 0;
    if (!info.isDirectory()) return info.size;
    const names = await readdir(path).catch(() => []);
    const sizes = await Promise.all(names.map((name) => walk(join(path, name))));
    return sizes.reduce((sum, size) => sum + size, 0);
  };
  const records = await listPageEvidenceRecords(vaultRoot);
  const metadataOnly = records.filter((record) => record.evidenceTier === 'metadata_only').length;
  const featuresOnly = records.filter(
    (record) => record.evidenceTier === 'content_features_only',
  ).length;
  const indexed = records.filter((record) => record.evidenceTier === 'indexed_chunks').length;
  const contentRecords = records.filter((record) => record.content !== undefined);
  return {
    bytes: await walk(root),
    records: records.length,
    metadataOnlyCount: metadataOnly,
    featuresOnlyCount: featuresOnly,
    indexedChunkCount: indexed,
    contentVectorReadyCount: contentRecords.filter(
      (record) => record.content?.docEmbeddingRef !== undefined,
    ).length,
    contentVectorMissingCount: contentRecords.filter(
      (record) =>
        record.content?.docEmbeddingRef === undefined &&
        record.content?.embeddingState !== 'disabled' &&
        record.content?.embeddingState !== 'failed',
    ).length,
    contentVectorDisabledCount: contentRecords.filter(
      (record) => record.content?.embeddingState === 'disabled',
    ).length,
    contentVectorFailedCount: contentRecords.filter(
      (record) => record.content?.embeddingState === 'failed',
    ).length,
    avgTopTermCount:
      records.length === 0
        ? 0
        : Number(
            (
              records.reduce((sum, record) => sum + (record.content?.terms.length ?? 0), 0) /
              records.length
            ).toFixed(2),
          ),
    featureOnlyPages: featuresOnly,
    pageEvidenceRawTextPersistedBytes: 0,
  };
};

export const pageEvidenceCorpusFor = (
  evidenceByCanonicalUrl: ReadonlyMap<string, PageEvidenceRecord>,
  canonicalUrl: string,
): string | undefined => {
  const record = evidenceByCanonicalUrl.get(canonicalizeEvidenceUrl(canonicalUrl));
  return record === undefined ? undefined : evidenceCorpusForRecord(record);
};

export const readPageEvidenceVectorMap = async (
  vaultRoot: string,
  records: Iterable<PageEvidenceRecord>,
): Promise<ReadonlyMap<string, Float32Array>> => {
  const out = new Map<string, Float32Array>();
  for (const record of records) {
    const ref = record.content?.docEmbeddingRef;
    if (ref === undefined) continue;
    const vector = await readPageEvidenceDocVector(vaultRoot, ref);
    if (vector !== null) out.set(ref.vectorId, vector);
  }
  return out;
};

// ─────────────────────────────────────────────────────────────────────
// Background-embedding lane adapters
//
// These bind the abstract BackgroundEmbeddingLaneDeps
// (page-evidence/backgroundEmbeddingLane.ts) to concrete vault I/O. The
// lane owns cadence + batch-cap + drain-pause; these functions own the
// per-record vault reads/writes.
// ─────────────────────────────────────────────────────────────────────

/** List every record as a lane candidate. The lane classifies backlog
 *  membership itself (isBackgroundEmbeddingBacklog); this just surfaces
 *  the structural fields it needs. */
export const listBackgroundEmbeddingCandidates = async (
  vaultRoot: string,
): Promise<
  readonly {
    readonly canonicalUrl: string;
    readonly url: string;
    readonly title?: string;
    readonly evidenceTier: PageEvidenceTier;
    readonly content?: {
      readonly embeddingState?: 'disabled' | 'missing' | 'failed' | 'ready';
      readonly docEmbeddingRef?: VectorRef;
    };
  }[]
> => {
  const records = await listPageEvidenceRecords(vaultRoot);
  return records.map((record) => ({
    canonicalUrl: record.canonicalUrl,
    // The record stores only the canonical URL (no raw URL); it is a
    // fully-formed https URL, so it satisfies the tombstone matcher's
    // registrableDomainFromUrl. `metadata.host` is the bare host only.
    url: record.canonicalUrl,
    ...(record.metadata.title === undefined ? {} : { title: record.metadata.title }),
    evidenceTier: record.evidenceTier,
    ...(record.content === undefined
      ? {}
      : {
          content: {
            ...(record.content.embeddingState === undefined
              ? {}
              : { embeddingState: record.content.embeddingState }),
            ...(record.content.docEmbeddingRef === undefined
              ? {}
              : { docEmbeddingRef: record.content.docEmbeddingRef }),
          },
        }),
  }));
};

/**
 * Embed one backlog canonical URL by reconstructing the extraction
 * payload (with raw text) from the page-content store, then routing it
 * through the SAME `completeExtractedPageEvidenceEmbedding` path the
 * request handler uses. The embedder is the process-global override
 * (recall/embedder.js) — off-main when the runtime installed the
 * embedder child.
 *
 * Returns:
 *   - 'skipped'  — no indexed content payload on disk (content-features-
 *                  only page, or raw text absent). Not a failure.
 *   - 'embedded' — a ready vector now backs the record.
 *   - 'failed'   — the record still has no ready vector after the pass
 *                  (embed threw, or produced no vector).
 */
export const embedBacklogCanonicalUrl = async (
  vaultRoot: string,
): Promise<(canonicalUrl: string) => Promise<'embedded' | 'skipped' | 'failed'>> => {
  return async (rawCanonicalUrl) => {
    const payload = await readPageContentExtractedPayloadForEvidence(vaultRoot, rawCanonicalUrl);
    if (payload === null) return 'skipped';
    const record = await completeExtractedPageEvidenceEmbedding(
      vaultRoot,
      { ...payload, storageMode: 'indexed_chunks' },
      { rebuildManifestAfterWrite: false },
    );
    if (record.content?.embeddingState === 'ready' && record.content.docEmbeddingRef !== undefined) {
      return 'embedded';
    }
    return 'failed';
  };
};

const BACKGROUND_EMBEDDING_PROGRESS_FILENAME = 'embed-lane-progress.json';

const backgroundEmbeddingProgressPath = (vaultRoot: string): string =>
  join(pageEvidenceRoot(vaultRoot), BACKGROUND_EMBEDDING_PROGRESS_FILENAME);

export interface BackgroundEmbeddingProgressArtifact {
  readonly schemaVersion: 1;
  readonly attemptsByCanonicalUrl: Record<string, number>;
  readonly embeddedTotal: number;
  readonly lastRunAtMs: number | null;
}

export const readBackgroundEmbeddingProgress = async (
  vaultRoot: string,
): Promise<BackgroundEmbeddingProgressArtifact | null> => {
  const parsed = await readJson<BackgroundEmbeddingProgressArtifact>(
    backgroundEmbeddingProgressPath(vaultRoot),
  );
  if (parsed === null || parsed.schemaVersion !== 1) return null;
  return parsed;
};

export const writeBackgroundEmbeddingProgress = async (
  vaultRoot: string,
  progress: BackgroundEmbeddingProgressArtifact,
): Promise<void> => {
  await atomicWriteJson(backgroundEmbeddingProgressPath(vaultRoot), progress);
};

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { createRevision } from '../domain/ids.js';
import { classifyPageContentQuality } from '../page-content/quality.js';
import { readPageContentExtractedPayloadForEvidence } from '../page-content/store.js';
import type { TimelineEntry } from '../timeline/projection.js';
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
  const parsed = new URL(raw);
  parsed.hash = '';
  parsed.search = '';
  const normalized = parsed.toString().replace(/\/$/u, '');
  return normalized.length > 0 ? normalized : parsed.toString();
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
      record = await writeExtractedPageEvidence(
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
  await rebuildManifest(vaultRoot);
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
    if (
      previous?.evidenceRevision !== record.evidenceRevision ||
      previous?.behaviorMetadataRevision !== record.behaviorMetadataRevision
    ) {
      await writeRecord(vaultRoot, record);
      if (options.rebuildManifestAfterWrite !== false) await rebuildManifest(vaultRoot);
    }
    return record;
  }
  let docEmbeddingRef: VectorRef | undefined;
  let embeddingState: 'disabled' | 'missing' | 'failed' | 'ready' =
    options.embeddingsEnabled === false ? 'disabled' : 'missing';
  const normalizedPayload = {
    ...payload,
    canonicalUrl,
    quality: quality.quality ?? payload.quality,
  };
  if (options.embeddingsEnabled !== false) {
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
  }
  const record = buildExtractedPageEvidence(
    normalizedPayload,
    previous ?? undefined,
    docEmbeddingRef === undefined ? { embeddingState } : { docEmbeddingRef, embeddingState },
  );
  if (
    previous?.evidenceRevision !== record.evidenceRevision ||
    previous?.behaviorMetadataRevision !== record.behaviorMetadataRevision
  ) {
    await writeRecord(vaultRoot, record);
    if (options.rebuildManifestAfterWrite !== false) await rebuildManifest(vaultRoot);
  }
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

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { createRevision } from '../domain/ids.js';
import { extractPageEvidenceFeatures } from '../page-evidence/extract.js';
import {
  PAGE_CONTENT_COVERAGE_STATES,
  PAGE_CONTENT_EXTRACTED,
  PAGE_CONTENT_TOMBSTONED,
  type ContentSearchHit,
  type PageContentChunk,
  type PageContentCoverage,
  type PageContentCoverageState,
  type PageContentExtractedPayload,
  type PageContentRecord,
  type PageContentTombstonedPayload,
} from './types.js';
import { classifyPageContentQuality } from './quality.js';

const MAX_RAW_TEXT_CHARS = 100_000;
const MAX_CHUNKS_PER_PAGE = 80;
const CHUNK_TARGET_CHARS = 1_200;

export const canonicalizePageUrl = (raw: string): string => {
  const parsed = new URL(raw);
  parsed.hash = '';
  parsed.search = '';
  const normalized = parsed.toString().replace(/\/$/u, '');
  return normalized.length > 0 ? normalized : parsed.toString();
};

export const sha256Hex = (input: string): string =>
  createHash('sha256').update(input).digest('hex');

const pageContentRoot = (vaultRoot: string): string => join(vaultRoot, '_BAC', 'page-content');
const byUrlDir = (vaultRoot: string): string => join(pageContentRoot(vaultRoot), 'by-url');
const rawDir = (vaultRoot: string): string => join(pageContentRoot(vaultRoot), 'raw');
const chunksDir = (vaultRoot: string): string => join(pageContentRoot(vaultRoot), 'chunks');
const recordPathForCanonicalUrl = (vaultRoot: string, canonicalUrl: string): string =>
  join(byUrlDir(vaultRoot), `${sha256Hex(canonicalUrl)}.json`);
const rawPathForContentHash = (vaultRoot: string, contentHash: string): string =>
  join(rawDir(vaultRoot), `${contentHash}.json`);
const chunksManifestPath = (vaultRoot: string): string =>
  join(chunksDir(vaultRoot), 'manifest.json');
const manifestPath = (vaultRoot: string): string =>
  join(pageContentRoot(vaultRoot), 'manifest.json');
const ingestStatePath = (vaultRoot: string): string =>
  join(pageContentRoot(vaultRoot), 'ingest-state.json');

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

const safeRecordFromUnknown = (value: unknown): PageContentRecord | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Partial<PageContentRecord>;
  if (
    typeof record.url !== 'string' ||
    typeof record.updatedAt !== 'string' ||
    typeof record.coverage !== 'object' ||
    record.coverage === null
  ) {
    return null;
  }
  const coverage = record.coverage as Partial<PageContentCoverage>;
  if (typeof coverage.canonicalUrl !== 'string' || typeof coverage.state !== 'string') return null;
  return record as PageContentRecord;
};

export const splitPageContentIntoChunks = (input: {
  readonly canonicalUrl: string;
  readonly url: string;
  readonly title?: string;
  readonly contentHash: string;
  readonly text: string;
  readonly extractedAt: string;
  readonly quality: 'high' | 'medium' | 'low';
  readonly extractionStrategy: 'manual-selection' | 'reader-mode' | 'visible-dom';
}): readonly PageContentChunk[] => {
  const paragraphs = input.text
    .split(/\n{2,}/u)
    .map((part) => part.replace(/\s+/gu, ' ').trim())
    .filter((part) => part.length > 0);
  const chunks: PageContentChunk[] = [];
  let cursor = 0;
  let buffer = '';
  let bufferStart = 0;
  const flush = (): void => {
    const text = buffer.trim();
    if (text.length === 0 || chunks.length >= MAX_CHUNKS_PER_PAGE) {
      buffer = '';
      return;
    }
    const charStart = bufferStart;
    const charEnd = charStart + text.length;
    chunks.push({
      id: `${sha256Hex(input.canonicalUrl).slice(0, 24)}:${String(chunks.length)}`,
      canonicalUrl: input.canonicalUrl,
      url: input.url,
      ...(input.title === undefined ? {} : { title: input.title }),
      contentHash: input.contentHash,
      chunkIndex: chunks.length,
      charStart,
      charEnd,
      text,
      extractedAt: input.extractedAt,
      quality: input.quality,
      extractionStrategy: input.extractionStrategy,
    });
    buffer = '';
  };

  for (const paragraph of paragraphs.length > 0 ? paragraphs : [input.text]) {
    const index = input.text.indexOf(paragraph, cursor);
    if (buffer.length === 0) {
      bufferStart = index >= 0 ? index : cursor;
    }
    if (buffer.length + paragraph.length > CHUNK_TARGET_CHARS && buffer.length > 0) {
      flush();
      bufferStart = index >= 0 ? index : cursor;
    }
    buffer = buffer.length === 0 ? paragraph : `${buffer}\n\n${paragraph}`;
    cursor = (index >= 0 ? index : cursor) + paragraph.length;
  }
  flush();
  return chunks;
};

const qualityWeightFor = (quality: 'high' | 'medium' | 'low'): number => {
  if (quality === 'high') return 1;
  if (quality === 'medium') return 0.75;
  return 0.25;
};

const enrichChunksWithEvidence = (
  chunks: readonly PageContentChunk[],
): readonly PageContentChunk[] =>
  chunks.map((chunk) => ({
    ...chunk,
    terms: extractPageEvidenceFeatures({
      canonicalUrl: chunk.canonicalUrl,
      url: chunk.url,
      ...(chunk.title === undefined ? {} : { title: chunk.title }),
      text: chunk.text,
    }).terms.slice(0, 24),
    qualityWeight: qualityWeightFor(chunk.quality),
  }));

const readAllRecords = async (vaultRoot: string): Promise<readonly PageContentRecord[]> => {
  const dir = byUrlDir(vaultRoot);
  const names = await readdir(dir).catch(() => []);
  const records: PageContentRecord[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith('.json'))) {
    const record = safeRecordFromUnknown(await readJson(join(dir, name)));
    if (record !== null) records.push(record);
  }
  return records.sort((left, right) =>
    left.coverage.canonicalUrl.localeCompare(right.coverage.canonicalUrl),
  );
};

const rebuildManifests = async (vaultRoot: string): Promise<void> => {
  const records = await readAllRecords(vaultRoot);
  const chunks = records
    .flatMap((record) => {
      const coverage = record.coverage;
      return coverage.state === 'indexed' || coverage.state === 'indexed_low_quality'
        ? [
            {
              canonicalUrl: coverage.canonicalUrl,
              contentHash: coverage.contentHash,
              chunkCount: coverage.chunkCount ?? 0,
            },
          ]
        : [];
    })
    .filter((entry) => typeof entry.contentHash === 'string');
  await atomicWriteJson(manifestPath(vaultRoot), {
    version: 1,
    updatedAt: new Date().toISOString(),
    recordCount: records.length,
    indexedCount: records.filter((record) => record.coverage.state === 'indexed').length,
    lowQualityCount: records.filter((record) => record.coverage.state === 'indexed_low_quality')
      .length,
    tombstonedCount: records.filter((record) => record.coverage.state === 'tombstoned').length,
  });
  await atomicWriteJson(ingestStatePath(vaultRoot), {
    version: 1,
    updatedAt: new Date().toISOString(),
  });
  await atomicWriteJson(chunksManifestPath(vaultRoot), {
    version: 1,
    updatedAt: new Date().toISOString(),
    pages: chunks,
  });
};

export const readPageContentCoverage = async (
  vaultRoot: string,
  rawCanonicalUrl: string,
): Promise<PageContentCoverage> => {
  const canonicalUrl = canonicalizePageUrl(rawCanonicalUrl);
  const record = safeRecordFromUnknown(
    await readJson(recordPathForCanonicalUrl(vaultRoot, canonicalUrl)),
  );
  return (
    record?.coverage ?? {
      canonicalUrl,
      state: 'metadata_only_legacy',
      policyReason: 'not_indexed_yet',
    }
  );
};

export const readPageContentCoverageMap = async (
  vaultRoot: string,
  rawCanonicalUrls: readonly string[],
): Promise<ReadonlyMap<string, PageContentCoverage>> => {
  const out = new Map<string, PageContentCoverage>();
  for (const raw of rawCanonicalUrls) {
    const coverage = await readPageContentCoverage(vaultRoot, raw);
    out.set(coverage.canonicalUrl, coverage);
  }
  return out;
};

export const writePageContentExtracted = async (
  vaultRoot: string,
  payload: PageContentExtractedPayload,
): Promise<PageContentCoverage> => {
  const canonicalUrl = canonicalizePageUrl(payload.canonicalUrl);
  const contentHash = payload.content.contentHash || sha256Hex(payload.content.text);
  const quality = classifyPageContentQuality(payload.qualitySignals);
  if (quality.state === 'metadata_only_error') {
    const coverage: PageContentCoverage = {
      canonicalUrl,
      state: 'metadata_only_error',
      qualitySignals: payload.qualitySignals,
      lastVisitedAt: payload.extractedAt,
      extractionSource: payload.extractionSource,
      ...(quality.error === undefined ? {} : { error: quality.error }),
    };
    await atomicWriteJson(recordPathForCanonicalUrl(vaultRoot, canonicalUrl), {
      coverage,
      url: payload.url,
      ...(payload.title === undefined ? {} : { title: payload.title }),
      ...(payload.provider === undefined ? {} : { provider: payload.provider }),
      updatedAt: payload.extractedAt,
      sourceEventType: PAGE_CONTENT_EXTRACTED,
    } satisfies PageContentRecord);
    await rebuildManifests(vaultRoot);
    return coverage;
  }

  const text = payload.content.text.slice(0, MAX_RAW_TEXT_CHARS);
  const chunks = enrichChunksWithEvidence(
    splitPageContentIntoChunks({
      canonicalUrl,
      url: payload.url,
      ...(payload.title === undefined ? {} : { title: payload.title }),
      contentHash,
      text,
      extractedAt: payload.extractedAt,
      quality: quality.quality ?? payload.quality,
      extractionStrategy: payload.extractionSource,
    }),
  );
  await atomicWriteJson(rawPathForContentHash(vaultRoot, contentHash), {
    version: 1,
    canonicalUrl,
    url: payload.url,
    ...(payload.title === undefined ? {} : { title: payload.title }),
    extractedAt: payload.extractedAt,
    text,
    ...(payload.content.markdown === undefined ? {} : { markdown: payload.content.markdown }),
  });
  const coverage: PageContentCoverage = {
    canonicalUrl,
    state: quality.state,
    quality: quality.quality ?? payload.quality,
    qualitySignals: payload.qualitySignals,
    lastVisitedAt: payload.extractedAt,
    lastIndexedAt: payload.extractedAt,
    contentHash,
    extractionSource: payload.extractionSource,
    chunkCount: chunks.length,
    indexedCharCount: text.length,
  };
  await atomicWriteJson(recordPathForCanonicalUrl(vaultRoot, canonicalUrl), {
    coverage,
    url: payload.url,
    ...(payload.title === undefined ? {} : { title: payload.title }),
    ...(payload.provider === undefined ? {} : { provider: payload.provider }),
    updatedAt: payload.extractedAt,
    sourceEventType: PAGE_CONTENT_EXTRACTED,
  } satisfies PageContentRecord);
  await atomicWriteJson(join(chunksDir(vaultRoot), `${contentHash}.json`), { version: 1, chunks });
  await rebuildManifests(vaultRoot);
  return coverage;
};

export const writePageContentTombstoned = async (
  vaultRoot: string,
  payload: PageContentTombstonedPayload,
): Promise<PageContentCoverage> => {
  const canonicalUrl = canonicalizePageUrl(payload.canonicalUrl);
  const previous = await readPageContentCoverage(vaultRoot, canonicalUrl);
  const contentHash = payload.contentHash ?? previous.contentHash;
  if (contentHash !== undefined) {
    await unlink(rawPathForContentHash(vaultRoot, contentHash)).catch(() => undefined);
    await unlink(join(chunksDir(vaultRoot), `${contentHash}.json`)).catch(() => undefined);
  }
  const coverage: PageContentCoverage = {
    canonicalUrl,
    state: 'tombstoned',
    policyReason: payload.reason,
    ...(previous.lastVisitedAt === undefined ? {} : { lastVisitedAt: previous.lastVisitedAt }),
    ...(previous.lastIndexedAt === undefined ? {} : { lastIndexedAt: previous.lastIndexedAt }),
    ...(contentHash === undefined ? {} : { contentHash }),
  };
  await atomicWriteJson(recordPathForCanonicalUrl(vaultRoot, canonicalUrl), {
    coverage,
    url: canonicalUrl,
    updatedAt: payload.tombstonedAt,
    sourceEventType: PAGE_CONTENT_TOMBSTONED,
  } satisfies PageContentRecord);
  await rebuildManifests(vaultRoot);
  return coverage;
};

export const readPageContentExtractedPayloadForEvidence = async (
  vaultRoot: string,
  rawCanonicalUrl: string,
): Promise<PageContentExtractedPayload | null> => {
  const canonicalUrl = canonicalizePageUrl(rawCanonicalUrl);
  const record = safeRecordFromUnknown(
    await readJson(recordPathForCanonicalUrl(vaultRoot, canonicalUrl)),
  );
  const coverage = record?.coverage;
  if (
    record === null ||
    coverage === undefined ||
    coverage.contentHash === undefined ||
    coverage.quality === undefined ||
    coverage.qualitySignals === undefined ||
    coverage.extractionSource === undefined ||
    (coverage.state !== 'indexed' &&
      coverage.state !== 'indexed_low_quality' &&
      coverage.state !== 'stale_index')
  ) {
    return null;
  }
  const raw = await readJson<{
    readonly url?: unknown;
    readonly title?: unknown;
    readonly extractedAt?: unknown;
    readonly text?: unknown;
    readonly markdown?: unknown;
  }>(rawPathForContentHash(vaultRoot, coverage.contentHash));
  if (raw === null || typeof raw.text !== 'string' || raw.text.length === 0) return null;
  return {
    payloadVersion: 1,
    canonicalUrl,
    url: typeof raw.url === 'string' ? raw.url : record.url,
    ...(typeof raw.title === 'string'
      ? { title: raw.title }
      : record.title === undefined
        ? {}
        : { title: record.title }),
    ...(record.provider === undefined ? {} : { provider: record.provider }),
    extractedAt:
      typeof raw.extractedAt === 'string'
        ? raw.extractedAt
        : (coverage.lastIndexedAt ?? record.updatedAt),
    extractionSource: coverage.extractionSource,
    extractionPolicy: { trigger: 'manual' },
    quality: coverage.quality,
    qualitySignals: coverage.qualitySignals,
    content: {
      text: raw.text,
      ...(typeof raw.markdown === 'string' ? { markdown: raw.markdown } : {}),
      contentHash: coverage.contentHash,
      charCount: raw.text.length,
    },
  };
};

export const readPageContentChunksForCanonicalUrls = async (
  vaultRoot: string,
  rawCanonicalUrls: readonly string[],
): Promise<ReadonlyMap<string, readonly PageContentChunk[]>> => {
  const out = new Map<string, readonly PageContentChunk[]>();
  const uniqueCanonicalUrls = [...new Set(rawCanonicalUrls.map(canonicalizePageUrl))].sort();
  for (const canonicalUrl of uniqueCanonicalUrls) {
    const record = safeRecordFromUnknown(
      await readJson(recordPathForCanonicalUrl(vaultRoot, canonicalUrl)),
    );
    const coverage = record?.coverage;
    if (
      coverage === undefined ||
      coverage.contentHash === undefined ||
      (coverage.state !== 'indexed' &&
        coverage.state !== 'indexed_low_quality' &&
        coverage.state !== 'stale_index')
    ) {
      continue;
    }
    const raw = await readJson<{ readonly chunks?: readonly PageContentChunk[] }>(
      join(chunksDir(vaultRoot), `${coverage.contentHash}.json`),
    );
    const chunks = raw?.chunks ?? [];
    if (chunks.length > 0) out.set(canonicalUrl, enrichChunksWithEvidence(chunks));
  }
  return out;
};

const tokenize = (input: string): readonly string[] =>
  input
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/u)
    .filter((token) => token.length >= 2);

const snippetFor = (text: string, tokens: readonly string[], maxChars = 220): string => {
  const lower = text.toLowerCase();
  const pos =
    tokens
      .map((token) => lower.indexOf(token.toLowerCase()))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, pos - Math.floor(maxChars / 3));
  return text
    .slice(start, start + maxChars)
    .replace(/\s+/gu, ' ')
    .trim();
};

const chunkMatches = (chunk: PageContentChunk, tokens: readonly string[]): number => {
  const haystack = `${chunk.title ?? ''} ${chunk.text}`.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += token.length;
  }
  if (score === 0) return 0;
  const qualityBoost = chunk.quality === 'high' ? 1.2 : chunk.quality === 'medium' ? 1 : 0.8;
  return Number((score * qualityBoost).toFixed(6));
};

export const queryPageContent = async (
  vaultRoot: string,
  q: string,
  options: { readonly limit?: number } = {},
): Promise<readonly ContentSearchHit[]> => {
  const tokens = tokenize(q);
  if (tokens.length === 0) return [];
  const records = await readAllRecords(vaultRoot);
  const hits: ContentSearchHit[] = [];
  for (const record of records) {
    const coverage = record.coverage;
    if (
      coverage.contentHash === undefined ||
      (coverage.state !== 'indexed' &&
        coverage.state !== 'indexed_low_quality' &&
        coverage.state !== 'stale_index')
    ) {
      continue;
    }
    const raw = await readJson<{ readonly chunks?: readonly PageContentChunk[] }>(
      join(chunksDir(vaultRoot), `${coverage.contentHash}.json`),
    );
    for (const chunk of raw?.chunks ?? []) {
      const score = chunkMatches(chunk, tokens);
      if (score <= 0) continue;
      hits.push({
        id: chunk.id,
        sourceKind: 'page-content',
        anchorNodeId: `timeline-visit:${coverage.canonicalUrl}`,
        canonicalUrl: coverage.canonicalUrl,
        title: chunk.title ?? record.title ?? coverage.canonicalUrl,
        snippet: snippetFor(chunk.text, tokens),
        score,
        capturedAt: chunk.extractedAt,
        coverageState: coverage.state,
        ...(coverage.quality === undefined ? {} : { quality: coverage.quality }),
      });
    }
  }
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  return hits
    .sort(
      (left, right) => right.score - left.score || right.capturedAt.localeCompare(left.capturedAt),
    )
    .slice(0, limit);
};

export const pageContentStorageStats = async (
  vaultRoot: string,
): Promise<{ readonly bytes: number; readonly records: number; readonly indexed: number }> => {
  const root = pageContentRoot(vaultRoot);
  const walk = async (path: string): Promise<number> => {
    const info = await stat(path).catch(() => null);
    if (info === null) return 0;
    if (!info.isDirectory()) return info.size;
    const names = await readdir(path).catch(() => []);
    const sizes = await Promise.all(names.map((name) => walk(join(path, name))));
    return sizes.reduce((sum, value) => sum + value, 0);
  };
  const records = await readAllRecords(vaultRoot);
  return {
    bytes: await walk(root),
    records: records.length,
    indexed: records.filter((record) => record.coverage.state === 'indexed').length,
  };
};

export interface PageContentCoverageCounts {
  readonly producedAt: string; // ISO
  readonly byState: Record<string /*PageContentCoverageState*/, number>;
  readonly total: number;
  readonly indexed: number; // indexed + indexed_low_quality
  readonly bytes: number; // reuse pageContentStorageStats bytes if cheap
}

export const pageContentCoverageCounts = async (
  vaultRoot: string,
): Promise<PageContentCoverageCounts> => {
  // Explicit zero for every known state: absent states read as 0, not missing.
  const byState: Record<PageContentCoverageState, number> = Object.fromEntries(
    PAGE_CONTENT_COVERAGE_STATES.map((state) => [state, 0]),
  ) as Record<PageContentCoverageState, number>;
  const records = await readAllRecords(vaultRoot);
  for (const record of records) {
    const state = record.coverage.state;
    byState[state] = (byState[state] ?? 0) + 1;
  }
  const stats = await pageContentStorageStats(vaultRoot);
  return {
    producedAt: new Date().toISOString(),
    byState,
    total: records.length,
    indexed: byState.indexed + byState.indexed_low_quality,
    bytes: stats.bytes,
  };
};

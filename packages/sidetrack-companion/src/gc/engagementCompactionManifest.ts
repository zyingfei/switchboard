import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { writeJsonAtomic } from '../vault/atomic.js';

export const ENGAGEMENT_COMPACTION_MANIFEST_VERSION = 1 as const;

const MANIFEST_RELATIVE_PATH = join('_BAC', 'connections', 'engagement-compaction-manifest.json');

export interface CompactedSequenceRange {
  readonly from: number;
  readonly to: number;
}

export interface EngagementCompactionManifestEntry {
  /** `_BAC/log` relative path, never an absolute path. */
  readonly shard: string;
  readonly replicaId: string;
  readonly sourceBytes: number;
  readonly sourceSha256: string;
  readonly compactedBytes: number;
  readonly compactedSha256: string;
  /** Exact contiguous ranges of removed dots. Gaps remain visible. */
  readonly droppedSequenceRanges: readonly CompactedSequenceRange[];
  readonly droppedCount: number;
  readonly maxDroppedAcceptedAtMs: number;
  readonly coveredVisitCount: number;
  readonly preparedAt: string;
  /** Integrity checksum of every field above. */
  readonly receiptSha256: string;
}

export interface EngagementCompactionManifest {
  readonly schemaVersion: typeof ENGAGEMENT_COMPACTION_MANIFEST_VERSION;
  readonly entries: readonly EngagementCompactionManifestEntry[];
}

export type EngagementCompactionManifestRead =
  | { readonly state: 'absent' }
  | { readonly state: 'invalid'; readonly reason: 'io' | 'json' | 'schema' }
  | { readonly state: 'valid'; readonly manifest: EngagementCompactionManifest };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isSha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);

const isSafeShardPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9A-Za-z._-]+\/\d{4}-\d{2}-\d{2}\.jsonl$/u.test(value) &&
  !value.includes('..');

const entryReceiptInput = (
  entry: Omit<EngagementCompactionManifestEntry, 'receiptSha256'>,
): string => JSON.stringify(entry);

export const sha256Text = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

export const sha256File = async (path: string): Promise<string> => {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
};

export const withEngagementCompactionReceipt = (
  entry: Omit<EngagementCompactionManifestEntry, 'receiptSha256'>,
): EngagementCompactionManifestEntry => ({
  ...entry,
  receiptSha256: sha256Text(entryReceiptInput(entry)),
});

const parseRange = (value: unknown): CompactedSequenceRange | null => {
  if (!isRecord(value)) return null;
  const from = value['from'];
  const to = value['to'];
  if (!isNonNegativeInteger(from) || from < 1 || !isNonNegativeInteger(to) || to < from) {
    return null;
  }
  return { from, to };
};

const parseEntry = (value: unknown): EngagementCompactionManifestEntry | null => {
  if (!isRecord(value)) return null;
  const shard = value['shard'];
  const replicaId = value['replicaId'];
  const rawRanges = value['droppedSequenceRanges'];
  if (
    !isSafeShardPath(shard) ||
    typeof replicaId !== 'string' ||
    replicaId.length === 0 ||
    shard.split('/')[0] !== replicaId ||
    !isNonNegativeInteger(value['sourceBytes']) ||
    !isSha256(value['sourceSha256']) ||
    !isNonNegativeInteger(value['compactedBytes']) ||
    !isSha256(value['compactedSha256']) ||
    !Array.isArray(rawRanges) ||
    !isNonNegativeInteger(value['droppedCount']) ||
    !isNonNegativeInteger(value['maxDroppedAcceptedAtMs']) ||
    !isNonNegativeInteger(value['coveredVisitCount']) ||
    typeof value['preparedAt'] !== 'string' ||
    Number.isNaN(Date.parse(value['preparedAt'])) ||
    !isSha256(value['receiptSha256'])
  ) {
    return null;
  }
  const ranges: CompactedSequenceRange[] = [];
  let priorTo = 0;
  let count = 0;
  for (const rawRange of rawRanges) {
    const range = parseRange(rawRange);
    if (range === null || range.from <= priorTo) return null;
    ranges.push(range);
    priorTo = range.to;
    count += range.to - range.from + 1;
  }
  if (count !== value['droppedCount'] || ranges.length === 0) return null;
  const entryWithoutReceipt: Omit<EngagementCompactionManifestEntry, 'receiptSha256'> = {
    shard,
    replicaId,
    sourceBytes: value['sourceBytes'],
    sourceSha256: value['sourceSha256'],
    compactedBytes: value['compactedBytes'],
    compactedSha256: value['compactedSha256'],
    droppedSequenceRanges: ranges,
    droppedCount: value['droppedCount'],
    maxDroppedAcceptedAtMs: value['maxDroppedAcceptedAtMs'],
    coveredVisitCount: value['coveredVisitCount'],
    preparedAt: value['preparedAt'],
  };
  const parsed = withEngagementCompactionReceipt(entryWithoutReceipt);
  return parsed.receiptSha256 === value['receiptSha256'] ? parsed : null;
};

const parseManifest = (value: unknown): EngagementCompactionManifest | null => {
  if (!isRecord(value) || value['schemaVersion'] !== ENGAGEMENT_COMPACTION_MANIFEST_VERSION) {
    return null;
  }
  const rawEntries = value['entries'];
  if (!Array.isArray(rawEntries)) return null;
  const entries: EngagementCompactionManifestEntry[] = [];
  const seen = new Set<string>();
  for (const rawEntry of rawEntries) {
    const entry = parseEntry(rawEntry);
    if (entry === null || seen.has(entry.shard)) return null;
    seen.add(entry.shard);
    entries.push(entry);
  }
  entries.sort((left, right) => left.shard.localeCompare(right.shard));
  return { schemaVersion: ENGAGEMENT_COMPACTION_MANIFEST_VERSION, entries };
};

export const engagementCompactionManifestPath = (vaultRoot: string): string =>
  join(vaultRoot, MANIFEST_RELATIVE_PATH);

export const readEngagementCompactionManifest = async (
  vaultRoot: string,
): Promise<EngagementCompactionManifestRead> => {
  let raw: string;
  try {
    raw = await readFile(engagementCompactionManifestPath(vaultRoot), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { state: 'absent' };
    }
    return { state: 'invalid', reason: 'io' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { state: 'invalid', reason: 'json' };
  }
  const manifest = parseManifest(parsed);
  return manifest === null ? { state: 'invalid', reason: 'schema' } : { state: 'valid', manifest };
};

export const writeEngagementCompactionManifest = async (
  vaultRoot: string,
  entries: readonly EngagementCompactionManifestEntry[],
): Promise<void> => {
  const path = engagementCompactionManifestPath(vaultRoot);
  const manifest: EngagementCompactionManifest = {
    schemaVersion: ENGAGEMENT_COMPACTION_MANIFEST_VERSION,
    entries: [...entries].sort((left, right) => left.shard.localeCompare(right.shard)),
  };
  // Validate our own boundary artifact before exposing it to the event store.
  if (parseManifest(manifest) === null) throw new Error('invalid-compaction-manifest');
  await writeJsonAtomic(path, manifest);
};

export type CompactionShardState = 'source' | 'compacted' | 'mismatch' | 'missing';

export const verifyCompactionShardState = async (
  vaultRoot: string,
  entry: EngagementCompactionManifestEntry,
): Promise<CompactionShardState> => {
  const path = join(vaultRoot, '_BAC', 'log', entry.shard);
  let bytes: number;
  try {
    bytes = (await stat(path)).size;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? 'missing'
      : 'mismatch';
  }
  if (bytes === entry.sourceBytes && (await sha256File(path)) === entry.sourceSha256) {
    return 'source';
  }
  if (bytes === entry.compactedBytes && (await sha256File(path)) === entry.compactedSha256) {
    return 'compacted';
  }
  return 'mismatch';
};

export const sequenceRanges = (sequences: readonly number[]): readonly CompactedSequenceRange[] => {
  const sorted = [...new Set(sequences)].sort((left, right) => left - right);
  const ranges: CompactedSequenceRange[] = [];
  for (const seq of sorted) {
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('invalid-compacted-sequence');
    const prior = ranges[ranges.length - 1];
    if (prior !== undefined && seq === prior.to + 1) {
      ranges[ranges.length - 1] = { from: prior.from, to: seq };
    } else {
      ranges.push({ from: seq, to: seq });
    }
  }
  return ranges;
};

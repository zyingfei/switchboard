// S1 — generation-bound progress checkpoints.
//
// Connections progress advances for events that intentionally do not mutate
// the served graph (engagement intervals, extraction completion, annotations,
// and other content-lane facts). Under the generation-pointer store, writing
// those rows into SQLite used to clone + checkpoint + publish the entire graph
// database every active minute even though every served row was unchanged.
//
// A progress-only acknowledgement now lands in this small atomic sidecar. The
// checkpoint is bound to the exact generation id whose embedded progress it
// extends. A graph publish changes the pointer, so a stale checkpoint becomes
// ineligible automatically; it can never be applied to a different graph.
// The canonical JSONL event log remains the recovery source: a missing, torn,
// invalid, or superseded checkpoint merely causes safe replay.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeJsonAtomic } from '../vault/atomic.js';
import {
  frontierFromIntervals,
  type MaterializerProgress,
} from '../sync/contract/materializerProgress.js';

const CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const PROGRESS_CHECKPOINT_FILENAME = 'progress.checkpoint.json';

export interface GenerationProgressCheckpoint {
  readonly schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  readonly generationId: string;
  readonly recordedAt: string;
  readonly progress: MaterializerProgress;
}

const checkpointPath = (connectionsDir: string): string =>
  join(connectionsDir, PROGRESS_CHECKPOINT_FILENAME);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseIntervals = (value: unknown): MaterializerProgress['appliedDotIntervals'] | null => {
  if (!isRecord(value)) return null;
  const parsed: Record<string, Array<readonly [number, number]>> = {};
  for (const [replicaId, rawIntervals] of Object.entries(value)) {
    if (replicaId.length === 0 || !Array.isArray(rawIntervals)) return null;
    const intervals: Array<readonly [number, number]> = [];
    let previousEnd = 0;
    for (const rawInterval of rawIntervals) {
      if (!Array.isArray(rawInterval) || rawInterval.length !== 2) return null;
      const [start, end] = rawInterval as readonly unknown[];
      if (
        typeof start !== 'number' ||
        typeof end !== 'number' ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 1 ||
        end < start ||
        start <= previousEnd
      ) {
        return null;
      }
      intervals.push([start, end]);
      previousEnd = end;
    }
    parsed[replicaId] = intervals;
  }
  return parsed;
};

const parseFrontier = (value: unknown): MaterializerProgress['appliedFrontier'] | null => {
  if (!isRecord(value)) return null;
  const parsed: Record<string, number> = {};
  for (const [replicaId, seq] of Object.entries(value)) {
    if (
      replicaId.length === 0 ||
      typeof seq !== 'number' ||
      !Number.isSafeInteger(seq) ||
      seq < 1
    ) {
      return null;
    }
    parsed[replicaId] = seq;
  }
  return parsed;
};

const versionVectorsEqual = (
  left: MaterializerProgress['appliedFrontier'],
  right: MaterializerProgress['appliedFrontier'],
): boolean => {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if ((left[key] ?? 0) !== (right[key] ?? 0)) return false;
  }
  return true;
};

const parseProgress = (value: unknown): MaterializerProgress | null => {
  if (!isRecord(value)) return null;
  const materializerName = value['materializerName'];
  const materializerVersion = value['materializerVersion'];
  const snapshotRevisionId = value['snapshotRevisionId'];
  const appliedDotIntervals = parseIntervals(value['appliedDotIntervals']);
  const appliedFrontier = parseFrontier(value['appliedFrontier']);
  if (
    typeof materializerName !== 'string' ||
    materializerName.length === 0 ||
    typeof materializerVersion !== 'string' ||
    materializerVersion.length === 0 ||
    (snapshotRevisionId !== null && typeof snapshotRevisionId !== 'string') ||
    appliedDotIntervals === null ||
    appliedFrontier === null ||
    !versionVectorsEqual(appliedFrontier, frontierFromIntervals(appliedDotIntervals))
  ) {
    return null;
  }
  return {
    materializerName,
    materializerVersion,
    appliedDotIntervals,
    appliedFrontier,
    snapshotRevisionId,
  };
};

export const parseGenerationProgressCheckpoint = (
  value: unknown,
): GenerationProgressCheckpoint | null => {
  if (!isRecord(value) || value['schemaVersion'] !== CHECKPOINT_SCHEMA_VERSION) return null;
  const generationId = value['generationId'];
  const recordedAt = value['recordedAt'];
  const progress = parseProgress(value['progress']);
  if (
    typeof generationId !== 'string' ||
    generationId.length === 0 ||
    generationId.length > 256 ||
    typeof recordedAt !== 'string' ||
    !Number.isFinite(Date.parse(recordedAt)) ||
    progress === null
  ) {
    return null;
  }
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    generationId,
    recordedAt,
    progress,
  };
};

export const readGenerationProgressCheckpoint = async (
  connectionsDir: string,
): Promise<GenerationProgressCheckpoint | null> => {
  try {
    const raw: unknown = JSON.parse(await readFile(checkpointPath(connectionsDir), 'utf8'));
    return parseGenerationProgressCheckpoint(raw);
  } catch {
    return null;
  }
};

export const writeGenerationProgressCheckpoint = async (
  connectionsDir: string,
  generationId: string,
  progress: MaterializerProgress,
  now: Date = new Date(),
): Promise<void> => {
  const checkpoint: GenerationProgressCheckpoint = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    generationId,
    recordedAt: now.toISOString(),
    progress,
  };
  await writeJsonAtomic(checkpointPath(connectionsDir), checkpoint);
};

const normalizeIntervals = (
  intervals: MaterializerProgress['appliedDotIntervals'],
): MaterializerProgress['appliedDotIntervals'] => {
  const normalized: Record<string, Array<readonly [number, number]>> = {};
  for (const [replicaId, ranges] of Object.entries(intervals).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const sorted = [...ranges].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    const merged: Array<readonly [number, number]> = [];
    for (const [start, end] of sorted) {
      const previous = merged[merged.length - 1];
      if (previous === undefined || start > previous[1] + 1) {
        merged.push([start, end]);
      } else {
        merged[merged.length - 1] = [previous[0], Math.max(previous[1], end)];
      }
    }
    normalized[replicaId] = merged;
  }
  return normalized;
};

export const mergeMaterializerProgress = (
  base: MaterializerProgress,
  incoming: MaterializerProgress,
  snapshotRevisionId: string | null,
): MaterializerProgress | null => {
  if (
    base.materializerName !== incoming.materializerName ||
    base.materializerVersion !== incoming.materializerVersion
  ) {
    return null;
  }
  const allIntervals: Record<string, Array<readonly [number, number]>> = {};
  const replicaIds = new Set([
    ...Object.keys(base.appliedDotIntervals),
    ...Object.keys(incoming.appliedDotIntervals),
  ]);
  for (const replicaId of replicaIds) {
    allIntervals[replicaId] = [
      ...(base.appliedDotIntervals[replicaId] ?? []),
      ...(incoming.appliedDotIntervals[replicaId] ?? []),
    ];
  }
  const appliedDotIntervals = normalizeIntervals(allIntervals);
  return {
    materializerName: base.materializerName,
    materializerVersion: base.materializerVersion,
    appliedDotIntervals,
    appliedFrontier: frontierFromIntervals(appliedDotIntervals),
    snapshotRevisionId,
  };
};

const intervalsCover = (
  candidate: MaterializerProgress['appliedDotIntervals'],
  base: MaterializerProgress['appliedDotIntervals'],
): boolean => {
  for (const [replicaId, baseRanges] of Object.entries(base)) {
    const candidateRanges = candidate[replicaId] ?? [];
    for (const [baseStart, baseEnd] of baseRanges) {
      if (!candidateRanges.some(([start, end]) => start <= baseStart && end >= baseEnd)) {
        return false;
      }
    }
  }
  return true;
};

/**
 * Return the checkpoint progress only when it is a monotonic extension of the
 * progress embedded in this exact served generation. Every failed predicate is
 * a safe fallback to `embedded` at the caller; absence never becomes emptiness.
 */
export const progressFromCheckpoint = (input: {
  readonly checkpoint: GenerationProgressCheckpoint | null;
  readonly generationId: string;
  readonly snapshotRevisionId: string | null;
  readonly embedded: MaterializerProgress;
}): MaterializerProgress | null => {
  const checkpoint = input.checkpoint;
  if (
    checkpoint === null ||
    checkpoint.generationId !== input.generationId ||
    checkpoint.progress.materializerName !== input.embedded.materializerName ||
    checkpoint.progress.materializerVersion !== input.embedded.materializerVersion ||
    checkpoint.progress.snapshotRevisionId !== input.snapshotRevisionId ||
    !intervalsCover(checkpoint.progress.appliedDotIntervals, input.embedded.appliedDotIntervals)
  ) {
    return null;
  }
  return checkpoint.progress;
};

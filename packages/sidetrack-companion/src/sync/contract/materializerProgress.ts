import type { Dot, ReplicaId, VersionVector } from '../causal.js';

export interface MaterializerProgress {
  readonly materializerName: string;
  readonly materializerVersion: string;
  readonly appliedDotIntervals: Record<ReplicaId, ReadonlyArray<readonly [number, number]>>;
  readonly appliedFrontier: VersionVector;
  readonly snapshotRevisionId: string | null;
}

export const EMPTY_PROGRESS = (name: string, version: string): MaterializerProgress => ({
  materializerName: name,
  materializerVersion: version,
  appliedDotIntervals: {},
  appliedFrontier: {},
  snapshotRevisionId: null,
});

export const intervalsContainDot = (
  intervals: MaterializerProgress['appliedDotIntervals'],
  dot: Dot,
): boolean => {
  const replicaIntervals = intervals[dot.replicaId] ?? [];
  let lo = 0;
  let hi = replicaIntervals.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const interval = replicaIntervals[mid];
    if (interval === undefined) return false;
    const [start, end] = interval;
    if (dot.seq < start) {
      hi = mid - 1;
    } else if (dot.seq > end) {
      lo = mid + 1;
    } else {
      return true;
    }
  }
  return false;
};

export const addDotsToIntervals = (
  intervals: MaterializerProgress['appliedDotIntervals'],
  dots: readonly Dot[],
): MaterializerProgress['appliedDotIntervals'] => {
  const byReplica = new Map<ReplicaId, Array<readonly [number, number]>>();
  for (const [replicaId, replicaIntervals] of Object.entries(intervals)) {
    byReplica.set(
      replicaId,
      replicaIntervals.map(([start, end]) => [start, end] as const),
    );
  }

  for (const dot of dots) {
    const replicaIntervals = byReplica.get(dot.replicaId) ?? [];
    replicaIntervals.push([dot.seq, dot.seq]);
    byReplica.set(dot.replicaId, replicaIntervals);
  }

  const out: Record<ReplicaId, ReadonlyArray<readonly [number, number]>> = {};
  for (const [replicaId, replicaIntervals] of [...byReplica.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const sorted = [...replicaIntervals].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: Array<readonly [number, number]> = [];
    for (const [start, end] of sorted) {
      const previous = merged[merged.length - 1];
      if (previous === undefined || start > previous[1] + 1) {
        merged.push([start, end]);
        continue;
      }
      merged[merged.length - 1] = [previous[0], Math.max(previous[1], end)];
    }
    out[replicaId] = merged;
  }
  return out;
};

export const frontierFromIntervals = (
  intervals: MaterializerProgress['appliedDotIntervals'],
): VersionVector => {
  const out: Record<ReplicaId, number> = {};
  for (const [replicaId, replicaIntervals] of Object.entries(intervals)) {
    let max = 0;
    for (const [, end] of replicaIntervals) {
      if (end > max) max = end;
    }
    if (max > 0) out[replicaId] = max;
  }
  return out;
};

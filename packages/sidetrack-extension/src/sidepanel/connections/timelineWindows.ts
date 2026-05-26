import { isInternalIdLike } from '../entityDisplay/format';
import type { TimeRangeValue } from './TimeRangePicker';
import { timeRangeWindowFor, type TimeRangeWindow } from './TimeRangePicker';
import type { ConnectionsSnapshot } from './types';

// Derive a range-aware TimelineRail data structure from a connections
// snapshot.
//
// The rail shows plugin observation presence, not time tracking. It
// uses event-log producer timestamps when available, then falls back
// to node timestamps for inferred-only subgraphs. The selected Window
// control supplies the scale for 1h / 24h / 7d / 30d / Custom. "All"
// uses the actual min..max observed activity span so sparse, multi-day
// snapshots do not get flattened into an arbitrary 24h day.

const BASE_WINDOW_GAP_MS = 30 * 60 * 1000;
const MIN_VISIBLE_WINDOW_MS = 6 * 60 * 1000;

export interface ReplicaWindowRow {
  readonly replicaId: string;
  readonly windows: readonly (readonly [number, number])[]; // epoch-ms pairs within the rail range
}

export interface TimelineMarker {
  readonly id: string;
  readonly nodeId: string;
  readonly timeMs: number;
  readonly kind: 'anchor' | 'related';
  readonly label: string;
}

export interface TimelineTick {
  readonly label: string;
  readonly ms: number;
}

export interface TimelineRailData {
  readonly date: string;
  readonly rangeLabel: string;
  readonly scaleLabel: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly ticks: readonly TimelineTick[];
  readonly rows: readonly ReplicaWindowRow[];
  readonly anchorTime: number | null;
  readonly neighborTimes: readonly number[];
  readonly markers: readonly TimelineMarker[];
}

const parseTimestamp = (s: string | undefined): number | null => {
  if (typeof s !== 'string' || s.length === 0) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
};

const startOfLocalDay = (ms: number): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
};

const isoDayLocal = (ms: number): string => {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${String(y)}-${m}-${day}`;
};

const dateLabel = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

const timeLabel = (ms: number): string =>
  new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

const compactDateTimeLabel = (ms: number): string => `${dateLabel(ms)}, ${timeLabel(ms)}`;

const labelForNode = (node: ConnectionsSnapshot['nodes'][number]): string => {
  // Filter id-like values at every fallback step — marker labels feed
  // straight into TimelineRail's visible title/aria-label.
  if (node.label.length > 0 && !isInternalIdLike(node.label)) return node.label;
  const title = node.metadata['title'];
  if (typeof title === 'string' && title.length > 0 && !isInternalIdLike(title)) {
    return title;
  }
  const canonicalUrl = node.metadata['canonicalUrl'];
  if (typeof canonicalUrl === 'string' && canonicalUrl.length > 0) return canonicalUrl;
  const latestUrl = node.metadata['latestUrl'];
  if (typeof latestUrl === 'string' && latestUrl.length > 0) return latestUrl;
  return '(node)';
};

const rangeLabel = (startMs: number, endMs: number): string => {
  if (isoDayLocal(startMs) === isoDayLocal(endMs)) {
    return `${dateLabel(startMs)} · ${timeLabel(startMs)}-${timeLabel(endMs)}`;
  }
  return `${compactDateTimeLabel(startMs)} - ${compactDateTimeLabel(endMs)}`;
};

const scaleLabelForSpan = (spanMs: number): string => {
  if (spanMs <= 2 * 60 * 60 * 1000) return 'minutes';
  if (spanMs <= 36 * 60 * 60 * 1000) return 'hours';
  if (spanMs <= 45 * 24 * 60 * 60 * 1000) return 'days';
  return 'months';
};

const tickLabelForSpan = (ms: number, spanMs: number): string => {
  if (spanMs <= 36 * 60 * 60 * 1000) return timeLabel(ms);
  return dateLabel(ms);
};

const buildTicks = (startMs: number, endMs: number): readonly TimelineTick[] => {
  const span = Math.max(1, endMs - startMs);
  const tickCount = span <= 2 * 60 * 60 * 1000 ? 5 : 6;
  const out: TimelineTick[] = [];
  for (let i = 0; i < tickCount; i += 1) {
    const ms = startMs + (span * i) / (tickCount - 1);
    out.push({ label: tickLabelForSpan(ms, span), ms });
  }
  return out;
};

const normalizeRange = (
  window: TimeRangeWindow | null,
  timestamps: readonly number[],
): TimeRangeWindow => {
  if (window !== null) return window;
  const sorted = [...timestamps].sort((a, b) => a - b);
  const first = sorted[0] ?? Date.now();
  const last = sorted[sorted.length - 1] ?? first;
  if (last > first) return { startMs: first, endMs: last };
  const dayStart = startOfLocalDay(first);
  return { startMs: dayStart, endMs: dayStart + 24 * 60 * 60 * 1000 };
};

const windowGapForSpan = (spanMs: number): number =>
  Math.max(BASE_WINDOW_GAP_MS, Math.min(12 * 60 * 60 * 1000, spanMs / 96));

const floorWindow = (
  startMs: number,
  endMs: number,
  rangeStartMs: number,
  rangeEndMs: number,
): readonly [number, number] => {
  if (endMs - startMs >= MIN_VISIBLE_WINDOW_MS) return [startMs, endMs] as const;
  const forwardEnd = Math.min(rangeEndMs, startMs + MIN_VISIBLE_WINDOW_MS);
  if (forwardEnd > startMs) return [startMs, forwardEnd] as const;
  return [Math.max(rangeStartMs, endMs - MIN_VISIBLE_WINDOW_MS), endMs] as const;
};

interface TimestampPool {
  readonly timestampsByReplica: Map<string, number[]>;
  readonly allTimestamps: readonly number[];
}

const collectEventTimestamps = (snapshot: ConnectionsSnapshot): TimestampPool => {
  const timestampsByReplica = new Map<string, number[]>();
  const allTimestamps: number[] = [];
  for (const edge of snapshot.edges) {
    const dot = edge.producedBy.dot;
    if (dot === undefined) continue;
    const ms = parseTimestamp(edge.observedAt);
    if (ms === null) continue;
    const list = timestampsByReplica.get(dot.replicaId);
    if (list === undefined) timestampsByReplica.set(dot.replicaId, [ms]);
    else list.push(ms);
    allTimestamps.push(ms);
  }
  return { timestampsByReplica, allTimestamps };
};

const collectNodeFallbackTimestamps = (snapshot: ConnectionsSnapshot): TimestampPool => {
  const timestampsByReplica = new Map<string, number[]>();
  const allTimestamps: number[] = [];
  for (const node of snapshot.nodes) {
    const ms = parseTimestamp(node.lastSeenAt) ?? parseTimestamp(node.firstSeenAt);
    if (ms === null) continue;
    const replicaIds = node.originReplicaIds.length > 0 ? node.originReplicaIds : ['unknown'];
    for (const replicaId of replicaIds) {
      const list = timestampsByReplica.get(replicaId);
      if (list === undefined) timestampsByReplica.set(replicaId, [ms]);
      else list.push(ms);
    }
    allTimestamps.push(ms);
  }
  return { timestampsByReplica, allTimestamps };
};

const hasTimestampInRange = (
  timestampsByReplica: ReadonlyMap<string, readonly number[]>,
  startMs: number,
  endMs: number,
): boolean => {
  for (const values of timestampsByReplica.values()) {
    if (values.some((ms) => ms >= startMs && ms <= endMs)) return true;
  }
  return false;
};

export const computeTimelineRail = (
  snapshot: ConnectionsSnapshot,
  anchorNodeId: string,
  options: { readonly range?: TimeRangeValue; readonly nowMs?: number } = {},
): TimelineRailData | null => {
  let pool = collectEventTimestamps(snapshot);
  if (pool.allTimestamps.length === 0) {
    pool = collectNodeFallbackTimestamps(snapshot);
  }
  if (pool.allTimestamps.length === 0) return null;

  const selectedWindow =
    options.range === undefined
      ? null
      : timeRangeWindowFor(options.range, options.nowMs ?? Date.now());
  const { startMs, endMs } = normalizeRange(selectedWindow, pool.allTimestamps);
  if (endMs <= startMs) return null;
  if (!hasTimestampInRange(pool.timestampsByReplica, startMs, endMs)) return null;

  const spanMs = endMs - startMs;
  const gapMs = windowGapForSpan(spanMs);
  const rows: ReplicaWindowRow[] = [];
  for (const replicaId of [...pool.timestampsByReplica.keys()].sort()) {
    const tsForRange = (pool.timestampsByReplica.get(replicaId) ?? [])
      .filter((ms) => ms >= startMs && ms <= endMs)
      .sort((a, b) => a - b);
    if (tsForRange.length === 0) continue;
    const windows: (readonly [number, number])[] = [];
    let runStart = tsForRange[0]!;
    let runEnd = tsForRange[0]!;
    for (let i = 1; i < tsForRange.length; i += 1) {
      const t = tsForRange[i]!;
      if (t - runEnd <= gapMs) {
        runEnd = t;
      } else {
        windows.push([runStart, runEnd]);
        runStart = t;
        runEnd = t;
      }
    }
    windows.push([runStart, runEnd]);
    rows.push({
      replicaId,
      windows: windows.map(([a, b]) => floorWindow(a, b, startMs, endMs)),
    });
  }

  const anchorNode = snapshot.nodes.find((n) => n.id === anchorNodeId);
  const anchorMs = parseTimestamp(anchorNode?.lastSeenAt);
  const anchorTime =
    anchorMs !== null && anchorMs >= startMs && anchorMs <= endMs ? anchorMs : null;

  const markers: TimelineMarker[] = [];
  if (anchorNode !== undefined && anchorTime !== null) {
    markers.push({
      id: `anchor:${anchorNode.id}`,
      nodeId: anchorNode.id,
      timeMs: anchorTime,
      kind: 'anchor',
      label: labelForNode(anchorNode),
    });
  }

  const neighborSet = new Set<number>();
  for (const node of snapshot.nodes) {
    if (node.id === anchorNodeId) continue;
    const ms = parseTimestamp(node.lastSeenAt);
    if (ms === null) continue;
    if (ms < startMs || ms > endMs) continue;
    neighborSet.add(ms);
    markers.push({
      id: `related:${node.id}:${String(ms)}`,
      nodeId: node.id,
      timeMs: ms,
      kind: 'related',
      label: labelForNode(node),
    });
  }
  const neighborTimes = [...neighborSet].sort((a, b) => a - b);

  return {
    date:
      isoDayLocal(startMs) === isoDayLocal(endMs)
        ? isoDayLocal(startMs)
        : `${isoDayLocal(startMs)}-${isoDayLocal(endMs)}`,
    rangeLabel: rangeLabel(startMs, endMs),
    scaleLabel: scaleLabelForSpan(spanMs),
    startMs,
    endMs,
    ticks: buildTicks(startMs, endMs),
    rows,
    anchorTime,
    neighborTimes,
    markers: markers.sort((a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id)),
  };
};

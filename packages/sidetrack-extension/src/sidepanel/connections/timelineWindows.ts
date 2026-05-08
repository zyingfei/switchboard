import type { ConnectionsSnapshot } from './types';

// Derive a TimelineRail data structure from a connections snapshot.
//
// The companion doesn't expose per-device "active hours" directly,
// but every event-log edge carries `producedBy.dot.replicaId` plus
// `observedAt`, which is enough to reconstruct observation windows
// on the panel side.
//
// Algorithm:
//   1. For each replicaId we see in any edge.producedBy.dot, collect
//      the set of observedAt timestamps.
//   2. Pick the most populated UTC day across all timestamps as the
//      "shown day" — TimelineRail is a 24h view; multi-day snapshots
//      collapse to the day with the most activity.
//   3. Within the shown day, cluster each replica's timestamps into
//      windows (gap > 30min → new window). Convert each window's
//      start/end into 24h decimal hours (UTC).
//   4. Resolve anchor + neighbor markers: anchor's lastSeenAt and
//      every other node's lastSeenAt that falls within the shown day.
//
// Pure function — same input → same output.

const WINDOW_GAP_MS = 30 * 60 * 1000; // 30 min split between windows

export interface ReplicaWindowRow {
  readonly replicaId: string;
  readonly windows: readonly (readonly [number, number])[]; // 24h decimal pairs
}

export interface TimelineRailData {
  // ISO date YYYY-MM-DD this rail represents (UTC). When the snapshot
  // has no observable event-log timestamps we return null and the
  // caller hides the rail.
  readonly date: string;
  readonly rows: readonly ReplicaWindowRow[];
  // Decimal-hour anchor + neighbor markers. Empty when the anchor
  // doesn't have a usable lastSeenAt within the shown day.
  readonly anchorTime: number | null;
  readonly neighborTimes: readonly number[];
}

const decimalHourUtc = (ms: number): number => {
  const d = new Date(ms);
  return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
};

const isoDayUtc = (ms: number): string => {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${String(y)}-${m}-${day}`;
};

const parseTimestamp = (s: string | undefined): number | null => {
  if (typeof s !== 'string' || s.length === 0) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
};

export const computeTimelineRail = (
  snapshot: ConnectionsSnapshot,
  anchorNodeId: string,
): TimelineRailData | null => {
  // Collect all (replicaId, ms) pairs from event-log edges.
  const timestampsByReplica = new Map<string, number[]>();
  // Tally a histogram of UTC days from edges to pick the busiest day.
  const dayCounts = new Map<string, number>();

  for (const edge of snapshot.edges) {
    const dot = edge.producedBy.dot;
    if (dot === undefined) continue;
    const ms = parseTimestamp(edge.observedAt);
    if (ms === null) continue;
    const list = timestampsByReplica.get(dot.replicaId);
    if (list === undefined) timestampsByReplica.set(dot.replicaId, [ms]);
    else list.push(ms);
    const day = isoDayUtc(ms);
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
  }

  if (dayCounts.size === 0) return null;

  // Pick the busiest day. Tie-break: latest day wins so the rail
  // shows the most recent burst of activity.
  let bestDay = '';
  let bestCount = -1;
  for (const [day, count] of dayCounts) {
    if (count > bestCount || (count === bestCount && day > bestDay)) {
      bestDay = day;
      bestCount = count;
    }
  }

  // Day window: [00:00 UTC, 24:00 UTC].
  const dayStart = Date.parse(`${bestDay}T00:00:00.000Z`);
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;

  const rows: ReplicaWindowRow[] = [];
  // Sort replica ids for determinism.
  const sortedReplicas = [...timestampsByReplica.keys()].sort();
  for (const replicaId of sortedReplicas) {
    const tsForDay = (timestampsByReplica.get(replicaId) ?? [])
      .filter((ms) => ms >= dayStart && ms < dayEnd)
      .sort((a, b) => a - b);
    if (tsForDay.length === 0) continue;
    // Cluster into windows; each window stretches from min(ts) to
    // max(ts) for its cluster, with a small floor so a single point
    // is still visible.
    const windows: (readonly [number, number])[] = [];
    let runStart = tsForDay[0]!;
    let runEnd = tsForDay[0]!;
    for (let i = 1; i < tsForDay.length; i += 1) {
      const t = tsForDay[i]!;
      if (t - runEnd <= WINDOW_GAP_MS) {
        runEnd = t;
      } else {
        windows.push([decimalHourUtc(runStart), decimalHourUtc(runEnd)]);
        runStart = t;
        runEnd = t;
      }
    }
    windows.push([decimalHourUtc(runStart), decimalHourUtc(runEnd)]);
    // Floor window width: at least 6 minutes (0.1h) so single-point
    // observations stay clickable / visible.
    const floored: (readonly [number, number])[] = windows.map(([a, b]) => {
      if (b - a < 0.1) return [a, Math.min(24, a + 0.1)] as const;
      return [a, b] as const;
    });
    rows.push({ replicaId, windows: floored });
  }

  // Anchor marker — anchor node's lastSeenAt within the day.
  const anchorNode = snapshot.nodes.find((n) => n.id === anchorNodeId);
  const anchorMs = parseTimestamp(anchorNode?.lastSeenAt);
  const anchorTime =
    anchorMs !== null && anchorMs >= dayStart && anchorMs < dayEnd
      ? decimalHourUtc(anchorMs)
      : null;

  // Neighbor markers — every non-anchor node's lastSeenAt within
  // the day. Dedup + sort.
  const neighborSet = new Set<number>();
  for (const node of snapshot.nodes) {
    if (node.id === anchorNodeId) continue;
    const ms = parseTimestamp(node.lastSeenAt);
    if (ms === null) continue;
    if (ms < dayStart || ms >= dayEnd) continue;
    neighborSet.add(decimalHourUtc(ms));
  }
  const neighborTimes = [...neighborSet].sort((a, b) => a - b);

  return { date: bestDay, rows, anchorTime, neighborTimes };
};

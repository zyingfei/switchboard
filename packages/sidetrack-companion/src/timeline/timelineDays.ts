import { BROWSER_TIMELINE_OBSERVED, isBrowserTimelineObservedPayload } from './events.js';
import {
  buildDayProjection,
  collectTimelinePayloads,
  entryIdFor,
  groupByDay,
  type TimelineDayProjection,
} from './projection.js';
import type { AcceptedEvent } from '../sync/causal.js';

export type TimelineEntryWithDimensions = TimelineDayProjection['entries'][number] & {
  readonly dimensions?: unknown;
};

export type TimelineDayProjectionWithDimensions = Omit<TimelineDayProjection, 'entries'> & {
  readonly entries: readonly TimelineEntryWithDimensions[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const focusedWindowMsFromPayload = (payload: {
  readonly dimensions?: Record<string, unknown>;
}): number | undefined => {
  if (!isRecord(payload.dimensions)) return undefined;
  const engagement = payload.dimensions['engagement'];
  if (!isRecord(engagement)) return undefined;
  const focused = engagement['focusedWindowMs'];
  if (typeof focused !== 'number' || !Number.isFinite(focused) || focused < 0) {
    return undefined;
  }
  return focused;
};

// Byte-equivalent seam for Connections' timeline-day projection. The
// fact store reconstructs minimal AcceptedEvents, then calls this same
// function so the SQLite and legacy paths share the projection math.
export const timelineDaysFromTimelineEvents = (
  timelineEvents: readonly AcceptedEvent[],
): readonly TimelineDayProjectionWithDimensions[] => {
  const payloads = collectTimelinePayloads(timelineEvents);
  const grouped = groupByDay(payloads);
  const out: TimelineDayProjectionWithDimensions[] = [];
  for (const [date, dayPayloads] of grouped) {
    const focusedByEntryId = new Map<string, number>();
    for (const payload of dayPayloads) {
      const focusedWindowMs = focusedWindowMsFromPayload(payload);
      if (focusedWindowMs === undefined) continue;
      const entryId = entryIdFor(payload);
      focusedByEntryId.set(entryId, Math.max(focusedByEntryId.get(entryId) ?? 0, focusedWindowMs));
    }
    const projection = buildDayProjection(date, dayPayloads);
    const entries: TimelineEntryWithDimensions[] = projection.entries.map((entry) => {
      const focusedWindowMs = focusedByEntryId.get(entry.id);
      if (focusedWindowMs === undefined) return entry;
      return {
        ...entry,
        dimensions: { engagement: { focusedWindowMs } },
      };
    });
    out.push({ ...projection, entries });
  }
  return out;
};

// Pure, sqlite-free twin for tests and drift/replay: accepts the full
// merged log and applies the same filter Connections used historically.
export const timelineDaysFromEvents = (
  events: readonly AcceptedEvent[],
): readonly TimelineDayProjectionWithDimensions[] =>
  timelineDaysFromTimelineEvents(
    events.filter(
      (event) =>
        event.type === BROWSER_TIMELINE_OBSERVED && isBrowserTimelineObservedPayload(event.payload),
    ),
  );

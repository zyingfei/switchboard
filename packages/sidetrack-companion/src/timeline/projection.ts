import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createRevision } from '../domain/ids.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type {
  BrowserTimelineObservedPayload,
  TimelineProvider,
  TimelineTransition,
} from './events.js';
import {
  BROWSER_TIMELINE_OBSERVED,
  isBrowserTimelineObservedPayload,
} from './events.js';

// Sync Contract v1 — timeline projection.
//
// Class B derived cache. The projection is a deterministic reduction
// of `browser.timeline.observed` events into daily-bucketed
// `_BAC/timeline/projections/<YYYY-MM-DD>.json` files.
//
// Reduction rules (from docs/timeline.md):
//   - Group events within a UTC day by canonicalUrl (or raw url if
//     canonicalUrl is missing).
//   - firstSeenAt = min(observedAt across the group).
//   - lastSeenAt  = max(observedAt across the group).
//   - visitCount  = count of `activated` + `updated` transitions
//                   (closed/completed update lastSeenAt only).
//   - title/provider take the most recent non-empty value.
//   - sort entries within a day by lastSeenAt desc.
//
// The projection is callback-independent: the materializer can
// always reconstruct the on-disk projection by replaying the merged
// event log through `reduceTimelineEvents`. Crashes between event
// accept and projection write recover via `catchUp`.

export interface TimelineEntry {
  readonly id: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly url: string;
  readonly canonicalUrl?: string;
  readonly title?: string;
  readonly provider?: TimelineProvider;
  readonly visitCount: number;
  // Stable tab-session identity. Last-write-wins by observedAt so a
  // URL revisited in a new tab-session rebinds to that session in the
  // daily projection. Existing rows without tabSessionId remain
  // unattributed until Phase 2 adds explicit attribution.
  readonly tabSessionId?: string;
  readonly openerTabSessionId?: string;
  // Legacy active-pointer field retained for old projections only.
  // Phase 1 stops new extension observations from setting this and
  // Connections no longer uses it for visit attribution.
  readonly workstreamId?: string;
}

export interface TimelineDayProjection {
  readonly date: string; // YYYY-MM-DD (UTC)
  readonly entries: readonly TimelineEntry[];
  readonly updatedAt: string;
  readonly entryCount: number;
}

const TRANSITIONS_INCREMENTING_VISIT_COUNT: ReadonlySet<TimelineTransition> = new Set<TimelineTransition>([
  'activated',
  'updated',
]);

// Day bucket for a payload. UTC; format YYYY-MM-DD. Anchors the
// projection file path AND the aggregateId for the registry entry.
//
// Reviewer-flagged: validate the prefix strictly. The previous
// loose check (length>=10 && '-' at positions 4 and 7) accepted
// inputs like "abcd-fg-ij..." and produced synthetic "days." A
// proper \d{4}-\d{2}-\d{2} regex tightens the input domain so a
// malformed `observedAt` falls back to the epoch bucket rather than
// creating arbitrarily-named projection files.
const DAY_PREFIX_RE = /^(\d{4})-(\d{2})-(\d{2})/u;

export const dayBucketFor = (observedAt: string): string => {
  const match = DAY_PREFIX_RE.exec(observedAt);
  if (match === null) return '1970-01-01';
  // Sanity-check the month/day ranges so 2026-13-99 doesn't
  // become a "valid" bucket. Year 0 is technically possible but
  // not worth special-casing.
  const month = Number.parseInt(match[2] ?? '0', 10);
  const day = Number.parseInt(match[3] ?? '0', 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '1970-01-01';
  return observedAt.slice(0, 10);
};

// Stable per-day entry id derived from the canonicalUrl (or url if
// no canonicalUrl). Used to key the daily projection so distinct
// pages within a day stay distinct.
export const entryIdFor = (input: { canonicalUrl?: string; url: string }): string => {
  // Strip fragment + trailing slash to fold trivial variants.
  const raw = input.canonicalUrl ?? input.url;
  return raw.replace(/#.*$/u, '').replace(/\/+$/u, '');
};

// Pure reduction: turn a list of `BrowserTimelineObservedPayload`
// (sorted or unsorted; reducer is order-independent) into a list of
// TimelineEntry rows. Used by both the materializer (to produce
// daily projection files) and tests (to assert determinism).
export const reduceTimelineEvents = (
  events: readonly BrowserTimelineObservedPayload[],
): readonly TimelineEntry[] => {
  const byEntry = new Map<string, {
    firstSeenAt: string;
    lastSeenAt: string;
    url: string;
    canonicalUrl?: string;
    title?: string;
    provider?: TimelineProvider;
    visitCount: number;
    titleObservedAt?: string;
    providerObservedAt?: string;
    tabSessionId?: string;
    openerTabSessionId?: string;
    tabSessionObservedAt?: string;
    workstreamId?: string;
    workstreamObservedAt?: string;
  }>();
  for (const event of events) {
    const id = entryIdFor(event);
    const incrementsVisit = TRANSITIONS_INCREMENTING_VISIT_COUNT.has(event.transition);
    const existing = byEntry.get(id);
    if (existing === undefined) {
      byEntry.set(id, {
        firstSeenAt: event.observedAt,
        lastSeenAt: event.observedAt,
        url: event.url,
        ...(event.canonicalUrl === undefined ? {} : { canonicalUrl: event.canonicalUrl }),
        ...(event.title === undefined || event.title.length === 0
          ? {}
          : { title: event.title, titleObservedAt: event.observedAt }),
        ...(event.provider === undefined
          ? {}
          : { provider: event.provider, providerObservedAt: event.observedAt }),
        ...(event.tabSessionId === undefined
          ? {}
          : {
              tabSessionId: event.tabSessionId,
              ...(event.openerTabSessionId === undefined
                ? {}
                : { openerTabSessionId: event.openerTabSessionId }),
              tabSessionObservedAt: event.observedAt,
            }),
        ...(event.workstreamId === undefined
          ? {}
          : { workstreamId: event.workstreamId, workstreamObservedAt: event.observedAt }),
        visitCount: incrementsVisit ? 1 : 0,
      });
      continue;
    }
    if (event.observedAt < existing.firstSeenAt) existing.firstSeenAt = event.observedAt;
    if (event.observedAt > existing.lastSeenAt) existing.lastSeenAt = event.observedAt;
    // Most recent non-empty title/provider wins.
    if (event.title !== undefined && event.title.length > 0) {
      if (existing.titleObservedAt === undefined || event.observedAt >= existing.titleObservedAt) {
        existing.title = event.title;
        existing.titleObservedAt = event.observedAt;
      }
    }
    if (event.provider !== undefined) {
      if (existing.providerObservedAt === undefined || event.observedAt >= existing.providerObservedAt) {
        existing.provider = event.provider;
        existing.providerObservedAt = event.observedAt;
      }
    }
    // tabSessionId: last-write-wins. This keeps the projection
    // deterministic while letting Phase 1 distinguish a revisited URL
    // that moved to a new tab-session boundary.
    if (event.tabSessionId !== undefined && event.tabSessionId.length > 0) {
      if (
        existing.tabSessionObservedAt === undefined ||
        event.observedAt >= existing.tabSessionObservedAt
      ) {
        existing.tabSessionId = event.tabSessionId;
        existing.tabSessionObservedAt = event.observedAt;
        if (event.openerTabSessionId === undefined) {
          delete existing.openerTabSessionId;
        } else {
          existing.openerTabSessionId = event.openerTabSessionId;
        }
      }
    }
    // workstreamId: last-write-wins. Tracks "what flow was the user
    // in when they observed this URL". A URL revisited under a
    // different workstream rebinds.
    if (event.workstreamId !== undefined && event.workstreamId.length > 0) {
      if (
        existing.workstreamObservedAt === undefined ||
        event.observedAt >= existing.workstreamObservedAt
      ) {
        existing.workstreamId = event.workstreamId;
        existing.workstreamObservedAt = event.observedAt;
      }
    }
    if (incrementsVisit) existing.visitCount += 1;
    byEntry.set(id, existing);
  }
  const rows: TimelineEntry[] = [];
  for (const [id, agg] of byEntry) {
    rows.push({
      id,
      firstSeenAt: agg.firstSeenAt,
      lastSeenAt: agg.lastSeenAt,
      url: agg.url,
      ...(agg.canonicalUrl === undefined ? {} : { canonicalUrl: agg.canonicalUrl }),
      ...(agg.title === undefined ? {} : { title: agg.title }),
      ...(agg.provider === undefined ? {} : { provider: agg.provider }),
      ...(agg.tabSessionId === undefined ? {} : { tabSessionId: agg.tabSessionId }),
      ...(agg.openerTabSessionId === undefined
        ? {}
        : { openerTabSessionId: agg.openerTabSessionId }),
      ...(agg.workstreamId === undefined ? {} : { workstreamId: agg.workstreamId }),
      visitCount: agg.visitCount,
    });
  }
  // Deterministic order: lastSeenAt desc, then id asc as tie-break.
  rows.sort((a, b) => {
    if (a.lastSeenAt !== b.lastSeenAt) return a.lastSeenAt < b.lastSeenAt ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return rows;
};

// Filter accepted events to the timeline payloads. Keeps the
// materializer + reducer free of the AcceptedEvent envelope.
export const collectTimelinePayloads = (
  events: readonly AcceptedEvent[],
): readonly BrowserTimelineObservedPayload[] => {
  const payloads: BrowserTimelineObservedPayload[] = [];
  for (const event of events) {
    if (event.type !== BROWSER_TIMELINE_OBSERVED) continue;
    if (!isBrowserTimelineObservedPayload(event.payload)) continue;
    payloads.push(event.payload);
  }
  return payloads;
};

// Group payloads by day bucket. Used by both the materializer (writes
// one file per touched day) and HTTP query (range filter).
export const groupByDay = (
  payloads: readonly BrowserTimelineObservedPayload[],
): ReadonlyMap<string, readonly BrowserTimelineObservedPayload[]> => {
  const out = new Map<string, BrowserTimelineObservedPayload[]>();
  for (const p of payloads) {
    const day = dayBucketFor(p.observedAt);
    const list = out.get(day) ?? [];
    list.push(p);
    out.set(day, list);
  }
  return out;
};

// On-disk projection store. One file per day:
//   _BAC/timeline/projections/YYYY-MM-DD.json

export interface TimelineStore {
  readonly putDay: (day: TimelineDayProjection) => Promise<void>;
  readonly readDay: (date: string) => Promise<TimelineDayProjection | null>;
  readonly listDays: () => Promise<readonly string[]>;
}

const PROJECTIONS_DIR = 'projections';

export const createTimelineStore = (vaultRoot: string): TimelineStore => {
  const root = join(vaultRoot, '_BAC', 'timeline');
  const projectionsDir = join(root, PROJECTIONS_DIR);

  const writeAtomic = async (path: string, body: string): Promise<void> => {
    await mkdir(join(path, '..'), { recursive: true });
    const tmp = `${path}.${createRevision()}.tmp`;
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, path);
  };

  const dayPath = (date: string): string => join(projectionsDir, `${date}.json`);

  const putDay = async (day: TimelineDayProjection): Promise<void> => {
    await writeAtomic(dayPath(day.date), JSON.stringify(day, null, 2));
  };

  const readDay = async (date: string): Promise<TimelineDayProjection | null> => {
    try {
      const raw = await readFile(dayPath(date), 'utf8');
      return JSON.parse(raw) as TimelineDayProjection;
    } catch {
      return null;
    }
  };

  const listDays = async (): Promise<readonly string[]> => {
    try {
      const entries = await readdir(projectionsDir);
      return entries
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
        .map((name) => name.replace(/\.json$/u, ''))
        .sort();
    } catch {
      return [];
    }
  };

  return { putDay, readDay, listDays };
};

// Build a TimelineDayProjection from a list of payloads for one day.
// Pulled out so both the materializer and tests can call it.
//
// Reviewer-flagged: `updatedAt` is the MAX `observedAt` across the
// payloads, NOT wall-clock new Date(). The same input log produces
// the same projection bytes on every replica + every replay,
// matching the docs claim that timeline projections are
// deterministic from the event log. (Wall-clock write time isn't a
// useful field for a deterministic projection — if anyone needs the
// last write time of the file, they can stat() it.)
export const buildDayProjection = (
  date: string,
  payloads: readonly BrowserTimelineObservedPayload[],
): TimelineDayProjection => {
  const entries = reduceTimelineEvents(payloads);
  let maxObservedAt = '';
  for (const p of payloads) {
    if (p.observedAt > maxObservedAt) maxObservedAt = p.observedAt;
  }
  return {
    date,
    entries,
    // Empty payloads: fall back to the date bucket itself so the
    // field is present and ordering-stable. In practice the
    // materializer never builds a projection from an empty list.
    updatedAt: maxObservedAt.length > 0 ? maxObservedAt : `${date}T00:00:00.000Z`,
    entryCount: entries.length,
  };
};

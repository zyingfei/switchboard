import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRevision } from '../domain/ids.js';
import { BROWSER_TIMELINE_OBSERVED, isBrowserTimelineObservedPayload, } from './events.js';
const TRANSITIONS_INCREMENTING_VISIT_COUNT = new Set([
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
export const dayBucketFor = (observedAt) => {
    const match = DAY_PREFIX_RE.exec(observedAt);
    if (match === null)
        return '1970-01-01';
    // Sanity-check the month/day ranges so 2026-13-99 doesn't
    // become a "valid" bucket. Year 0 is technically possible but
    // not worth special-casing.
    const month = Number.parseInt(match[2] ?? '0', 10);
    const day = Number.parseInt(match[3] ?? '0', 10);
    if (month < 1 || month > 12 || day < 1 || day > 31)
        return '1970-01-01';
    return observedAt.slice(0, 10);
};
// Stable per-day entry id derived from the canonicalUrl (or url if
// no canonicalUrl). Used to key the daily projection so distinct
// pages within a day stay distinct.
export const entryIdFor = (input) => {
    // Strip fragment + trailing slash to fold trivial variants.
    const raw = input.canonicalUrl ?? input.url;
    return raw.replace(/#.*$/u, '').replace(/\/+$/u, '');
};
// Pure reduction: turn a list of `BrowserTimelineObservedPayload`
// (sorted or unsorted; reducer is order-independent) into a list of
// TimelineEntry rows. Used by both the materializer (to produce
// daily projection files) and tests (to assert determinism).
export const reduceTimelineEvents = (events) => {
    const byEntry = new Map();
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
                ...(event.workstreamId === undefined
                    ? {}
                    : { workstreamId: event.workstreamId, workstreamObservedAt: event.observedAt }),
                visitCount: incrementsVisit ? 1 : 0,
            });
            continue;
        }
        if (event.observedAt < existing.firstSeenAt)
            existing.firstSeenAt = event.observedAt;
        if (event.observedAt > existing.lastSeenAt)
            existing.lastSeenAt = event.observedAt;
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
        // workstreamId: last-write-wins. Tracks "what flow was the user
        // in when they observed this URL". A URL revisited under a
        // different workstream rebinds.
        if (event.workstreamId !== undefined && event.workstreamId.length > 0) {
            if (existing.workstreamObservedAt === undefined ||
                event.observedAt >= existing.workstreamObservedAt) {
                existing.workstreamId = event.workstreamId;
                existing.workstreamObservedAt = event.observedAt;
            }
        }
        if (incrementsVisit)
            existing.visitCount += 1;
        byEntry.set(id, existing);
    }
    const rows = [];
    for (const [id, agg] of byEntry) {
        rows.push({
            id,
            firstSeenAt: agg.firstSeenAt,
            lastSeenAt: agg.lastSeenAt,
            url: agg.url,
            ...(agg.canonicalUrl === undefined ? {} : { canonicalUrl: agg.canonicalUrl }),
            ...(agg.title === undefined ? {} : { title: agg.title }),
            ...(agg.provider === undefined ? {} : { provider: agg.provider }),
            ...(agg.workstreamId === undefined ? {} : { workstreamId: agg.workstreamId }),
            visitCount: agg.visitCount,
        });
    }
    // Deterministic order: lastSeenAt desc, then id asc as tie-break.
    rows.sort((a, b) => {
        if (a.lastSeenAt !== b.lastSeenAt)
            return a.lastSeenAt < b.lastSeenAt ? 1 : -1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return rows;
};
// Filter accepted events to the timeline payloads. Keeps the
// materializer + reducer free of the AcceptedEvent envelope.
export const collectTimelinePayloads = (events) => {
    const payloads = [];
    for (const event of events) {
        if (event.type !== BROWSER_TIMELINE_OBSERVED)
            continue;
        if (!isBrowserTimelineObservedPayload(event.payload))
            continue;
        payloads.push(event.payload);
    }
    return payloads;
};
// Group payloads by day bucket. Used by both the materializer (writes
// one file per touched day) and HTTP query (range filter).
export const groupByDay = (payloads) => {
    const out = new Map();
    for (const p of payloads) {
        const day = dayBucketFor(p.observedAt);
        const list = out.get(day) ?? [];
        list.push(p);
        out.set(day, list);
    }
    return out;
};
const PROJECTIONS_DIR = 'projections';
export const createTimelineStore = (vaultRoot) => {
    const root = join(vaultRoot, '_BAC', 'timeline');
    const projectionsDir = join(root, PROJECTIONS_DIR);
    const writeAtomic = async (path, body) => {
        await mkdir(join(path, '..'), { recursive: true });
        const tmp = `${path}.${createRevision()}.tmp`;
        await writeFile(tmp, body, 'utf8');
        await rename(tmp, path);
    };
    const dayPath = (date) => join(projectionsDir, `${date}.json`);
    const putDay = async (day) => {
        await writeAtomic(dayPath(day.date), JSON.stringify(day, null, 2));
    };
    const readDay = async (date) => {
        try {
            const raw = await readFile(dayPath(date), 'utf8');
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    };
    const listDays = async () => {
        try {
            const entries = await readdir(projectionsDir);
            return entries
                .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
                .map((name) => name.replace(/\.json$/u, ''))
                .sort();
        }
        catch {
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
export const buildDayProjection = (date, payloads) => {
    const entries = reduceTimelineEvents(payloads);
    let maxObservedAt = '';
    for (const p of payloads) {
        if (p.observedAt > maxObservedAt)
            maxObservedAt = p.observedAt;
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
//# sourceMappingURL=projection.js.map
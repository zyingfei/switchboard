// Unit tests for the pure helpers extracted for perf/event-candidate-resolve:
// the folded event-candidate resolver-cache key, and the by-URL-indexed
// events-prep replacements for resolverSignalEventsForCanonicalUrls /
// resolverTimelineEventsForCanonicalUrls. Full-route behavior (cache
// hit/miss over HTTP, all-hit fast path) lives in ../visitsRoutes.test.ts;
// this file is scoped to the pure functions so the equivalence check does
// not need the whole HTTP server scaffold.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { USER_FLOW_REJECTED, USER_ORGANIZED_ITEM } from '../../feedback/events.js';
import type { AcceptedEvent } from '../../sync/causal.js';
import { createEventLog, type EventLog } from '../../sync/eventLog.js';
import { getCaughtUpSharedEventStore } from '../../sync/eventStore.js';
import { loadOrCreateReplica } from '../../sync/replicaId.js';
import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import {
  eventCandidateCacheRevision,
  resolverSignalEventsForCanonicalUrls,
  resolverSignalEventsForCanonicalUrlsIndexed,
  resolverTimelineEventsForCanonicalUrls,
  resolverTimelineEventsForCanonicalUrlsIndexed,
  stableHash,
} from './visitsRoutes.js';

describe('stableHash', () => {
  it('is deterministic for the same input', () => {
    expect(stableHash('https://example.test/page')).toBe(stableHash('https://example.test/page'));
  });

  it('differs for different inputs (spot check, not a formal collision proof)', () => {
    const inputs = ['a', 'b', 'ab', 'ba', '', 'https://example.test/page', 'https://example.test/other'];
    const hashes = new Set(inputs.map(stableHash));
    expect(hashes.size).toBe(inputs.length);
  });

  it('produces an 8-character lowercase hex string', () => {
    for (const input of ['', 'x', 'https://example.test/a very long url with spaces and stuff']) {
      expect(stableHash(input)).toMatch(/^[0-9a-f]{8}$/u);
    }
  });
});

describe('eventCandidateCacheRevision', () => {
  const REVISION = 'snap-rev-1|arm=v1';

  it('is deterministic across repeated calls with the same set', () => {
    const first = eventCandidateCacheRevision(REVISION, ['https://a.test', 'https://b.test']);
    const second = eventCandidateCacheRevision(REVISION, ['https://a.test', 'https://b.test']);
    expect(first).toBe(second);
  });

  it('is order-invariant (sorted-set-invariant)', () => {
    const forward = eventCandidateCacheRevision(REVISION, ['https://a.test', 'https://b.test', 'https://c.test']);
    const shuffled = eventCandidateCacheRevision(REVISION, ['https://c.test', 'https://a.test', 'https://b.test']);
    expect(forward).toBe(shuffled);
  });

  it('is duplicate-invariant', () => {
    const withDupes = eventCandidateCacheRevision(REVISION, [
      'https://a.test',
      'https://a.test',
      'https://b.test',
    ]);
    const withoutDupes = eventCandidateCacheRevision(REVISION, ['https://a.test', 'https://b.test']);
    expect(withDupes).toBe(withoutDupes);
  });

  it('produces a distinct key for a distinct URL set', () => {
    const setA = eventCandidateCacheRevision(REVISION, ['https://a.test']);
    const setB = eventCandidateCacheRevision(REVISION, ['https://a.test', 'https://b.test']);
    const setC = eventCandidateCacheRevision(REVISION, ['https://b.test']);
    expect(setA).not.toBe(setB);
    expect(setA).not.toBe(setC);
    expect(setB).not.toBe(setC);
  });

  it('produces a distinct key for a distinct base revision, same URL set', () => {
    const underRevA = eventCandidateCacheRevision('rev-a', ['https://a.test']);
    const underRevB = eventCandidateCacheRevision('rev-b', ['https://a.test']);
    expect(underRevA).not.toBe(underRevB);
  });

  it('never collides with the plain (unfolded) revision string itself', () => {
    const folded = eventCandidateCacheRevision(REVISION, ['https://a.test']);
    expect(folded).not.toBe(REVISION);
    expect(folded.startsWith(`${REVISION}|ec:`)).toBe(true);
  });
});

// ---- events-prep equivalence: indexed path vs the O(merged) JS filter ----

let previousEventStoreFlag: string | undefined;
let vaultRoot: string;
let eventLog: EventLog;

const buildEvent = (input: {
  readonly seq: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}): AcceptedEvent => ({
  clientEventId: `evt-${String(input.seq)}`,
  dot: { replicaId: 'replica-fixture', seq: input.seq },
  deps: input.seq > 1 ? { 'replica-fixture': input.seq - 1 } : {},
  aggregateId: `agg-${String(input.seq)}`,
  type: input.type,
  payload: input.payload,
  acceptedAtMs: Date.parse('2026-08-16T10:00:00.000Z') + input.seq * 1000,
});

const timelinePayload = (input: {
  readonly eventId: string;
  readonly url: string;
  readonly canonicalUrl?: string;
}): Record<string, unknown> => ({
  eventId: input.eventId,
  observedAt: '2026-08-16T10:00:00.000Z',
  url: input.url,
  ...(input.canonicalUrl === undefined ? {} : { canonicalUrl: input.canonicalUrl }),
  transition: 'updated',
});

const organizedItemPayload = (input: {
  readonly itemKind: string;
  readonly itemId: string;
}): Record<string, unknown> => ({
  payloadVersion: 1,
  itemKind: input.itemKind,
  itemId: input.itemId,
  action: 'move',
});

const flowRejectedPayload = (): Record<string, unknown> => ({
  payloadVersion: 1,
  relationKind: 'closest_visit',
  fromId: 'https://from.test/page',
  toId: 'https://to.test/page',
  reason: 'not-related',
});

// A synthetic fixture covering the semantics both functions must preserve:
//  - exact-match, unnormalized itemId matching for USER_ORGANIZED_ITEM
//    (a trailing-slash variant must NOT match — the timeline function
//    normalizes, this one deliberately does not, see visitsRoutes.ts)
//  - itemKind must be 'canonical-url' or the row is excluded even if itemId
//    matches
//  - USER_FLOW_REJECTED is matched UNCONDITIONALLY, regardless of target
//  - BROWSER_TIMELINE_OBSERVED matching normalizes BOTH sides (strips
//    #fragment and trailing '/'), and falls back to `url` when
//    `canonicalUrl` is absent
//  - unrelated event types and unrelated URLs are excluded
const buildFixtureEvents = (): readonly AcceptedEvent[] => [
  buildEvent({
    seq: 1,
    type: BROWSER_TIMELINE_OBSERVED,
    payload: timelinePayload({ eventId: 'tl-1', url: 'https://a.test/page', canonicalUrl: 'https://a.test/page' }),
  }),
  buildEvent({
    seq: 2,
    type: BROWSER_TIMELINE_OBSERVED,
    // No canonicalUrl — falls back to `url`; trailing slash normalizes to
    // the same key as https://b.test/page.
    payload: timelinePayload({ eventId: 'tl-2', url: 'https://b.test/page/' }),
  }),
  buildEvent({
    seq: 3,
    type: BROWSER_TIMELINE_OBSERVED,
    // #fragment normalizes to the same key as https://a.test/page.
    payload: timelinePayload({
      eventId: 'tl-3',
      url: 'https://a.test/page#section',
      canonicalUrl: 'https://a.test/page#section',
    }),
  }),
  buildEvent({
    seq: 4,
    type: BROWSER_TIMELINE_OBSERVED,
    payload: timelinePayload({ eventId: 'tl-4', url: 'https://unrelated.test/page', canonicalUrl: 'https://unrelated.test/page' }),
  }),
  buildEvent({
    seq: 5,
    type: USER_ORGANIZED_ITEM,
    payload: organizedItemPayload({ itemKind: 'canonical-url', itemId: 'https://a.test/page' }),
  }),
  buildEvent({
    seq: 6,
    type: USER_ORGANIZED_ITEM,
    // Trailing slash — itemId does NOT exactly equal the target string, so
    // this must be EXCLUDED (organized-item matching is exact, unlike the
    // timeline function's normalized matching).
    payload: organizedItemPayload({ itemKind: 'canonical-url', itemId: 'https://a.test/page/' }),
  }),
  buildEvent({
    seq: 7,
    type: USER_ORGANIZED_ITEM,
    // Right itemId, wrong itemKind — must be excluded.
    payload: organizedItemPayload({ itemKind: 'thread', itemId: 'https://a.test/page' }),
  }),
  buildEvent({
    seq: 8,
    type: USER_ORGANIZED_ITEM,
    payload: organizedItemPayload({ itemKind: 'canonical-url', itemId: 'https://unrelated.test/page' }),
  }),
  buildEvent({ seq: 9, type: USER_FLOW_REJECTED, payload: flowRejectedPayload() }),
  buildEvent({
    seq: 10,
    type: 'entity.title.enriched',
    payload: { payloadVersion: 1, marker: 'unrelated-type' },
  }),
];

const TARGET_URLS = ['https://a.test/page'];
const TIMELINE_TARGET_URLS = new Set(['https://a.test/page', 'https://b.test/page']);

const sortByClientEventId = (
  events: readonly AcceptedEvent[],
): readonly AcceptedEvent[] => [...events].sort((left, right) => left.clientEventId.localeCompare(right.clientEventId));

describe('events-prep equivalence: indexed path vs O(merged) JS filter', () => {
  beforeEach(async () => {
    previousEventStoreFlag = process.env['SIDETRACK_EVENT_STORE'];
    process.env['SIDETRACK_EVENT_STORE'] = '1';
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-events-prep-equiv-'));
    const replica = await loadOrCreateReplica(vaultRoot);
    eventLog = createEventLog(vaultRoot, replica);
    for (const event of buildFixtureEvents()) {
      await eventLog.importPeerEvent(event);
    }
  });

  afterEach(async () => {
    if (previousEventStoreFlag === undefined) delete process.env['SIDETRACK_EVENT_STORE'];
    else process.env['SIDETRACK_EVENT_STORE'] = previousEventStoreFlag;
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('resolverSignalEventsForCanonicalUrlsIndexed matches the JS-filter reference (order-insensitive)', async () => {
    const merged = await eventLog.readMerged();
    const reference = resolverSignalEventsForCanonicalUrls(merged, TARGET_URLS);
    // Reference sanity: exactly the flow-rejected event (unconditional) plus
    // the ONE exact-itemId canonical-url organized item (seq 5), excluding
    // the trailing-slash variant (seq 6) and the wrong-itemKind row (seq 7).
    expect(reference.map((event) => event.clientEventId).sort()).toEqual(['evt-5', 'evt-9']);

    // Warm the typed store so the indexed path has something to read from —
    // getSharedEventStoreServeStale (used internally) returns this SAME
    // memoized store, already caught up.
    const store = await getCaughtUpSharedEventStore(vaultRoot);
    expect(store).not.toBeNull();

    const indexed = await resolverSignalEventsForCanonicalUrlsIndexed(vaultRoot, merged, TARGET_URLS);
    expect(sortByClientEventId(indexed)).toEqual(sortByClientEventId(reference));
  });

  it('resolverTimelineEventsForCanonicalUrlsIndexed matches the JS-filter reference (order-insensitive)', async () => {
    const merged = await eventLog.readMerged();
    const reference = resolverTimelineEventsForCanonicalUrls(merged, TIMELINE_TARGET_URLS);
    // Reference sanity: the exact match (seq 1), the url-fallback + trailing-
    // slash normalization match (seq 2), and the #fragment-normalized match
    // (seq 3) — excluding the unrelated URL (seq 4).
    expect(reference.map((event) => event.clientEventId).sort()).toEqual(['evt-1', 'evt-2', 'evt-3']);

    const store = await getCaughtUpSharedEventStore(vaultRoot);
    expect(store).not.toBeNull();

    const indexed = await resolverTimelineEventsForCanonicalUrlsIndexed(
      vaultRoot,
      merged,
      TIMELINE_TARGET_URLS,
    );
    expect(sortByClientEventId(indexed)).toEqual(sortByClientEventId(reference));
  });

  it('falls back to the identical JS-filter result when the typed store is unavailable', async () => {
    // Store flag OFF for this one case — getSharedEventStoreServeStale
    // returns null, so both *Indexed helpers must fall back to filtering
    // `merged` exactly like the plain functions do.
    delete process.env['SIDETRACK_EVENT_STORE'];
    const merged = await eventLog.readMerged();
    const referenceSignal = resolverSignalEventsForCanonicalUrls(merged, TARGET_URLS);
    const referenceTimeline = resolverTimelineEventsForCanonicalUrls(merged, TIMELINE_TARGET_URLS);

    const indexedSignal = await resolverSignalEventsForCanonicalUrlsIndexed(vaultRoot, merged, TARGET_URLS);
    const indexedTimeline = await resolverTimelineEventsForCanonicalUrlsIndexed(
      vaultRoot,
      merged,
      TIMELINE_TARGET_URLS,
    );
    expect(sortByClientEventId(indexedSignal)).toEqual(sortByClientEventId(referenceSignal));
    expect(sortByClientEventId(indexedTimeline)).toEqual(sortByClientEventId(referenceTimeline));
  });

  it('returns empty results for an empty target set without touching the store', async () => {
    const merged = await eventLog.readMerged();
    await getCaughtUpSharedEventStore(vaultRoot);
    expect(await resolverSignalEventsForCanonicalUrlsIndexed(vaultRoot, merged, [])).toEqual(
      resolverSignalEventsForCanonicalUrls(merged, []),
    );
    expect(
      await resolverTimelineEventsForCanonicalUrlsIndexed(vaultRoot, merged, new Set()),
    ).toEqual([]);
  });
});

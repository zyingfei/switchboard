import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { BROWSER_TIMELINE_OBSERVED, isBrowserTimelineObservedPayload } from './events.js';
import { createTimelineFactsStore } from './timelineFactsStore.js';
import {
  timelineDaysFromEvents,
  type TimelineDayProjectionWithDimensions,
} from './timelineDays.js';
import {
  buildDayProjection,
  collectTimelinePayloads,
  entryIdFor,
  groupByDay,
} from './projection.js';
import type { AcceptedEvent } from '../sync/causal.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

let seqCounter = 0;
const REPLICA = 'replica-a';

const timelineEvent = (input: {
  readonly eventId: string;
  readonly observedAt: string;
  readonly url: string;
  readonly canonicalUrl?: string;
  readonly title?: string;
  readonly transition?: 'activated' | 'updated' | 'completed' | 'closed';
  readonly focusedWindowMs?: number;
}): AcceptedEvent => {
  const payload = {
    eventId: input.eventId,
    observedAt: input.observedAt,
    url: input.url,
    ...(input.canonicalUrl === undefined ? {} : { canonicalUrl: input.canonicalUrl }),
    ...(input.title === undefined ? {} : { title: input.title }),
    provider: 'generic',
    transition: input.transition ?? 'activated',
    tabIdHash: 'tab-1',
    windowIdHash: 'win-1',
    tabSessionId: 'tab-session-1',
    payloadVersion: 1,
    ...(input.focusedWindowMs === undefined
      ? {}
      : { dimensions: { engagement: { focusedWindowMs: input.focusedWindowMs } } }),
  };
  expect(isBrowserTimelineObservedPayload(payload)).toBe(true);
  seqCounter += 1;
  return {
    clientEventId: `timeline-${String(seqCounter)}`,
    dot: { replicaId: REPLICA, seq: seqCounter },
    deps: {},
    aggregateId: `browser.timeline.observed:${input.eventId}`,
    type: BROWSER_TIMELINE_OBSERVED,
    payload,
    acceptedAtMs: Date.parse(input.observedAt),
  };
};

const irrelevantEvent = (acceptedAtMs: number): AcceptedEvent => {
  seqCounter += 1;
  return {
    clientEventId: `priv-${String(seqCounter)}`,
    dot: { replicaId: REPLICA, seq: seqCounter },
    deps: {},
    aggregateId: 'privacy',
    type: 'privacy.gate.flipped',
    payload: { payloadVersion: 1, gate: 'timeline', state: 'open' },
    acceptedAtMs,
  };
};

const buildEvents = (): readonly AcceptedEvent[] => {
  seqCounter = 0;
  return [
    timelineEvent({
      eventId: 'a-1',
      observedAt: '2026-05-28T10:00:00.000Z',
      url: 'https://example.com/page-a#frag',
      canonicalUrl: 'https://example.com/page-a',
      title: 'Page A',
      focusedWindowMs: 100,
    }),
    irrelevantEvent(Date.parse('2026-05-28T10:05:00.000Z')),
    timelineEvent({
      eventId: 'a-2',
      observedAt: '2026-05-28T11:00:00.000Z',
      url: 'https://example.com/page-a',
      canonicalUrl: 'https://example.com/page-a',
      title: 'Page A New',
      transition: 'updated',
      focusedWindowMs: 500,
    }),
    timelineEvent({
      eventId: 'b-1',
      observedAt: '2026-05-28T23:00:00.000Z',
      url: 'https://example.com/page-b',
      title: 'Page B',
      focusedWindowMs: 250,
    }),
    timelineEvent({
      eventId: 'c-1',
      observedAt: '2026-05-29T01:00:00.000Z',
      url: 'https://example.com/page-c',
      title: 'Page C',
      transition: 'completed',
    }),
  ];
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

const legacyBuildTimelineDaysEquivalent = (
  merged: readonly AcceptedEvent[],
): readonly TimelineDayProjectionWithDimensions[] => {
  const payloads = collectTimelinePayloads(
    merged.filter(
      (event) =>
        event.type === BROWSER_TIMELINE_OBSERVED && isBrowserTimelineObservedPayload(event.payload),
    ),
  );
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
    out.push({
      ...projection,
      entries: projection.entries.map((entry) => {
        const focusedWindowMs = focusedByEntryId.get(entry.id);
        if (focusedWindowMs === undefined) return entry;
        return { ...entry, dimensions: { engagement: { focusedWindowMs } } };
      }),
    });
  }
  return out;
};

describe('TimelineFactsStore byte-equivalence', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const tempVault = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), 'timeline-facts-'));
    dirs.push(d);
    await mkdir(join(d, '_BAC', 'connections'), { recursive: true });
    return d;
  };

  // Runs under vitest (no Bun/sqlite needed): proves the extracted
  // projection seam is byte-equivalent to the legacy full-walk body.
  it('timelineDaysFromEvents matches buildTimelineDays-equivalent (pure)', () => {
    const events = buildEvents();
    expect(timelineDaysFromEvents(events)).toEqual(legacyBuildTimelineDaysEquivalent(events));
  });

  sqliteIt('readTimelineDays matches the legacy projection', async () => {
    const events = buildEvents();
    const legacy = legacyBuildTimelineDaysEquivalent(events);
    const vault = await tempVault();
    const store = await createTimelineFactsStore(vault);
    store.ingestMany(events);
    const fromStore = store.readTimelineDays();
    store.close();
    expect(fromStore).toEqual(legacy);
    expect(fromStore.map((day) => day.date)).toEqual(['2026-05-28', '2026-05-29']);
    const pageA = fromStore[0]?.entries.find((entry) => entry.id === 'https://example.com/page-a');
    expect(pageA?.title).toBe('Page A New');
    expect(pageA?.dimensions).toEqual({ engagement: { focusedWindowMs: 500 } });
  });

  sqliteIt('ingest is idempotent by (replicaId, seq)', async () => {
    const events = buildEvents();
    const vault = await tempVault();
    const store = await createTimelineFactsStore(vault);
    store.ingestMany(events);
    store.ingestMany(events); // second pass must not duplicate visit counts
    const fromStore = store.readTimelineDays();
    store.close();
    expect(fromStore).toEqual(legacyBuildTimelineDaysEquivalent(events));
  });

  sqliteIt('rebuildFromJsonl reproduces the same timeline days', async () => {
    const events = buildEvents();
    const vault = await tempVault();
    const logRoot = join(vault, '_BAC', 'log');
    await mkdir(join(logRoot, REPLICA), { recursive: true });
    await writeFile(
      join(logRoot, REPLICA, '0001.jsonl'),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\nnot-json\n`,
      'utf8',
    );
    const store = await createTimelineFactsStore(vault);
    await store.rebuildFromJsonl(logRoot);
    const fromStore = store.readTimelineDays();
    expect(store.watermark()[REPLICA]).toBe(seqCounter);
    store.close();
    expect(fromStore).toEqual(legacyBuildTimelineDaysEquivalent(events));
  });

  sqliteIt('catchUp ingests only events past the watermark', async () => {
    const events = buildEvents();
    const vault = await tempVault();
    const store = await createTimelineFactsStore(vault);
    const firstHalf = events.slice(0, 2);
    const secondHalf = events.slice(2);
    store.ingestMany(firstHalf);
    const added = await store.catchUp(events);
    const fromStore = store.readTimelineDays();
    store.close();
    expect(added).toBe(secondHalf.length);
    expect(fromStore).toEqual(legacyBuildTimelineDaysEquivalent(events));
  });
});

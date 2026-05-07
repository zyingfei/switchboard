import { describe, expect, it } from 'vitest';

import type { BrowserTimelineObservedPayload } from './events.js';
import {
  buildDayProjection,
  collectTimelinePayloads,
  dayBucketFor,
  entryIdFor,
  groupByDay,
  reduceTimelineEvents,
} from './projection.js';
import { BROWSER_TIMELINE_OBSERVED } from './events.js';
import type { AcceptedEvent } from '../sync/causal.js';

const observe = (input: Partial<BrowserTimelineObservedPayload> & { observedAt: string; url: string }):
  BrowserTimelineObservedPayload => ({
  eventId: input.eventId ?? `evt-${input.observedAt}-${input.url}`,
  observedAt: input.observedAt,
  url: input.url,
  transition: input.transition ?? 'activated',
  ...(input.canonicalUrl === undefined ? {} : { canonicalUrl: input.canonicalUrl }),
  ...(input.title === undefined ? {} : { title: input.title }),
  ...(input.provider === undefined ? {} : { provider: input.provider }),
  ...(input.tabIdHash === undefined ? {} : { tabIdHash: input.tabIdHash }),
  ...(input.windowIdHash === undefined ? {} : { windowIdHash: input.windowIdHash }),
});

describe('timeline projection reducer (Class B)', () => {
  it('groups multiple observations of one canonicalUrl into one entry', () => {
    const events = [
      observe({ observedAt: '2026-05-07T10:00:00.000Z', url: 'https://chatgpt.com/c/abc?token=1', canonicalUrl: 'https://chatgpt.com/c/abc', title: 'A' }),
      observe({ observedAt: '2026-05-07T10:01:00.000Z', url: 'https://chatgpt.com/c/abc?token=2', canonicalUrl: 'https://chatgpt.com/c/abc', title: 'A — updated' }),
      observe({ observedAt: '2026-05-07T10:05:00.000Z', url: 'https://chatgpt.com/c/abc', canonicalUrl: 'https://chatgpt.com/c/abc', title: 'A — updated', transition: 'updated' }),
    ];
    const entries = reduceTimelineEvents(events);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.firstSeenAt).toBe('2026-05-07T10:00:00.000Z');
    expect(entry.lastSeenAt).toBe('2026-05-07T10:05:00.000Z');
    expect(entry.title).toBe('A — updated'); // most recent non-empty wins
    expect(entry.visitCount).toBe(3); // all three transitions count
  });

  it('keeps distinct canonicalUrls separate within a day', () => {
    const events = [
      observe({ observedAt: '2026-05-07T10:00:00.000Z', url: 'https://chatgpt.com/c/abc', canonicalUrl: 'https://chatgpt.com/c/abc' }),
      observe({ observedAt: '2026-05-07T10:01:00.000Z', url: 'https://chatgpt.com/c/xyz', canonicalUrl: 'https://chatgpt.com/c/xyz' }),
    ];
    const entries = reduceTimelineEvents(events);
    expect(entries).toHaveLength(2);
  });

  it('is order-independent (deterministic regardless of input order)', () => {
    const events = [
      observe({ observedAt: '2026-05-07T10:00:00.000Z', url: 'https://x/a', canonicalUrl: 'https://x/a' }),
      observe({ observedAt: '2026-05-07T10:01:00.000Z', url: 'https://x/b', canonicalUrl: 'https://x/b', transition: 'updated' }),
      observe({ observedAt: '2026-05-07T10:02:00.000Z', url: 'https://x/a', canonicalUrl: 'https://x/a', title: 'A v2' }),
      observe({ observedAt: '2026-05-07T10:03:00.000Z', url: 'https://x/c', canonicalUrl: 'https://x/c' }),
    ];
    const fwd = reduceTimelineEvents(events);
    const rev = reduceTimelineEvents([...events].reverse());
    const shuffled = reduceTimelineEvents([events[2]!, events[0]!, events[3]!, events[1]!]);
    expect(rev).toEqual(fwd);
    expect(shuffled).toEqual(fwd);
  });

  it('closed/completed transitions update lastSeenAt but not visitCount', () => {
    const events = [
      observe({ observedAt: '2026-05-07T10:00:00.000Z', url: 'https://x/a', canonicalUrl: 'https://x/a' }),
      observe({ observedAt: '2026-05-07T10:01:00.000Z', url: 'https://x/a', canonicalUrl: 'https://x/a', transition: 'closed' }),
    ];
    const entries = reduceTimelineEvents(events);
    expect(entries[0]?.visitCount).toBe(1);
    expect(entries[0]?.lastSeenAt).toBe('2026-05-07T10:01:00.000Z');
  });

  it('sorts entries by lastSeenAt desc, id asc tie-break', () => {
    const events = [
      observe({ observedAt: '2026-05-07T10:00:00.000Z', url: 'https://x/a', canonicalUrl: 'https://x/a' }),
      observe({ observedAt: '2026-05-07T11:00:00.000Z', url: 'https://x/b', canonicalUrl: 'https://x/b' }),
      observe({ observedAt: '2026-05-07T11:00:00.000Z', url: 'https://x/c', canonicalUrl: 'https://x/c' }),
    ];
    const entries = reduceTimelineEvents(events);
    expect(entries.map((e) => e.id)).toEqual([
      'https://x/b',
      'https://x/c',
      'https://x/a',
    ]);
  });

  it('falls back to raw url when canonicalUrl is missing', () => {
    const events = [
      observe({ observedAt: '2026-05-07T10:00:00.000Z', url: 'https://no-canonical/foo' }),
    ];
    const entries = reduceTimelineEvents(events);
    expect(entries[0]?.id).toBe('https://no-canonical/foo');
    expect(entries[0]?.canonicalUrl).toBeUndefined();
  });

  it('strips fragments and trailing slashes from entry id', () => {
    expect(entryIdFor({ url: 'https://x/a#section' })).toBe('https://x/a');
    expect(entryIdFor({ url: 'https://x/a/' })).toBe('https://x/a');
    expect(entryIdFor({ canonicalUrl: 'https://x/a/', url: 'https://x/a' })).toBe('https://x/a');
  });
});

describe('timeline day bucketing', () => {
  it('extracts UTC date prefix as day bucket', () => {
    expect(dayBucketFor('2026-05-07T10:00:00.000Z')).toBe('2026-05-07');
    expect(dayBucketFor('2026-12-31T23:59:59.999Z')).toBe('2026-12-31');
  });

  it('falls back to epoch on malformed input', () => {
    expect(dayBucketFor('not-a-date')).toBe('1970-01-01');
    expect(dayBucketFor('')).toBe('1970-01-01');
  });

  it('strict-validates the date prefix (reviewer RV6)', () => {
    // Loose prefixes that the OLD check accepted now fall back.
    expect(dayBucketFor('abcd-fg-ij...')).toBe('1970-01-01');
    expect(dayBucketFor('20XX-YY-ZZ...')).toBe('1970-01-01');
    // Out-of-range month/day fall back too.
    expect(dayBucketFor('2026-13-99T...')).toBe('1970-01-01');
    expect(dayBucketFor('2026-00-15T...')).toBe('1970-01-01');
    expect(dayBucketFor('2026-05-32T...')).toBe('1970-01-01');
    // Valid ISO prefixes still pass.
    expect(dayBucketFor('2026-05-07T10:00:00Z')).toBe('2026-05-07');
    expect(dayBucketFor('1999-12-31')).toBe('1999-12-31');
  });

  it('groups payloads by day', () => {
    const payloads = [
      observe({ observedAt: '2026-05-07T10:00:00.000Z', url: 'https://x/a' }),
      observe({ observedAt: '2026-05-07T23:00:00.000Z', url: 'https://x/b' }),
      observe({ observedAt: '2026-05-08T01:00:00.000Z', url: 'https://x/c' }),
    ];
    const grouped = groupByDay(payloads);
    expect(grouped.size).toBe(2);
    expect(grouped.get('2026-05-07')?.length).toBe(2);
    expect(grouped.get('2026-05-08')?.length).toBe(1);
  });

  it('buildDayProjection returns deterministic shape with updatedAt = max(observedAt)', () => {
    const payloads = [
      observe({ observedAt: '2026-05-07T10:00:00.000Z', url: 'https://x/a' }),
      observe({ observedAt: '2026-05-07T11:00:00.000Z', url: 'https://x/b' }),
    ];
    const projection = buildDayProjection('2026-05-07', payloads);
    expect(projection.date).toBe('2026-05-07');
    expect(projection.entryCount).toBe(2);
    expect(projection.entries).toHaveLength(2);
    // Reviewer F5: updatedAt is derived from payloads, not wall
    // clock. Same payloads → same updatedAt → same bytes.
    expect(projection.updatedAt).toBe('2026-05-07T11:00:00.000Z');
  });

  it('buildDayProjection is byte-deterministic across calls (no wall-clock drift)', () => {
    const payloads = [
      observe({ observedAt: '2026-05-07T10:00:00.000Z', url: 'https://x/a' }),
      observe({ observedAt: '2026-05-07T11:00:00.000Z', url: 'https://x/b' }),
    ];
    const a = buildDayProjection('2026-05-07', payloads);
    const b = buildDayProjection('2026-05-07', payloads);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('buildDayProjection with empty payloads falls back to start-of-day', () => {
    const p = buildDayProjection('2026-05-07', []);
    expect(p.entryCount).toBe(0);
    expect(p.updatedAt).toBe('2026-05-07T00:00:00.000Z');
  });
});

describe('collectTimelinePayloads', () => {
  it('extracts only timeline events with valid payloads', () => {
    const events: AcceptedEvent[] = [
      {
        clientEventId: 'a',
        dot: { replicaId: 'r', seq: 1 },
        deps: {},
        aggregateId: 'day-2026-05-07',
        type: BROWSER_TIMELINE_OBSERVED,
        payload: observe({ observedAt: '2026-05-07T10:00:00.000Z', url: 'https://x/a' }),
        acceptedAtMs: 1,
      },
      {
        clientEventId: 'b',
        dot: { replicaId: 'r', seq: 2 },
        deps: {},
        aggregateId: 'thread-1',
        type: 'thread.upserted',
        payload: { ignored: true },
        acceptedAtMs: 2,
      },
      {
        clientEventId: 'c',
        dot: { replicaId: 'r', seq: 3 },
        deps: {},
        aggregateId: 'day-2026-05-07',
        type: BROWSER_TIMELINE_OBSERVED,
        payload: { malformed: true }, // fails the type predicate
        acceptedAtMs: 3,
      },
    ];
    const out = collectTimelinePayloads(events);
    expect(out).toHaveLength(1);
    expect(out[0]?.url).toBe('https://x/a');
  });
});

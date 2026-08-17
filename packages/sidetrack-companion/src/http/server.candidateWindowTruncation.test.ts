// Unit tests for the candidate-window truncation mark (perf/resolver-
// acceptance-harness, task #32 CANDIDATE-WINDOW TRUNCATION MARK). Prior
// behavior: the SIDETRACK_RESOLVER_CANDIDATE_TIMELINE_WINDOW-bounded read
// feeding candidate generation (server.ts's timelineEventsForCandidateGeneration)
// silently dropped everything past the window with zero signal. This makes
// that truncation audible via a throttled [resolver.candidate-window.truncated]
// console.warn line, parallel to connections/snapshot.ts's
// [resolver.subgraph.truncated]. Scoped to the pure/exported helper (a fake
// typed-event-store stub) so it does not need the whole HTTP server scaffold —
// see server.test.ts for full-route coverage of the surrounding batch-resolve
// path.

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import type { EventStore } from '../sync/eventStore.js';
import {
  resetResolverCandidateWindowTruncationLogForTest,
  timelineEventsForCandidateGeneration,
} from './server.js';

const WINDOW_ENV = 'SIDETRACK_RESOLVER_CANDIDATE_TIMELINE_WINDOW';

const fakeEventsOfLength = (length: number): readonly AcceptedEvent[] =>
  Array.from({ length }, () => ({}) as unknown as AcceptedEvent);

// Minimal typed-event-store stub — only the two methods
// timelineEventsForCandidateGeneration actually calls are implemented; every
// other EventStore member is deliberately absent (unused by this code path)
// and the object is cast through `unknown` to stand in for the interface.
const fakeStore = (mostRecent: readonly AcceptedEvent[]): EventStore =>
  ({
    readMostRecentByType: (_type: string, _limit: number) => mostRecent,
    forEachChunkOfTypes: async (
      _types: readonly string[],
      onChunk: (chunk: readonly AcceptedEvent[]) => void,
    ) => {
      onChunk(mostRecent);
    },
  }) as unknown as EventStore;

describe('timelineEventsForCandidateGeneration truncation mark', () => {
  afterEach(() => {
    delete process.env[WINDOW_ENV];
    resetResolverCandidateWindowTruncationLogForTest();
    vi.restoreAllMocks();
  });

  it('emits [resolver.candidate-window.truncated] when the read hits the window cap', async () => {
    process.env[WINDOW_ENV] = '3';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await timelineEventsForCandidateGeneration(
      fakeStore(fakeEventsOfLength(3)),
      [],
      ['https://a.test/page', 'https://b.test/page'],
    );

    expect(result.length).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe(
      '[resolver.candidate-window.truncated] url=https://a.test/page,https://b.test/page window=3',
    );
  });

  it('does not emit when the read is under the cap', async () => {
    process.env[WINDOW_ENV] = '5';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await timelineEventsForCandidateGeneration(
      fakeStore(fakeEventsOfLength(2)),
      [],
      ['https://a.test/page'],
    );

    expect(result.length).toBe(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not emit on the store-unavailable (merged-filter) path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await timelineEventsForCandidateGeneration(null, [], [
      'https://a.test/page',
    ]);

    expect(result).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('is throttled — a second truncation within the throttle window does not re-emit', async () => {
    process.env[WINDOW_ENV] = '3';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = fakeStore(fakeEventsOfLength(3));

    await timelineEventsForCandidateGeneration(store, [], ['https://a.test/page']);
    await timelineEventsForCandidateGeneration(store, [], ['https://b.test/page']);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('caps the logged url list and notes the remainder', async () => {
    process.env[WINDOW_ENV] = '1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await timelineEventsForCandidateGeneration(
      fakeStore(fakeEventsOfLength(1)),
      [],
      ['https://a.test', 'https://b.test', 'https://c.test', 'https://d.test', 'https://e.test'],
    );

    expect(warn.mock.calls[0]?.[0]).toBe(
      '[resolver.candidate-window.truncated] url=https://a.test,https://b.test,https://c.test,+2more window=1',
    );
  });
});

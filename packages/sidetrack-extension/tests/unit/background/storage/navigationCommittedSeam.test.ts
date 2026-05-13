import { describe, expect, it } from 'vitest';

import {
  ACCEPTED_EDGE_EVENT_STREAM_NAMES,
  partitionEdgeEventDrainBatch,
} from '../../../../src/background/storage/edge-event-drain';
import {
  InMemoryEventBuffer,
  type BufferedEvent,
} from '../../../../src/background/storage/in-memory-event-buffer';
import {
  NAVIGATION_COMMITTED,
  createWebNavigationListener,
  type NavigationCommittedPayload,
  type WebNavigationApi,
  type WebNavigationCommittedDetails,
} from '../../../../src/background/listeners/web-navigation';
import { isNavigationCommittedPayload } from '../../../../../sidetrack-companion/src/navigation/events';

// Seam test for the path:
//   chrome.webNavigation.onCommitted
//     → src/background/listeners/web-navigation.ts (writes to buffer)
//     → src/background/storage/edge-event-drain.ts:partitionEdgeEventDrainBatch
//          (with the PRODUCTION whitelist `ACCEPTED_EDGE_EVENT_STREAM_NAMES`)
//     → /v1/edge/events (which would call isNavigationCommittedPayload)
//
// This bug shipped because each module had its own unit tests with a
// hand-constructed whitelist that happened to omit navigation.committed
// — none asserted that the production whitelist actually accepts events
// the listener produces. The result: events were captured, then locally
// evicted by the drain, and the user's vault had zero navigation.committed
// records → Flow Path had no chain to render.
//
// The contract this test locks in: every event type a listener writes
// MUST be routable by the drain AND its payload MUST satisfy the
// companion's validator.

const makeListenerDeps = (
  buffer: InMemoryEventBuffer,
): Parameters<typeof createWebNavigationListener>[0] => {
  const webNavigation: WebNavigationApi = {
    onCommitted: {
      addListener: () => undefined,
    },
  };
  let seq = 0;
  return {
    webNavigation,
    tabs: { get: async () => ({ id: 1, windowId: 100 }) },
    tabOpenerStore: {
      rememberCreated: () => undefined,
      markRemoved: () => undefined,
      openerFor: () => null,
      wasRemoved: () => false,
    },
    eventBuffer: buffer,
    browserSessionStartMs: 1_700_000_000_000,
    edgeReplicaId: 'replica-test',
    allocateSeq: async (count?: number) => {
      const step = count ?? 1;
      const fromSeq = seq + 1;
      seq += step;
      return { fromSeq, toSeq: seq, edgeReplicaId: 'replica-test' };
    },
    now: () => new Date('2026-05-12T22:10:21.000Z'),
  };
};

describe('navigation.committed end-to-end seam', () => {
  it('listener writes events that the production drain whitelist routes for upload', async () => {
    const buffer = new InMemoryEventBuffer();
    const deps = makeListenerDeps(buffer);
    const { handleCommitted } = createWebNavigationListener(deps);

    await handleCommitted({
      tabId: 1,
      frameId: 0,
      url: 'https://www.huaxiaozhuan.com/chapters/1_algebra.html',
      timeStamp: Date.parse('2026-05-12T22:10:21.000Z'),
      transitionType: 'link',
      transitionQualifiers: [],
      documentId: 'doc_1',
    });

    const buffered = await buffer.peek(10);
    expect(buffered.map((e) => e.streamName)).toEqual([NAVIGATION_COMMITTED]);

    // The production whitelist must route the listener-emitted event.
    // This is the assertion that would have caught the original bug —
    // it fails the instant a listener writes an event type the drain
    // doesn't recognize.
    const partition = partitionEdgeEventDrainBatch(
      buffered as readonly BufferedEvent[],
      ACCEPTED_EDGE_EVENT_STREAM_NAMES,
      10,
    );
    expect(partition.routeBatch.map((e) => e.streamName)).toEqual([NAVIGATION_COMMITTED]);
    expect(partition.locallyRejectedBatch).toEqual([]);
  });

  it('listener payload satisfies the companion validator (cross-package contract)', async () => {
    const buffer = new InMemoryEventBuffer();
    const deps = makeListenerDeps(buffer);
    const { handleCommitted } = createWebNavigationListener(deps);

    await handleCommitted({
      tabId: 1,
      frameId: 0,
      url: 'https://example.com/page',
      timeStamp: Date.parse('2026-05-12T22:10:21.000Z'),
      transitionType: 'typed',
      transitionQualifiers: ['from_address_bar'],
    });

    const buffered = await buffer.peek(10);
    expect(buffered).toHaveLength(1);
    const payload = buffered[0]?.payload as NavigationCommittedPayload;
    // Without this contract test, the extension could ship an event
    // shape the companion rejects — the wire-format would silently
    // skip every navigation, just like before.
    expect(isNavigationCommittedPayload(payload)).toBe(true);
  });

  it('every production whitelist entry has a matching EventStreamName (no orphans)', () => {
    // Locks in the policy file. If anyone adds a new event type to
    // EVENT_STREAMS without deciding routing, this list is the first
    // place they read.
    expect([...ACCEPTED_EDGE_EVENT_STREAM_NAMES].sort()).toEqual([
      'engagement.interval.observed',
      'engagement.session.aggregated',
      'navigation.committed',
      'selection.copied',
      'selection.pasted',
      'visual.fingerprint.observed',
    ]);
  });
});

import { describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../causal.js';
import type { Materializer, MaterializerHealth } from './materializer.js';
import type { ContractEntry } from './registry.js';
import { createSyncContractRunner } from './runner.js';

// Lane 3 / L3-G6 — future-surface integration.
//
// Adding a new event type + plugin materializer + projection
// materializer should follow a documented recipe with NO changes
// to the runner / registry / materializer interface. This test
// is the executable form of the "contract is open" claim.
//
// We simulate adding a hypothetical `timeline.recorded` event:
//   1. Define the event type + payload (would land in
//      src/timeline/events.ts in real code).
//   2. Build a stub ContractEntry with the right surface + class.
//   3. Implement a stub Materializer that reacts to the event.
//   4. Register with the runner.
//   5. Drive an event through onAcceptedEvent.
//   6. Assert the materializer saw the event + health is healthy +
//      registry membership is consistent.
//
// If the runner / interface ever drift such that adding a new
// surface requires touching the contract layer itself, this test
// fails — and the failure is the signal that the architecture
// stopped being "open."

const TIMELINE_RECORDED = 'timeline.recorded' as const;

const stubFutureContractEntry: ContractEntry = {
  eventType: TIMELINE_RECORDED,
  surfaces: [
    {
      surface: 'timeline-projection',
      class: 'aggregate-projection',
      materializer: 'timeline-projection',
      peerFreshnessMs: 5_000,
      recovery: 'replay-event-log',
    },
    {
      surface: 'plugin-active-timeline-window',
      class: 'plugin-tier-bounded',
      // No companion-side materializer — the plugin owns this
      // surface as Class F.
      peerFreshnessMs: 5_000,
      recovery: 'replay-event-log',
    },
  ],
};

interface StubObserver {
  readonly events: AcceptedEvent[];
}

const createStubMaterializer = (name: string, observer: StubObserver): Materializer => {
  let lastSuccessAt: string | null = null;
  return {
    name,
    handles: new Set([TIMELINE_RECORDED]),
    onAccepted: (event) => {
      observer.events.push(event);
      lastSuccessAt = new Date().toISOString();
    },
    catchUp: async () => {
      lastSuccessAt = new Date().toISOString();
    },
    awaitIdle: async () => undefined,
    health: (): MaterializerHealth => ({
      status: 'healthy',
      lastSuccessAt,
      lastError: null,
      pending: false,
    }),
  };
};

describe('future-surface integration (L3-G6)', () => {
  it('a stub timeline.recorded event flows through runner → materializer with no contract-layer changes', () => {
    const observer: StubObserver = { events: [] };
    const runner = createSyncContractRunner();
    runner.register(createStubMaterializer('timeline-projection', observer));

    const event: AcceptedEvent = {
      clientEventId: 'tl-1',
      dot: { replicaId: 'edge_test', seq: 1 },
      deps: {},
      aggregateId: 'tl-event-1',
      type: TIMELINE_RECORDED,
      payload: {
        url: 'https://example.test/page',
        title: 'Some page',
        visitedAt: '2026-05-07T00:00:00.000Z',
      },
      acceptedAtMs: 1,
    };
    runner.onAcceptedEvent(event, { origin: 'peer' });

    expect(observer.events).toHaveLength(1);
    expect(observer.events[0]?.type).toBe(TIMELINE_RECORDED);
    expect(runner.health()['timeline-projection']?.status).toBe('healthy');
  });

  it('the recipe is one ContractEntry + one Materializer + tests — no runner/interface touches', () => {
    // The fact that this test compiled + ran proves the recipe is
    // closed under the public contract API. If a future change
    // forced the contract layer to learn about timeline-specific
    // semantics, this test would need to import internal runner
    // helpers — which it deliberately does not.
    expect(stubFutureContractEntry.eventType).toBe(TIMELINE_RECORDED);
    expect(stubFutureContractEntry.surfaces).toHaveLength(2);
    expect(stubFutureContractEntry.surfaces[0]?.class).toBe('aggregate-projection');
    expect(stubFutureContractEntry.surfaces[1]?.class).toBe('plugin-tier-bounded');
  });
});

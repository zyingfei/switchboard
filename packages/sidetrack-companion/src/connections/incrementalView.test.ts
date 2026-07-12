import { describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import { createIncrementalConnectionsGraphView } from './incrementalView.js';
import type { ConnectionsSnapshot } from './types.js';

const event = (type: string, seq: number): AcceptedEvent => ({
  type,
  payload: {},
  acceptedAtMs: seq,
  dot: { replicaId: 'replica-test', seq },
});

const snapshot: ConnectionsSnapshot = {
  scope: {},
  nodes: [],
  edges: [],
  updatedAt: '2026-05-01T00:00:00.000Z',
  nodeCount: 0,
  edgeCount: 0,
  snapshotRevision: 'rev-a',
};

describe('IncrementalConnectionsGraphView', () => {
  it('classifies high-traffic events as row-local after seeding', () => {
    const view = createIncrementalConnectionsGraphView();
    view.seed(snapshot);

    view.fold(event('browser.timeline.observed', 1));
    view.fold(event('thread.upserted', 2));

    expect(view.drainPlan()).toMatchObject({
      initialized: true,
      pendingEventCount: 2,
      rowLocalEventCount: 2,
      fullReducerEventCount: 0,
      canUseRowLocalOnly: true,
    });
  });

  it('falls back to the full reducer for unsupported event families', () => {
    const view = createIncrementalConnectionsGraphView();
    view.seed(snapshot);

    view.fold(event('annotation.created', 1));

    expect(view.drainPlan()).toMatchObject({
      rowLocalEventCount: 0,
      fullReducerEventCount: 1,
      canUseRowLocalOnly: false,
    });
  });
});

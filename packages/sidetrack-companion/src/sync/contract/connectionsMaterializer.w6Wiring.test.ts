// Stage 5.2 W6 — verify the connections materializer accumulates
// invalidation keys per accepted event and exposes the dedupe'd set
// consumed by the most recent drain.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConnectionsStore } from '../../connections/snapshot.js';
import { createTimelineStore } from '../../timeline/projection.js';
import { ANNOTATION_CREATED } from '../../annotations/events.js';
import { THREAD_UPSERTED } from '../../threads/events.js';
import { USER_ORGANIZED_ITEM } from '../../feedback/events.js';
import { WORKSTREAM_UPSERTED } from '../../workstreams/events.js';
import type { AcceptedEvent } from '../causal.js';
import { createEventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { createConnectionsMaterializer } from './connectionsMaterializer.js';

const buildEvent = (
  input: { seq: number; type: string; payload: unknown },
): AcceptedEvent => ({
  clientEventId: `evt-${String(input.seq)}`,
  dot: { replicaId: 'replica-A', seq: input.seq },
  deps: {},
  aggregateId: 'agg',
  type: input.type,
  payload: input.payload,
  acceptedAtMs: 1_700_000_000_000 + input.seq * 1000,
});

describe('Stage 5.2 W6 — connectionsMaterializer invalidation accumulation', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-w6-wiring-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('starts empty (no drain has run)', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const mat = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
    });
    expect(mat.getInvalidationsSinceLastBuild()).toEqual([]);
  });

  it('catchUp surfaces the accumulated dedupe\'d keys from prior onAccepted events', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const mat = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
    });

    mat.onAccepted(
      buildEvent({
        seq: 1,
        type: THREAD_UPSERTED,
        payload: {
          bac_id: 'bac_thread',
          threadUrl: 'https://example.com/a',
          title: 't',
          provider: 'p',
          lastSeenAt: '2026-05-12T00:00:00.000Z',
          tags: [],
        },
      }),
      { origin: 'local' },
    );
    mat.onAccepted(
      buildEvent({
        seq: 2,
        type: WORKSTREAM_UPSERTED,
        payload: { bac_id: 'ws_x', title: 'X' },
      }),
      { origin: 'local' },
    );
    mat.onAccepted(
      buildEvent({
        seq: 3,
        type: USER_ORGANIZED_ITEM,
        payload: {
          itemKind: 'canonical-url',
          itemId: 'https://example.com/a',
          action: 'move',
          toContainer: 'ws_x',
        },
      }),
      { origin: 'local' },
    );

    // catchUp calls buildAndWrite directly, which snapshots the
    // accumulator at entry.
    await mat.catchUp(eventLog);

    const keys = mat.getInvalidationsSinceLastBuild();
    // THREAD_UPSERTED → thread + url (2 keys)
    // WORKSTREAM_UPSERTED → workstream + workstreamTree + workstreamPathMemo (3 keys)
    // USER_ORGANIZED_ITEM canonical-url → url (1 key, dedupe-merged with thread's url)
    const kinds = keys.map((k) => k.kind).sort();
    expect(kinds).toContain('thread');
    expect(kinds).toContain('url');
    expect(kinds).toContain('workstream');
    expect(kinds).toContain('workstreamTree');
    expect(kinds).toContain('workstreamPathMemo');
    // Dedupe — the URL key is contributed by BOTH the thread.upserted
    // (canonicalUrl = threadUrl) and the user.organized.item; the
    // accumulator should keep exactly one.
    const urlKeys = keys.filter((k) => k.kind === 'url');
    expect(urlKeys).toHaveLength(1);
  });

  it('ANNOTATION_CREATED contributes no invalidations even though it triggers a drain', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const mat = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
    });

    mat.onAccepted(
      buildEvent({ seq: 1, type: ANNOTATION_CREATED, payload: {} }),
      { origin: 'local' },
    );
    await mat.catchUp(eventLog);
    expect(mat.getInvalidationsSinceLastBuild()).toEqual([]);
  });

  it('keys are cleared after a drain so the next drain only sees newly-arrived events', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const mat = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
    });

    mat.onAccepted(
      buildEvent({
        seq: 1,
        type: WORKSTREAM_UPSERTED,
        payload: { bac_id: 'ws_x', title: 'X' },
      }),
      { origin: 'local' },
    );
    await mat.catchUp(eventLog);
    expect(mat.getInvalidationsSinceLastBuild().length).toBeGreaterThan(0);

    // Second drain with no new onAccepted events → keys should be [].
    await mat.catchUp(eventLog);
    expect(mat.getInvalidationsSinceLastBuild()).toEqual([]);
  });
});

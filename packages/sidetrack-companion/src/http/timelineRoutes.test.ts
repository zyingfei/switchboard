import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createVaultWriter } from '../vault/writer.js';
import { createIdempotencyStore } from './idempotency.js';
import { createEventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { createSyncContractRunner } from '../sync/contract/runner.js';
import { createTimelineMaterializer } from '../sync/contract/timelineMaterializer.js';
import { createTimelineStore } from '../timeline/projection.js';
import {
  BROWSER_TIMELINE_OBSERVED,
  type BrowserTimelineObservedPayload,
} from '../timeline/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { createCompanionHttpServer, startHttpServer } from './server.js';

// Black-box: spin up the companion HTTP server with the timeline
// routes wired and exercise POST /v1/timeline/events + GET /v1/timeline.

const buildEvent = (input: {
  edgeReplicaId: string;
  seq: number;
  payload: BrowserTimelineObservedPayload;
}): AcceptedEvent => ({
  clientEventId: input.payload.eventId,
  dot: { replicaId: input.edgeReplicaId, seq: input.seq },
  deps: {},
  aggregateId: input.payload.observedAt.slice(0, 10),
  type: BROWSER_TIMELINE_OBSERVED,
  payload: input.payload,
  acceptedAtMs: Date.parse(input.payload.observedAt),
});

const observe = (
  overrides: Partial<BrowserTimelineObservedPayload> & { observedAt: string; url: string },
): BrowserTimelineObservedPayload => ({
  eventId: overrides.eventId ?? `evt-${overrides.observedAt}-${overrides.url}`,
  observedAt: overrides.observedAt,
  url: overrides.url,
  transition: overrides.transition ?? 'activated',
  ...(overrides.canonicalUrl === undefined ? {} : { canonicalUrl: overrides.canonicalUrl }),
  ...(overrides.title === undefined ? {} : { title: overrides.title }),
  ...(overrides.provider === undefined ? {} : { provider: overrides.provider }),
});

describe('timeline HTTP routes', () => {
  let vaultRoot: string;
  let serverUrl: string;
  let close: (() => Promise<void>) | null = null;

  const BRIDGE = 'test-bridge-key';

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-timeline-http-'));
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createTimelineStore(vaultRoot);
    const runner = createSyncContractRunner();
    runner.register(createTimelineMaterializer({ store, eventLog }));
    const idempotencyStore = createIdempotencyStore(vaultRoot);
    const server = createCompanionHttpServer({
      bridgeKey: BRIDGE,
      vaultWriter: createVaultWriter(vaultRoot),
      vaultRoot,
      idempotencyStore,
      replica,
      eventLog,
      timelineStore: store,
      importEdgeEvent: async (event) => {
        const result = await eventLog.importPeerEvent(event);
        if (result.imported) runner.onAcceptedEvent(event, { origin: 'peer' });
        return { imported: result.imported };
      },
      syncMaterializerHealth: () => runner.health(),
    });
    const started = await startHttpServer(server, 0);
    serverUrl = started.url;
    close = started.close;
  });

  afterEach(async () => {
    if (close !== null) await close();
    close = null;
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const post = async (path: string, body: unknown): Promise<{ status: number; data: unknown }> => {
    const res = await fetch(`${serverUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': BRIDGE,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };

  const get = async (path: string): Promise<{ status: number; data: unknown }> => {
    const res = await fetch(`${serverUrl}${path}`, {
      headers: { 'x-bac-bridge-key': BRIDGE },
    });
    return { status: res.status, data: await res.json() };
  };

  it('POST /v1/timeline/events imports edge events and GET /v1/timeline returns them', async () => {
    const events = [
      buildEvent({
        edgeReplicaId: 'edge_test',
        seq: 1,
        payload: observe({
          observedAt: '2026-05-07T10:00:00.000Z',
          url: 'https://x/a',
          canonicalUrl: 'https://x/a',
          title: 'A',
        }),
      }),
      buildEvent({
        edgeReplicaId: 'edge_test',
        seq: 2,
        payload: observe({
          observedAt: '2026-05-07T11:00:00.000Z',
          url: 'https://x/b',
          canonicalUrl: 'https://x/b',
          title: 'B',
        }),
      }),
    ];
    const post1 = await post('/v1/timeline/events', { events });
    expect(post1.status).toBe(200);
    const data = post1.data as { data: { imported: { replicaId: string; seq: number }[] } };
    expect(data.data.imported).toHaveLength(2);

    // Give the materializer a tick to drain.
    await new Promise((r) => setTimeout(r, 50));

    const got = await get('/v1/timeline');
    expect(got.status).toBe(200);
    const body = got.data as {
      data: { scope: string; items: { id: string }[]; entryCount: number };
    };
    expect(body.data.scope).toBe('companion-extended');
    expect(body.data.entryCount).toBeGreaterThanOrEqual(2);
    const ids = body.data.items.map((e) => e.id);
    expect(ids).toContain('https://x/a');
    expect(ids).toContain('https://x/b');
  });

  it('POST /v1/timeline/events is idempotent — same edge dot re-imports as no-op', async () => {
    const event = buildEvent({
      edgeReplicaId: 'edge_test',
      seq: 1,
      payload: observe({
        observedAt: '2026-05-07T10:00:00.000Z',
        url: 'https://x/a',
        canonicalUrl: 'https://x/a',
      }),
    });
    const r1 = await post('/v1/timeline/events', { events: [event] });
    expect(r1.status).toBe(200);
    expect((r1.data as { data: { imported: unknown[] } }).data.imported).toHaveLength(1);

    const r2 = await post('/v1/timeline/events', { events: [event] });
    expect(r2.status).toBe(200);
    const body2 = r2.data as { data: { imported: unknown[]; skipped: { reason: string }[] } };
    expect(body2.data.imported).toHaveLength(0);
    expect(body2.data.skipped).toHaveLength(1);
    expect(body2.data.skipped[0]?.reason).toBe('already-imported');
  });

  it('GET /v1/timeline filters by `q` substring', async () => {
    const events = [
      buildEvent({
        edgeReplicaId: 'edge_test',
        seq: 1,
        payload: observe({
          observedAt: '2026-05-07T10:00:00.000Z',
          url: 'https://chat.example.com/abc',
          canonicalUrl: 'https://chat.example.com/abc',
          title: 'Recipe planning',
        }),
      }),
      buildEvent({
        edgeReplicaId: 'edge_test',
        seq: 2,
        payload: observe({
          observedAt: '2026-05-07T11:00:00.000Z',
          url: 'https://github.com/repo',
          canonicalUrl: 'https://github.com/repo',
          title: 'GitHub',
        }),
      }),
    ];
    await post('/v1/timeline/events', { events });
    await new Promise((r) => setTimeout(r, 50));
    const got = await get('/v1/timeline?q=recipe');
    const body = got.data as { data: { items: { title?: string }[] } };
    expect(body.data.items.map((e) => e.title)).toEqual(['Recipe planning']);
  });

  it('POST rejects events with non-timeline type or invalid payload', async () => {
    const goodEvent = buildEvent({
      edgeReplicaId: 'edge_test',
      seq: 1,
      payload: observe({
        observedAt: '2026-05-07T10:00:00.000Z',
        url: 'https://x/a',
        canonicalUrl: 'https://x/a',
      }),
    });
    const wrongType = {
      clientEventId: 'wrong-type',
      dot: { replicaId: 'edge_test', seq: 99 },
      deps: {},
      aggregateId: 'thread-1',
      type: 'thread.upserted',
      payload: { ignored: true },
      acceptedAtMs: 0,
    };
    const malformedPayload = {
      clientEventId: 'malformed',
      dot: { replicaId: 'edge_test', seq: 100 },
      deps: {},
      aggregateId: 'day-2026-05-07',
      type: BROWSER_TIMELINE_OBSERVED,
      payload: { not_a_real: 'payload' },
      acceptedAtMs: 0,
    };
    const result = await post('/v1/timeline/events', {
      events: [goodEvent, wrongType, malformedPayload],
    });
    expect(result.status).toBe(200);
    const body = result.data as {
      data: {
        imported: { replicaId: string; seq: number }[];
        skipped: { replicaId: string; seq: number; reason: string }[];
      };
    };
    expect(body.data.imported).toHaveLength(1);
    expect(body.data.imported[0]?.seq).toBe(1);
    const reasons = body.data.skipped.map((s) => s.reason).sort();
    expect(reasons).toEqual(['invalid-event-type', 'invalid-payload']);
    // Let the materializer drain finish before afterEach rms the
    // vault — otherwise rm races a putDay write.
    await new Promise((r) => setTimeout(r, 50));
  });

  it('POST /v1/timeline/events sanitizes raw URLs at the import boundary (reviewer RV1)', async () => {
    // Defense-in-depth: even if a caller bypasses the plugin
    // observer's sanitizer (older build, archive replay, malicious
    // POSTer with the bridge key), the route must strip auth tokens
    // BEFORE the event lands in the immutable log.
    const dirty = buildEvent({
      edgeReplicaId: 'edge_dirty',
      seq: 1,
      payload: observe({
        observedAt: '2026-05-07T10:00:00.000Z',
        url: 'https://example.com/callback?code=secret123&state=xyz#frag',
        canonicalUrl: 'https://example.com/callback?session_id=abc',
      }),
    });
    const r = await post('/v1/timeline/events', { events: [dirty] });
    expect(r.status).toBe(200);
    expect((r.data as { data: { imported: unknown[] } }).data.imported).toHaveLength(1);

    await new Promise((res) => setTimeout(res, 50));
    const view = await get('/v1/timeline');
    const items = (view.data as { data: { items: { url: string; canonicalUrl?: string }[] } }).data
      .items;
    expect(items).toHaveLength(1);
    // Auth tokens MUST NOT be present in the projection.
    const serialized = JSON.stringify(items);
    expect(serialized).not.toMatch(/secret123/);
    expect(serialized).not.toMatch(/code=/);
    expect(serialized).not.toMatch(/state=xyz/);
    expect(serialized).not.toMatch(/session_id=/);
    expect(serialized).not.toMatch(/#frag/);
    // The clean URL prefix is preserved.
    expect(items[0]?.url).toBe('https://example.com/callback');
    expect(items[0]?.canonicalUrl).toBe('https://example.com/callback');
  });

  it('GET /v1/timeline applies exact same-day partial-range filtering (reviewer F6)', async () => {
    // Two events on the same day — one before the cut-off, one
    // after. since= timestamp should exclude the earlier one even
    // though it lives in the same daily bucket file.
    const events = [
      buildEvent({
        edgeReplicaId: 'edge_partial',
        seq: 1,
        payload: observe({
          observedAt: '2026-05-07T09:00:00.000Z',
          url: 'https://x/morning',
          canonicalUrl: 'https://x/morning',
        }),
      }),
      buildEvent({
        edgeReplicaId: 'edge_partial',
        seq: 2,
        payload: observe({
          observedAt: '2026-05-07T15:00:00.000Z',
          url: 'https://x/afternoon',
          canonicalUrl: 'https://x/afternoon',
        }),
      }),
    ];
    await post('/v1/timeline/events', { events });
    await new Promise((r) => setTimeout(r, 50));
    const got = await get('/v1/timeline?since=2026-05-07T12:00:00.000Z');
    const body = got.data as { data: { items: { id: string }[] } };
    expect(body.data.items.map((e) => e.id)).toEqual(['https://x/afternoon']);
  });

  it('GET /v1/timeline filters by `since` and `until` dates', async () => {
    const events = [
      buildEvent({
        edgeReplicaId: 'edge_test',
        seq: 1,
        payload: observe({
          observedAt: '2026-05-06T10:00:00.000Z',
          url: 'https://x/a',
          canonicalUrl: 'https://x/a',
        }),
      }),
      buildEvent({
        edgeReplicaId: 'edge_test',
        seq: 2,
        payload: observe({
          observedAt: '2026-05-07T10:00:00.000Z',
          url: 'https://x/b',
          canonicalUrl: 'https://x/b',
        }),
      }),
      buildEvent({
        edgeReplicaId: 'edge_test',
        seq: 3,
        payload: observe({
          observedAt: '2026-05-08T10:00:00.000Z',
          url: 'https://x/c',
          canonicalUrl: 'https://x/c',
        }),
      }),
    ];
    await post('/v1/timeline/events', { events });
    await new Promise((r) => setTimeout(r, 50));
    const got = await get('/v1/timeline?since=2026-05-07&until=2026-05-07');
    const body = got.data as { data: { items: { id: string; date: string }[] } };
    expect(body.data.items.map((e) => e.date)).toEqual(['2026-05-07']);
  });
});

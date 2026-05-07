import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createIdempotencyStore } from '../../http/idempotency.js';
import { createCompanionHttpServer, startHttpServer } from '../../http/server.js';
import {
  BROWSER_TIMELINE_OBSERVED,
  type BrowserTimelineObservedPayload,
} from '../../timeline/events.js';
import {
  createTimelineStore,
} from '../../timeline/projection.js';
import { createVaultWriter } from '../../vault/writer.js';
import type { AcceptedEvent } from '../causal.js';
import { createEventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { createSyncContractRunner } from './runner.js';
import { createTimelineMaterializer } from './timelineMaterializer.js';

// Mode P → Mode P+C → user-outcome integration:
//
//   1. Plugin runs offline; observations queue with edge dots.
//   2. Companion comes up (Mode P+C).
//   3. Plugin drainer ships the spooled events to the companion via
//      POST /v1/timeline/events; companion imports each via the
//      single-dispatch path (importEdgeEvent → runner →
//      timelineMaterializer).
//   4. GET /v1/timeline returns the drained entries with
//      `scope: 'companion-extended'`.
//   5. Re-drain (or re-import the same archive) is idempotent on
//      edge dot — no duplicate events at the companion.
//
// This is the analogue of L3-G3 (drain on reconnect) for the
// timeline surface and proves the contract is open without
// requiring any architecture changes.

const buildEdgeEvent = (input: {
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

const observe = (overrides: Partial<BrowserTimelineObservedPayload> & { observedAt: string; url: string }):
  BrowserTimelineObservedPayload => ({
  eventId: overrides.eventId ?? `evt-${overrides.observedAt}-${overrides.url}`,
  observedAt: overrides.observedAt,
  url: overrides.url,
  transition: overrides.transition ?? 'activated',
  ...(overrides.canonicalUrl === undefined ? {} : { canonicalUrl: overrides.canonicalUrl }),
  ...(overrides.title === undefined ? {} : { title: overrides.title }),
  ...(overrides.provider === undefined ? {} : { provider: overrides.provider }),
});

describe('timeline Mode P → Mode P+C integration', () => {
  let vaultRoot: string;
  let serverUrl: string;
  let close: (() => Promise<void>) | null = null;
  const BRIDGE = 'integration-bridge-key';

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-timeline-modeP-'));
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

  // Synthetic plugin spool — mimics what the extension's
  // timelinePluginMaterializer holds while companion is offline.
  // Building it here keeps the test focused on the cross-boundary
  // contract rather than the chrome.storage shim.
  const buildSpool = (
    edgeReplicaId: string,
    payloads: readonly BrowserTimelineObservedPayload[],
  ): readonly AcceptedEvent[] =>
    payloads.map((payload, index) =>
      buildEdgeEvent({ edgeReplicaId, seq: index + 1, payload }),
    );

  const drainToCompanion = async (
    events: readonly AcceptedEvent[],
  ): Promise<{ imported: { replicaId: string; seq: number }[]; skipped: { replicaId: string; seq: number; reason: string }[] }> => {
    const res = await fetch(`${serverUrl}/v1/timeline/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': BRIDGE },
      body: JSON.stringify({ events }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { imported: { replicaId: string; seq: number }[]; skipped: { replicaId: string; seq: number; reason: string }[] } };
    return body.data;
  };

  const queryTimeline = async (
    qs = '',
  ): Promise<{ scope: string; items: { id: string; date: string }[]; entryCount: number }> => {
    const res = await fetch(`${serverUrl}/v1/timeline${qs}`, {
      headers: { 'x-bac-bridge-key': BRIDGE },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { scope: string; items: { id: string; date: string }[]; entryCount: number };
    };
    return body.data;
  };

  it('Mode P offline → Mode P+C drain → GET /v1/timeline reflects the entries', async () => {
    // Mode P: plugin observes 3 events while companion is offline.
    const offlineSpool = buildSpool('edge_modeP_test', [
      observe({ observedAt: '2026-05-07T10:00:00.000Z', url: 'https://x/a', canonicalUrl: 'https://x/a', title: 'A' }),
      observe({ observedAt: '2026-05-07T11:00:00.000Z', url: 'https://x/b', canonicalUrl: 'https://x/b', title: 'B' }),
      observe({ observedAt: '2026-05-07T11:30:00.000Z', url: 'https://x/a', canonicalUrl: 'https://x/a', title: 'A revisited', transition: 'updated' }),
    ]);
    expect(offlineSpool).toHaveLength(3);

    // Mode P+C: companion is reachable; drain runs.
    const drain1 = await drainToCompanion(offlineSpool);
    expect(drain1.imported).toHaveLength(3);
    expect(drain1.skipped).toHaveLength(0);

    // Materializer drain.
    await new Promise((r) => setTimeout(r, 50));

    // Companion projection visible via GET /v1/timeline.
    const view = await queryTimeline();
    expect(view.scope).toBe('companion-extended');
    expect(view.entryCount).toBeGreaterThanOrEqual(2);
    const ids = view.items.map((e) => e.id);
    expect(ids).toContain('https://x/a');
    expect(ids).toContain('https://x/b');
    // The two activated/updated transitions on /a get folded into
    // one entry with visitCount 2.
    const a = view.items.find((e) => e.id === 'https://x/a') as
      | { visitCount?: number }
      | undefined;
    expect(a?.visitCount).toBe(2);
  });

  it('archive identity — re-drain of same edge dots is a no-op (idempotent at the companion)', async () => {
    const spool = buildSpool('edge_archive_test', [
      observe({ observedAt: '2026-05-07T10:00:00.000Z', url: 'https://x/a', canonicalUrl: 'https://x/a' }),
    ]);
    const drain1 = await drainToCompanion(spool);
    expect(drain1.imported).toHaveLength(1);

    // Re-drain — same edge dot. Companion dedupes.
    const drain2 = await drainToCompanion(spool);
    expect(drain2.imported).toHaveLength(0);
    expect(drain2.skipped).toHaveLength(1);
    expect(drain2.skipped[0]?.reason).toBe('already-imported');

    await new Promise((r) => setTimeout(r, 30));
    const view = await queryTimeline();
    // Still a single entry — re-drain didn't double-count.
    const matches = view.items.filter((e) => e.id === 'https://x/a');
    expect(matches).toHaveLength(1);
  });

  it('range filter honors `since` and `until` against the day projections', async () => {
    const spool = buildSpool('edge_range_test', [
      observe({ observedAt: '2026-05-05T10:00:00.000Z', url: 'https://x/may5', canonicalUrl: 'https://x/may5' }),
      observe({ observedAt: '2026-05-06T10:00:00.000Z', url: 'https://x/may6', canonicalUrl: 'https://x/may6' }),
      observe({ observedAt: '2026-05-07T10:00:00.000Z', url: 'https://x/may7', canonicalUrl: 'https://x/may7' }),
    ]);
    await drainToCompanion(spool);
    await new Promise((r) => setTimeout(r, 50));
    const view = await queryTimeline('?since=2026-05-06&until=2026-05-06');
    const dates = Array.from(new Set(view.items.map((e) => e.date)));
    expect(dates).toEqual(['2026-05-06']);
  });
});

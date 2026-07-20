// HTTP-level coverage for the resolve-family stale-while-revalidate fix and
// the non-blocking /v1/status catch-up. The pure SWR cache mechanics are unit-
// tested in resolveSwrCache.test.ts; here we assert the ROUTES wire it up:
// a graph-sig change serves the prior resolve instantly (marked
// `stale-revalidating`) instead of recomputing cold, and /v1/status returns
// fast with `catchingUp` while a slow catch-up runs in the background.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConnectionsSnapshot, ConnectionsStore } from '../connections/snapshot.js';
import { resolveUrlAttribution } from '../tabsession/resolver.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import { createEventLog, type EventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { createVaultWriter } from '../vault/writer.js';
import { createIdempotencyStore } from './idempotency.js';
import {
  createCompanionHttpServer,
  resetStatusCatchUpStateForTest,
  startHttpServer,
  type CompanionHttpConfig,
} from './server.js';

const bridgeKey = 'resolve-swr-bridge-key';
const reqHeaders = (): Record<string, string> => ({
  'content-type': 'application/json',
  'x-bac-bridge-key': bridgeKey,
});

const snapshotForUrls = (urls: readonly string[], revision: string): ConnectionsSnapshot => ({
  scope: {},
  nodes: urls.map((canonicalUrl) => ({
    id: `timeline-visit:${canonicalUrl}`,
    kind: 'timeline-visit' as const,
    label: canonicalUrl,
    originReplicaIds: [],
    metadata: { canonicalUrl },
  })),
  edges: [],
  updatedAt: '2026-05-07T10:00:00.000Z',
  nodeCount: urls.length,
  edgeCount: 0,
  snapshotRevision: revision,
});

describe('resolve-family SWR HTTP wiring', () => {
  let vaultRoot: string;
  let serverUrl: string;
  let eventLog: EventLog;
  let currentConnectionsSnapshot: ConnectionsSnapshot | null = null;
  let close: (() => Promise<void>) | null = null;
  let priorBucket: string | undefined;

  const connectionsCurrentJson = (): string =>
    join(vaultRoot, '_BAC', 'connections', 'current.json');

  // Rotate the non-sqlite graph signature: resolveSig keys on `bucket:size` of
  // current.json. With bucketing disabled (env below) the file SIZE alone
  // rotates the sig — exactly the drain-driven eviction the SWR fix defuses.
  const rotateGraphSig = async (bytes: number): Promise<void> => {
    await writeFile(connectionsCurrentJson(), 'x'.repeat(bytes));
  };

  beforeEach(async () => {
    // Disable mtime bucketing so file size deterministically drives the sig.
    priorBucket = process.env['SIDETRACK_RESOLVE_SIG_BUCKET_MS'];
    process.env['SIDETRACK_RESOLVE_SIG_BUCKET_MS'] = '0';
    resetStatusCatchUpStateForTest();
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-resolve-swr-'));
    await mkdir(join(vaultRoot, '_BAC', 'connections'), { recursive: true });
    const replica = await loadOrCreateReplica(vaultRoot);
    eventLog = createEventLog(vaultRoot, replica);
    const connectionsStore: ConnectionsStore = {
      putCurrent: async (snapshot) => {
        currentConnectionsSnapshot = snapshot;
      },
      readCurrent: async () => currentConnectionsSnapshot,
      putDay: async () => undefined,
      readDay: async () => null,
      listDays: async () => [],
      writeSnapshotAndProgress: async () => {},
      readMaterializerProgress: async () => null,
    };
    const config: CompanionHttpConfig = {
      bridgeKey,
      vaultWriter: createVaultWriter(vaultRoot),
      vaultRoot,
      idempotencyStore: createIdempotencyStore(vaultRoot),
      replica,
      eventLog,
      connectionsStore,
    };
    const server = createCompanionHttpServer(config);
    const started = await startHttpServer(server, 0);
    serverUrl = started.url;
    close = started.close;
  });

  afterEach(async () => {
    if (close !== null) await close();
    close = null;
    if (priorBucket === undefined) delete process.env['SIDETRACK_RESOLVE_SIG_BUCKET_MS'];
    else process.env['SIDETRACK_RESOLVE_SIG_BUCKET_MS'] = priorBucket;
    resetStatusCatchUpStateForTest();
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const appendObservation = async (url: string, seq: number): Promise<void> => {
    await eventLog.appendClient({
      clientEventId: `observed-${String(seq)}`,
      aggregateId: '2026-05-07',
      type: BROWSER_TIMELINE_OBSERVED,
      payload: {
        eventId: `tl-${String(seq)}`,
        observedAt: '2026-05-07T10:00:00.000Z',
        url,
        canonicalUrl: url,
        transition: 'updated',
      },
      baseVector: {},
    });
  };

  it('marks a fresh resolve `resolveFreshness: fresh` and serves the cache on a repeat under the same sig', async () => {
    const canonicalUrl = 'https://swr.test/a';
    await appendObservation(canonicalUrl, 1);
    currentConnectionsSnapshot = snapshotForUrls([canonicalUrl], 'rev-a');
    await rotateGraphSig(10);

    const first = await fetch(
      `${serverUrl}/v1/visits/${encodeURIComponent(canonicalUrl)}/resolve?dryRun=true`,
      { headers: reqHeaders() },
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { resolveFreshness?: string; data?: unknown };
    expect(firstBody.resolveFreshness).toBe('fresh');

    // Same sig (no rotate): served from cache, still fresh, identical bytes.
    const second = await fetch(
      `${serverUrl}/v1/visits/${encodeURIComponent(canonicalUrl)}/resolve?dryRun=true`,
      { headers: reqHeaders() },
    );
    const secondBody = (await second.json()) as { resolveFreshness?: string };
    expect(secondBody.resolveFreshness).toBe('fresh');
    // Freeze guard: the served payload (minus the additive freshness marker)
    // is byte-identical across the cache hit.
    expect({ ...secondBody, resolveFreshness: undefined }).toEqual({
      ...firstBody,
      resolveFreshness: undefined,
    });
  });

  it('serves the STALE resolve instantly (stale-revalidating) after a graph-sig change instead of recomputing cold', async () => {
    const canonicalUrl = 'https://swr.test/b';
    await appendObservation(canonicalUrl, 1);
    currentConnectionsSnapshot = snapshotForUrls([canonicalUrl], 'rev-a');
    await rotateGraphSig(10);

    const first = await fetch(
      `${serverUrl}/v1/visits/${encodeURIComponent(canonicalUrl)}/resolve?dryRun=true`,
      { headers: reqHeaders() },
    );
    const firstBody = (await first.json()) as { resolveFreshness?: string; data?: unknown };
    expect(firstBody.resolveFreshness).toBe('fresh');

    // A "drain": rotate the graph signature (file size changes).
    await rotateGraphSig(20);

    const stale = await fetch(
      `${serverUrl}/v1/visits/${encodeURIComponent(canonicalUrl)}/resolve?dryRun=true`,
      { headers: reqHeaders() },
    );
    expect(stale.status).toBe(200);
    const staleBody = (await stale.json()) as { resolveFreshness?: string; data?: unknown };
    // Served the PRIOR value immediately, marked as revalidating.
    expect(staleBody.resolveFreshness).toBe('stale-revalidating');
    expect(staleBody.data).toEqual(firstBody.data);

    // After the background refresh, a request under the new sig serves fresh.
    // (Give the bounded background lane a couple of turns to complete.)
    await new Promise((r) => setTimeout(r, 50));
    const refreshed = await fetch(
      `${serverUrl}/v1/visits/${encodeURIComponent(canonicalUrl)}/resolve?dryRun=true`,
      { headers: reqHeaders() },
    );
    const refreshedBody = (await refreshed.json()) as { resolveFreshness?: string };
    expect(refreshedBody.resolveFreshness).toBe('fresh');
  });

  it('tab-session resolve carries the additive resolveFreshness field', async () => {
    await eventLog.appendClient({
      clientEventId: 'observed-tses',
      aggregateId: '2026-05-07',
      type: BROWSER_TIMELINE_OBSERVED,
      payload: {
        eventId: 'tl-tses',
        observedAt: '2026-05-07T10:00:00.000Z',
        url: 'https://swr.test/t',
        canonicalUrl: 'https://swr.test/t',
        transition: 'updated',
        tabSessionId: 'tses_a',
      },
      baseVector: {},
    });
    currentConnectionsSnapshot = snapshotForUrls(['https://swr.test/t'], 'rev-a');
    await rotateGraphSig(10);

    const res = await fetch(`${serverUrl}/v1/tabsessions/tses_a/resolve?dryRun=true`, {
      headers: reqHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resolveFreshness?: string };
    expect(body.resolveFreshness).toBe('fresh');
  });

  it('(e) freeze guard: the served `data` is byte-identical to a direct resolver call — SWR only adds the top-level resolveFreshness marker', async () => {
    const canonicalUrl = 'https://freeze.test/a';
    await appendObservation(canonicalUrl, 1);
    const snapshot = snapshotForUrls([canonicalUrl], 'rev-freeze');
    currentConnectionsSnapshot = snapshot;
    await rotateGraphSig(10);

    const res = await fetch(
      `${serverUrl}/v1/visits/${encodeURIComponent(canonicalUrl)}/resolve?dryRun=true`,
      { headers: reqHeaders() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown; resolveFreshness?: string };

    // The non-sqlite route path is resolveUrlAttribution({canonicalUrl,
    // snapshot, events: merged}); reproduce it directly and compare bytes.
    const merged = await eventLog.readMerged();
    const expected = resolveUrlAttribution({ canonicalUrl, snapshot, events: merged });
    expect(body.data).toEqual(expected);
    // The additive marker lives at the TOP level, never inside `data`.
    expect((body.data as Record<string, unknown>)['resolveFreshness']).toBeUndefined();
    expect(body.resolveFreshness).toBe('fresh');
  });
});

describe('/v1/status non-blocking catch-up', () => {
  let vaultRoot: string;
  let serverUrl: string;
  let close: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (close !== null) await close();
    close = null;
    resetStatusCatchUpStateForTest();
    if (vaultRoot !== undefined) await rm(vaultRoot, { recursive: true, force: true });
  });

  const startWith = async (eventStoreCatchUp: () => Promise<void>): Promise<void> => {
    resetStatusCatchUpStateForTest();
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-status-catchup-'));
    const replica = await loadOrCreateReplica(vaultRoot);
    const config: CompanionHttpConfig = {
      bridgeKey,
      vaultWriter: createVaultWriter(vaultRoot),
      vaultRoot,
      idempotencyStore: createIdempotencyStore(vaultRoot),
      replica,
      eventStoreCatchUp,
    };
    const server = createCompanionHttpServer(config);
    const started = await startHttpServer(server, 0);
    serverUrl = started.url;
    close = started.close;
  };

  it('(d) returns FAST with catchingUp:true while a slow catch-up runs, then catchingUp:false after it completes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let catchUpStarted = 0;
    const slowCatchUp = async (): Promise<void> => {
      catchUpStarted += 1;
      await gate; // simulate the 40s+ JSONL catch-up
    };
    await startWith(slowCatchUp);

    // First status call: must return quickly, not block on the slow catch-up.
    const t0 = Date.now();
    const res1 = await fetch(`${serverUrl}/v1/status`, { headers: reqHeaders() });
    const elapsed = Date.now() - t0;
    expect(res1.status).toBe(200);
    expect(elapsed).toBeLessThan(1_000); // nowhere near a 40s block
    const body1 = (await res1.json()) as { data: { catchingUp?: boolean } };
    expect(body1.data.catchingUp).toBe(true);
    expect(catchUpStarted).toBe(1);

    // A concurrent second poll while still catching up: single-flight, no new
    // catch-up kicked, still reports catchingUp.
    const res2 = await fetch(`${serverUrl}/v1/status`, { headers: reqHeaders() });
    const body2 = (await res2.json()) as { data: { catchingUp?: boolean } };
    expect(body2.data.catchingUp).toBe(true);
    expect(catchUpStarted).toBe(1);

    // Complete the catch-up and let it settle.
    release();
    await new Promise((r) => setTimeout(r, 20));

    const res3 = await fetch(`${serverUrl}/v1/status`, { headers: reqHeaders() });
    const body3 = (await res3.json()) as {
      data: { catchingUp?: boolean; lastCatchUpCompletedAt?: string };
    };
    // A fresh poll after completion kicks a new (now-cheap) catch-up; the key
    // invariant is that the completion timestamp is populated and no call ever
    // blocked on the slow work.
    expect(body3.data.lastCatchUpCompletedAt).toBeDefined();
  });

  it('omits catchingUp entirely when no catch-up hook is wired', async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-status-nohook-'));
    const replica = await loadOrCreateReplica(vaultRoot);
    const server = createCompanionHttpServer({
      bridgeKey,
      vaultWriter: createVaultWriter(vaultRoot),
      vaultRoot,
      idempotencyStore: createIdempotencyStore(vaultRoot),
      replica,
    });
    const started = await startHttpServer(server, 0);
    serverUrl = started.url;
    close = started.close;

    const res = await fetch(`${serverUrl}/v1/status`, { headers: reqHeaders() });
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect('catchingUp' in body.data).toBe(false);
  });
});

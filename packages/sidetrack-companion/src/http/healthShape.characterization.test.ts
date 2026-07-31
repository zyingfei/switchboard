// Stage S1 (strict-discipline refactor safety net) — PIN the TOP-LEVEL KEY
// SET of GET /v1/system/health's `data` object before the health assembly
// code (currently inline in server.ts, ~line 6217 on) moves anywhere.
//
// /v1/system/health is the wire contract the side panel's Health view, the
// menu-bar app, and `SIDETRACK_HTTP_LOG`-era debugging all read against —
// none of them import server.ts, they only know the JSON shape. A route
// extraction that renames a section (`workGraph` → `workgraph`), forgets to
// re-spread one (`sync` silently dropped because the extracted function
// closed over the wrong `context`), or nests something one level deeper is
// invisible to `tsc` (the route handler's return type is `Promise<readonly
// [number, unknown]>` — deliberately untyped past that point) and invisible
// to a human diff unless they already know to look for it. This test is
// that look.
//
// Presence/absence is what's pinned, not order or values: the key list is
// SORTED before comparison, and the values themselves (timestamps, byte
// counts, live process state) are expected to churn between runs — pinning
// them would make this test flaky for reasons that have nothing to do with
// the wire contract breaking.
//
// The literal list below is GENERATED, not hand-typed: booted the same
// harness this test boots, hit the route, printed `Object.keys(data).sort()`
// one key per line, then pasted the output verbatim.
//
// Harness pattern copied from enrichmentRetractRoute.test.ts
// (createCompanionHttpServer + startHttpServer + x-bac-bridge-key), which
// is the minimal wiring this route needs — no connectionsStore, no sync
// transport, no collector framework. That minimality is deliberate: it's
// the same floor every other route test in this directory starts from, so
// the pinned key set reflects what the route guarantees unconditionally,
// not what it does when every optional subsystem happens to be wired.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEventLog, type EventLog } from '../sync/eventLog.js';
import {
  incrementSkippedMalformedLines,
  resetEventLaneHealthForTests,
} from '../sync/eventLaneHealth.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import {
  RSS_WARN_BYTES,
  createResourceReadinessWatchdog,
  type ResourceReadinessWatchdog,
} from '../system/resourceReadinessWatchdog.js';
import { createVaultWriter } from '../vault/writer.js';
import { createIdempotencyStore } from './idempotency.js';
import { createCompanionHttpServer, startHttpServer } from './server.js';

describe('GET /v1/system/health shape characterization (stage S1 pin)', () => {
  let vaultRoot: string;
  let serverUrl: string;
  let eventLog: EventLog;
  let resourceWatchdog: ResourceReadinessWatchdog;
  let nowMs: number;
  let rssBytes: number;
  let close: (() => Promise<void>) | null = null;
  const bridgeKey = 'health-shape-bridge-key';
  let previousEventStoreFlag: string | undefined;

  beforeEach(async () => {
    previousEventStoreFlag = process.env['SIDETRACK_EVENT_STORE'];
    delete process.env['SIDETRACK_EVENT_STORE'];
    resetEventLaneHealthForTests();
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-health-shape-http-'));
    const replica = await loadOrCreateReplica(vaultRoot);
    eventLog = createEventLog(vaultRoot, replica);
    nowMs = Date.parse('2026-07-31T12:00:00.000Z');
    rssBytes = 512 * 1024 * 1024;
    resourceWatchdog = createResourceReadinessWatchdog({
      bootStartedAtMs: nowMs,
      nowMs: () => nowMs,
      readRssBytes: () => rssBytes,
    });
    nowMs += 9_000;
    resourceWatchdog.recordBootPhase('runtime');
    nowMs += 500;
    resourceWatchdog.markServing();
    const server = createCompanionHttpServer({
      bridgeKey,
      vaultWriter: createVaultWriter(vaultRoot),
      vaultRoot,
      idempotencyStore: createIdempotencyStore(vaultRoot),
      replica,
      eventLog,
      getResourceReadinessWatchdogs: resourceWatchdog.snapshot,
    });
    const started = await startHttpServer(server, 0);
    serverUrl = started.url;
    close = started.close;
  });

  afterEach(async () => {
    if (close !== null) await close();
    close = null;
    resetEventLaneHealthForTests();
    if (previousEventStoreFlag === undefined) delete process.env['SIDETRACK_EVENT_STORE'];
    else process.env['SIDETRACK_EVENT_STORE'] = previousEventStoreFlag;
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('pins the sorted top-level data key set', async () => {
    const response = await fetch(`${serverUrl}/v1/system/health`, {
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': bridgeKey },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data?: Record<string, unknown> };
    const keys = Object.keys(body.data ?? {}).sort();
    expect(keys).toEqual([
      'capture',
      'dataLoss',
      'engagementLane',
      'laneCalibration',
      'observability',
      'recall',
      'reliability',
      'service',
      'sync',
      'uptimeSec',
      'vault',
      'watchdogs',
      'workGraph',
    ]);
  });

  it('reads watchdog warning and recovery transitions back through the real route', async () => {
    rssBytes = RSS_WARN_BYTES;
    nowMs += 1_000;
    const warningResponse = await fetch(`${serverUrl}/v1/system/health`, {
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': bridgeKey },
    });
    const warning = (await warningResponse.json()) as {
      readonly data?: {
        readonly watchdogs?: {
          readonly rss?: Record<string, unknown>;
          readonly bootToServing?: Record<string, unknown>;
        };
        readonly observability?: {
          readonly status?: string;
          readonly sections?: Record<string, string>;
        };
      };
    };
    expect(warningResponse.status).toBe(200);
    expect(warning.data?.watchdogs?.rss).toMatchObject({
      status: 'warning',
      warnAtBytes: RSS_WARN_BYTES,
      currentBytes: RSS_WARN_BYTES,
      growthBytes: RSS_WARN_BYTES - 512 * 1024 * 1024,
      lastTransition: 'initialized',
    });
    expect(warning.data?.watchdogs?.bootToServing).toMatchObject({
      status: 'ok',
      budgetMs: 10_000,
      elapsedMs: 9_500,
      slowestPhase: 'runtime',
    });
    expect(warning.data?.observability?.sections).toMatchObject({
      rss: 'stale',
      bootToServing: 'ok',
    });
    expect(warning.data?.observability?.status).toBe('degraded');

    rssBytes = 1_024 * 1024 * 1_024;
    nowMs += 1_000;
    const recoveryResponse = await fetch(`${serverUrl}/v1/system/health`, {
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': bridgeKey },
    });
    const recovery = (await recoveryResponse.json()) as {
      readonly data?: {
        readonly watchdogs?: { readonly rss?: Record<string, unknown> };
        readonly observability?: { readonly sections?: Record<string, string> };
      };
    };
    expect(recovery.data?.watchdogs?.rss).toMatchObject({
      status: 'ok',
      currentBytes: 1_024 * 1_024 * 1_024,
      lastTransition: 'recovered',
    });
    expect(recovery.data?.observability?.sections?.['rss']).toBe('ok');
  });

  it('decays a cached dataLoss warning after a clean current reconciliation read-back', async () => {
    incrementSkippedMalformedLines();
    const warningResponse = await fetch(`${serverUrl}/v1/system/health`, {
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': bridgeKey },
    });
    const warning = (await warningResponse.json()) as {
      readonly data?: {
        readonly dataLoss?: Record<string, unknown>;
        readonly observability?: {
          readonly status?: string;
          readonly sections?: Record<string, string>;
        };
      };
    };
    expect(warning.data?.dataLoss).toMatchObject({
      state: 'warning',
      clean: false,
      counters: { skippedMalformedLines: 1 },
      reconciliation: null,
    });
    expect(warning.data?.observability?.sections?.['dataLoss']).toBe('stale');
    expect(warning.data?.observability?.status).toBe('failed');

    // The base report above remains cached for 60 seconds. Enabling the
    // current store creates an empty, converged mirror; only the live registry
    // contributor can observe this immediately and re-touch the cached row.
    process.env['SIDETRACK_EVENT_STORE'] = '1';
    const recoveredResponse = await fetch(`${serverUrl}/v1/system/health`, {
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': bridgeKey },
    });
    const recovered = (await recoveredResponse.json()) as {
      readonly data?: {
        readonly dataLoss?: Record<string, unknown>;
        readonly observability?: {
          readonly status?: string;
          readonly sections?: Record<string, string>;
        };
      };
    };
    expect(recovered.data?.dataLoss).toMatchObject({
      state: 'recovered',
      clean: true,
      counters: { skippedMalformedLines: 1 },
      reconciliation: { storeRowCount: 0, expectedFromWatermark: 0, delta: 0 },
    });
    expect(recovered.data?.observability?.sections?.['dataLoss']).toBe('ok');
    expect(recovered.data?.observability?.status).toBe('ok');
  });
});

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
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { createVaultWriter } from '../vault/writer.js';
import { createIdempotencyStore } from './idempotency.js';
import { createCompanionHttpServer, startHttpServer } from './server.js';

describe('GET /v1/system/health shape characterization (stage S1 pin)', () => {
  let vaultRoot: string;
  let serverUrl: string;
  let eventLog: EventLog;
  let close: (() => Promise<void>) | null = null;
  const bridgeKey = 'health-shape-bridge-key';

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-health-shape-http-'));
    const replica = await loadOrCreateReplica(vaultRoot);
    eventLog = createEventLog(vaultRoot, replica);
    const server = createCompanionHttpServer({
      bridgeKey,
      vaultWriter: createVaultWriter(vaultRoot),
      vaultRoot,
      idempotencyStore: createIdempotencyStore(vaultRoot),
      replica,
      eventLog,
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
      'workGraph',
    ]);
  });
});

// Stage S1 (strict-discipline refactor safety net) — PIN the PER-RESULT KEY
// SET of POST /v1/visits/batch-resolve, and the fixed lane order inside it,
// before the resolver core (currently inline in server.ts) moves anywhere.
//
// This is the panel's highest-traffic wire contract: every result in
// `data.results[canonicalUrl]` is a `UrlResolutionResult`
// (tabsession/resolver.ts), and the panel destructures `decision`,
// `fusedCandidates`, `reasons`, and `lanes` directly off it with no runtime
// validation on the client side — a TypeScript interface is not a wire
// check, and this route in particular has a documented history of
// perf-driven rewrites (see the "BREATHE BETWEEN URLS" comment a few
// hundred lines into the batch-resolve handler) that are exactly the kind
// of change that could accidentally rename or drop a field while chasing a
// stall fix. `lanes` gets its own assertion beyond plain key presence
// because its order is ALSO contractual: SIDETRACK_GUESS_LANES documents
// "ALWAYS all six lanes in the fixed GUESS_LANE_ORDER" for the base lanes,
// plus the query-time additions (content = lane 7, ai = lane 8, prototype =
// lane 9) appended after — the panel's lane-disclosure UI renders lanes
// positionally, so a reorder is a silent UI bug, not a crash.
//
// The literal lists below are GENERATED, not hand-typed: booted the same
// harness this test boots, resolved one synthetic URL, printed
// `Object.keys(oneResult).sort()` and `oneResult.lanes.map(l => l.lane)`,
// then pasted the output verbatim.
//
// Fixture wiring copied from visitsRoutes.test.ts's "per-URL HTTP routes —
// resolver cache and batch resolve" describe block: a connectionsStore
// mock built on `SqliteConnectionsStore.prototype` (the route branches on
// `instanceof SqliteConnectionsStore` to pick its resolver-cache/SWR path)
// carrying one node for the target URL and no edges — the minimum the
// route needs to return 200 with a real (if entirely empty) per-lane
// breakdown instead of a 503/409.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConnectionsSnapshot, ConnectionsStore } from '../connections/snapshot.js';
import { SqliteConnectionsStore } from '../connections/snapshot.js';
import { createEventLog, type EventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { createVaultWriter } from '../vault/writer.js';
import { createIdempotencyStore } from './idempotency.js';
import { createCompanionHttpServer, startHttpServer } from './server.js';

describe('POST /v1/visits/batch-resolve shape characterization (stage S1 pin)', () => {
  let vaultRoot: string;
  let serverUrl: string;
  let eventLog: EventLog;
  let connectionsStore: SqliteConnectionsStore;
  let close: (() => Promise<void>) | null = null;
  const bridgeKey = 'batch-resolve-shape-bridge-key';

  const CANONICAL_URL = 'https://s1-pin.test/page';

  const snapshotForUrl = (canonicalUrl: string, revision: string): ConnectionsSnapshot => ({
    scope: {},
    nodes: [
      {
        id: `timeline-visit:${canonicalUrl}`,
        kind: 'timeline-visit',
        label: canonicalUrl,
        originReplicaIds: [],
        metadata: { canonicalUrl },
      },
    ],
    edges: [],
    updatedAt: '2026-05-07T10:00:00.000Z',
    nodeCount: 1,
    edgeCount: 0,
    snapshotRevision: revision,
  });

  // Same minimal resolver-cache-store shape as visitsRoutes.test.ts's
  // createResolverCacheStore — built on SqliteConnectionsStore.prototype so
  // the route's `instanceof SqliteConnectionsStore` branch (resolver
  // cache + SWR path) is the one under test, not the plain-ConnectionsStore
  // fallback.
  const createMinimalSqliteConnectionsStore = (): SqliteConnectionsStore => {
    let current: ConnectionsSnapshot | null = null;
    const cache = new Map<string, unknown>();
    return Object.assign(Object.create(SqliteConnectionsStore.prototype), {
      putCurrent: async (snapshot: ConnectionsSnapshot) => {
        current = snapshot;
      },
      readCurrent: async () => current,
      readResolverSubgraphForUrl: async () => current,
      readResolverSubgraphForUrls: async () => current,
      readSnapshotMetadata: async () =>
        current === null
          ? null
          : {
              scope: current.scope,
              updatedAt: current.updatedAt,
              nodeCount: current.nodeCount,
              edgeCount: current.edgeCount,
              ...(current.snapshotRevision === undefined
                ? {}
                : { snapshotRevision: current.snapshotRevision }),
            },
      cacheResolverResult: async (visitId: string, snapshotRevision: string, result: unknown) => {
        cache.set(`${visitId}\0${snapshotRevision}`, result);
      },
      getCachedResolverResult: async (visitId: string, snapshotRevision: string) =>
        cache.get(`${visitId}\0${snapshotRevision}`) ?? null,
      writeSnapshotAndProgress: async (snapshot: ConnectionsSnapshot) => {
        current = snapshot;
      },
      readMaterializerProgress: async () => null,
      putDay: async () => undefined,
      readDay: async () => null,
      listDays: async () => [],
      close: () => undefined,
    }) as unknown as SqliteConnectionsStore;
  };

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-batch-resolve-shape-http-'));
    const replica = await loadOrCreateReplica(vaultRoot);
    eventLog = createEventLog(vaultRoot, replica);
    connectionsStore = createMinimalSqliteConnectionsStore();
    const server = createCompanionHttpServer({
      bridgeKey,
      vaultWriter: createVaultWriter(vaultRoot),
      vaultRoot,
      idempotencyStore: createIdempotencyStore(vaultRoot),
      replica,
      eventLog,
      connectionsStore: connectionsStore as unknown as ConnectionsStore,
    });
    const started = await startHttpServer(server, 0);
    serverUrl = started.url;
    close = started.close;
  });

  afterEach(async () => {
    if (close !== null) await close();
    close = null;
    connectionsStore.close();
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('pins the sorted per-result key set and the fixed lane order', async () => {
    await connectionsStore.putCurrent(snapshotForUrl(CANONICAL_URL, 'rev-s1-pin'));

    const response = await fetch(`${serverUrl}/v1/visits/batch-resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': bridgeKey },
      body: JSON.stringify({ canonicalUrls: [CANONICAL_URL] }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { results: Record<string, Record<string, unknown>> };
    };
    const oneResult = body.data.results[CANONICAL_URL];
    expect(oneResult).toBeDefined();

    const resultKeys = Object.keys(oneResult ?? {}).sort();
    expect(resultKeys).toEqual([
      'canonicalUrl',
      'decision',
      'dryRun',
      'fusedCandidates',
      'lanes',
      'policyMode',
      'reasons',
    ]);

    const lanes = oneResult?.['lanes'] as readonly { readonly lane: string }[] | undefined;
    expect(Array.isArray(lanes)).toBe(true);
    expect((lanes ?? []).map((lane) => lane.lane)).toEqual([
      'graph',
      'similarity',
      'topic',
      'title',
      'domain',
      'recency',
      'content',
      'ai',
      'prototype',
    ]);
  });
});

// Route-level integration test — proves the prototype lane v2 wiring
// (docs/plans/2026-08-16-category-flexibility-hyde.md §11) is actually LIVE
// through the real HTTP call site, not just unit-tested on the modules.
//
// WHY THIS FILE EXISTS. workstreams/prototypeKeywordLaneLookup.ts,
// prototypeKeywordProfile.ts, and tabsession/prototypeLane.ts all already
// have thorough unit coverage that calls buildPrototypeLane/
// appendPrototypeLane DIRECTLY with hand-built pageConceptIds/canonicalUrl/
// vaultRoot inputs — that proves the LANE'S OWN logic is correct, but says
// nothing about whether http/server.ts's finalizeBatchResolveResults call
// site actually THREADS those request-scoped values down to it. This test
// goes through the real `POST /v1/visits/batch-resolve` route (a real
// in-process HTTP server, the same createCompanionHttpServer/startHttpServer
// harness batchResolveShape.characterization.test.ts uses for the
// sqlite-store resolve path) and asserts on THREE things that can only be
// true if the wiring is live end to end:
//   1. The keyword blend is applied — the served 'prototype' lane candidate's
//      `why` string names the matched concept ("matches duckdb..."), which
//      requires pageConceptIds to have reached buildPrototypeLane from a
//      REAL peekPrototypeKeywordConceptIds(vaultRoot, canonicalUrl) call
//      inside the route handler, not a test-injected value.
//   2. A per-source ('prototype:medoid' / 'prototype:keyword') prequential
//      prediction lands in the REAL lane-prequential.jsonl file on disk,
//      which requires the route to have passed the REAL canonicalUrl and
//      vaultRoot into appendPrototypeLane's deps.
//   3. Both of the above happen from data seeded through the SAME shared
//      module-level caches (recall-v2/pipeline.ts's storeCache,
//      prototypeKeywordLaneLookup.ts's cache) the production route reads —
//      not a mocked store injected into the route's own dependency graph.

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConnectionsSnapshot } from '../connections/snapshot.js';
import { SqliteConnectionsStore } from '../connections/snapshot.js';
import { createEventLog, type EventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { createVaultWriter } from '../vault/writer.js';
import { createIdempotencyStore } from './idempotency.js';
import { createCompanionHttpServer, startHttpServer } from './server.js';
// MUST be imported before any `new Database(...)` runs anywhere in this
// process (bun:sqlite's setCustomSQLite can only be called once) — same
// precedent as recall-v2/store/canonical-vectors.test.ts and
// host-purge.test.ts. Without this, sqlite-vec never loads when this file
// is run standalone (only when a suite run happens to load one of those
// other two files first) and every vector-backed lane reports "vector
// backend unavailable" regardless of any seeded data.
import { installCustomSqlite } from '../recall-v2/store/setup-sqlite.js';
import { peekRecallV2Store, warmRecallV2Store } from '../recall-v2/pipeline.js';
import { embed } from '../recall/embedder.js';
import type { PrototypeStore } from '../workstreams/prototypeGeneration.js';
import { createKeywordIndexStore } from '../search-index/keywordIndexStore.js';
import { createKeywordConceptStore } from '../enrichment/keywordConceptStore.js';
import { resetPrototypeKeywordLaneLookupForTest } from '../workstreams/prototypeKeywordLaneLookup.js';
import { lanePrequentialPath, type LanePredictionRecord } from '../tabsession/lanePrequential.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

const CANONICAL_URL = 'https://s11-wire.test/duckdb';
const PAGE_TITLE = 'duckdb olap analytics';
const WORKSTREAM_ID = 'ws-duckdb';

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
  updatedAt: '2026-08-17T10:00:00.000Z',
  nodeCount: 1,
  edgeCount: 0,
  snapshotRevision: revision,
});

// Same minimal SqliteConnectionsStore shape batchResolveShape.
// characterization.test.ts uses to exercise the sqlite-store resolve path
// (`instanceof SqliteConnectionsStore` branch — call site 1 of
// finalizeBatchResolveResults) without a real sqlite-backed connections
// store.
const createMinimalSqliteConnectionsStore = (): SqliteConnectionsStore => {
  let current: ConnectionsSnapshot | null = null;
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
            ...(current.snapshotRevision === undefined ? {} : { snapshotRevision: current.snapshotRevision }),
          },
    cacheResolverResult: async () => undefined,
    getCachedResolverResult: async () => null,
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

describe('POST /v1/visits/batch-resolve — prototype lane v2 wiring (integration)', () => {
  let vaultRoot: string;
  let serverUrl: string;
  let eventLog: EventLog;
  let connectionsStore: SqliteConnectionsStore;
  let close: (() => Promise<void>) | null = null;
  const bridgeKey = 'prototype-wiring-bridge-key';
  let priorTestEmbedder: string | undefined;

  beforeEach(async () => {
    installCustomSqlite();
    priorTestEmbedder = process.env['SIDETRACK_TEST_EMBEDDER'];
    // Deterministic, fast, no-ONNX embedder for both the seeded prototype
    // vector and the live query embed — see recall/embedder.ts's header.
    process.env['SIDETRACK_TEST_EMBEDDER'] = '1';
    resetPrototypeKeywordLaneLookupForTest();
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-prototype-wiring-'));
    await mkdir(join(vaultRoot, '_BAC', 'connections'), { recursive: true });
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
      connectionsStore,
      // 'disabled' = no separate embedder SIDECAR process; embedding runs
      // in-process — the exact state buildContentLaneDeps's
      // `embedderUsable = state === 'ready' || state === 'disabled'` check
      // treats as usable. No prior test exercised this seam; it is the
      // documented, intended one (routeSupport.ts's CompanionHttpConfig).
      getEmbedderStatus: () => ({ state: 'disabled' as const }),
    });
    const started = await startHttpServer(server, 0);
    serverUrl = started.url;
    close = started.close;
  });

  afterEach(async () => {
    if (close !== null) await close();
    close = null;
    connectionsStore.close();
    resetPrototypeKeywordLaneLookupForTest();
    if (priorTestEmbedder === undefined) delete process.env['SIDETRACK_TEST_EMBEDDER'];
    else process.env['SIDETRACK_TEST_EMBEDDER'] = priorTestEmbedder;
    await rm(vaultRoot, { recursive: true, force: true });
  });

  sqliteIt(
    'threads canonicalUrl/vaultRoot/pageConceptIds from the real route into the lane: keyword blend in the served why-string AND a per-source counter on disk',
    async () => {
      // ---- seed the keyword-concept layer (the SAME files
      // prototypeKeywordLaneLookup.ts's warmPrototypeKeywordLayer opens) ----
      const indexStore = await createKeywordIndexStore(vaultRoot);
      indexStore.upsertPageKeywords(`url:${CANONICAL_URL}`, ['duckdb'], 'deterministic', Date.now());
      indexStore.close();
      const conceptStore = await createKeywordConceptStore(vaultRoot);
      const { conceptId } = conceptStore.assignKeyword('duckdb', new Float32Array([1, 0, 0]), Date.now());
      conceptStore.close();

      // ---- seed the recall-v2 store (the SAME module-level singleton
      // buildContentLaneDeps/prototypeLaneDepsFromContent read via
      // peekRecallV2Store) with a medoid prototype AND a keyword profile
      // for the target workstream ----
      warmRecallV2Store(vaultRoot);
      let store: PrototypeStore | undefined;
      for (let attempt = 0; attempt < 50 && store === undefined; attempt += 1) {
        store = (await peekRecallV2Store(vaultRoot)) as PrototypeStore | undefined;
        if (store === undefined) await new Promise((r) => setTimeout(r, 20));
      }
      expect(store).toBeDefined();
      if (store === undefined) throw new Error('unreachable — asserted above');

      // The query text buildPrototypeLane computes is `${gist} ${title}`.trim()
      // with no gist ⇒ exactly PAGE_TITLE. Embedding that SAME text here
      // (through the SAME deterministic test embedder) gives the prototype
      // vector a guaranteed cosine similarity of 1.0 against the live query
      // — no fragile "close enough" tuning.
      const [vec] = await embed([PAGE_TITLE]);
      expect(vec).toBeDefined();
      expect(store.vectorBackendAvailable).toBe(true);
      store.upsertPrototype(
        {
          prototypeId: `${WORKSTREAM_ID}:wiring-test:0`,
          workstreamId: WORKSTREAM_ID,
          generatedText: PAGE_TITLE,
          generatorModelId: 'medoid-selection#v2',
          method: 'selected',
          generatedAt: Date.now(),
          evidenceWatermark: '1:wiring-test',
          angle: 'medoid',
          sourceMemberUrl: 'https://source.test/original-page',
        },
        vec!,
      );
      store.replacePrototypeKeywordProfiles?.(
        new Map([[conceptId, 1.5]]),
        new Map([
          [
            WORKSTREAM_ID,
            {
              weights: new Map([[conceptId, 3]]),
              displayKeyword: new Map([[conceptId, 'duckdb']]),
            },
          ],
        ]),
      );

      // ---- exercise the REAL route ----
      await connectionsStore.putCurrent(snapshotForUrl(CANONICAL_URL, 'rev-wiring-1'));

      const response = await fetch(`${serverUrl}/v1/visits/batch-resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bac-bridge-key': bridgeKey },
        body: JSON.stringify({
          canonicalUrls: [CANONICAL_URL],
          titleHints: { [CANONICAL_URL]: PAGE_TITLE },
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: { results: Record<string, { lanes?: readonly { lane: string; candidates: readonly { workstreamId: string; score: number; why: string }[] }[] }> };
      };
      const result = body.data.results[CANONICAL_URL];
      expect(result).toBeDefined();
      const prototypeLane = result?.lanes?.find((l) => l.lane === 'prototype');
      expect(prototypeLane).toBeDefined();
      expect(prototypeLane?.candidates.length).toBeGreaterThan(0);
      const top = prototypeLane?.candidates[0];
      expect(top?.workstreamId).toBe(WORKSTREAM_ID);
      // KEYWORD BLEND PROOF: this string can only appear if pageConceptIds
      // reached buildPrototypeLane through the real
      // peekPrototypeKeywordConceptIds(vaultRoot, canonicalUrl) call the
      // route makes — a hand-built unit test could fake this, an HTTP
      // response computed by the real route handler cannot.
      expect(top?.why).toContain("matches duckdb from this workstream's pages");

      // ---- PER-SOURCE COUNTER PROOF: read the REAL lane-prequential.jsonl
      // the route's own appendPrototypeLane call wrote to, using the REAL
      // canonicalUrl/vaultRoot the route threaded in ----
      const raw = await readFile(lanePrequentialPath(vaultRoot), 'utf8');
      const records = raw
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as LanePredictionRecord);
      const byLane = new Map(records.map((r) => [r.l, r]));
      const medoidRecord = byLane.get('prototype:medoid');
      const keywordRecord = byLane.get('prototype:keyword');
      expect(medoidRecord?.w).toBe(WORKSTREAM_ID);
      expect(medoidRecord?.u).toBe(CANONICAL_URL);
      expect(keywordRecord?.w).toBe(WORKSTREAM_ID);
      expect(keywordRecord?.u).toBe(CANONICAL_URL);
    },
  );
});

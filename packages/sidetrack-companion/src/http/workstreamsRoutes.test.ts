import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConnectionsSnapshot, ConnectionsStore } from '../connections/snapshot.js';
import { setAppleFmProbeForTest } from '../enrichment/appleFmEngine.js';
import { createEventLog, type EventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { createVaultWriter } from '../vault/writer.js';
import { createSuggestionCandidateStore } from '../workstreams/suggestionCandidateStore.js';
import { recomputeSuggestionCandidates } from '../workstreams/splitSuggestionEngine.js';
import { createIdempotencyStore } from './idempotency.js';
import { createCompanionHttpServer, startHttpServer } from './server.js';

describe('workstreams routes — UI-visibility phase', () => {
  let vaultRoot: string;
  let serverUrl: string;
  let eventLog: EventLog;
  let currentConnectionsSnapshot: ConnectionsSnapshot | null = null;
  let close: (() => Promise<void>) | null = null;
  const bridgeKey = 'workstreams-bridge-key';

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-workstreams-http-'));
    await mkdir(join(vaultRoot, '_BAC', 'connections'), { recursive: true });
    // Tests must never depend on whether `apfel --serve` happens to be
    // running on the machine executing them (appleFmEngine.ts's own
    // header note) — force a deterministic "unavailable" probe.
    setAppleFmProbeForTest(async () => ({
      available: false,
      contextTokens: 0,
      modelId: 'apple-fm-test',
      reason: 'not-running',
    }));
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
    };
    const server = createCompanionHttpServer({
      bridgeKey,
      vaultWriter: createVaultWriter(vaultRoot),
      vaultRoot,
      idempotencyStore: createIdempotencyStore(vaultRoot),
      replica,
      eventLog,
      connectionsStore,
    });
    const started = await startHttpServer(server, 0);
    serverUrl = started.url;
    close = started.close;
  });

  afterEach(async () => {
    if (close !== null) await close();
    close = null;
    setAppleFmProbeForTest(null);
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const headers = (idempotencyKey?: string): Record<string, string> => ({
    'content-type': 'application/json',
    'x-bac-bridge-key': bridgeKey,
    ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
  });

  describe('GET /v1/workstreams/prototypes/status', () => {
    it('reports honestly for a workstream with no evidence store wired and no generation yet: empty statuses list', async () => {
      const response = await fetch(`${serverUrl}/v1/workstreams/prototypes/status`, {
        headers: headers(),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: { statuses: unknown[] } };
      // No WORKSTREAM_PROTOTYPE_GENERATED events and the fake connectionsStore
      // is not a SqliteConnectionsStore (so evidence gathering short-circuits
      // to empty) — nothing to report yet, which is itself the honest answer.
      expect(body.data.statuses).toEqual([]);
    });

    it('surfaces a generated batch by workstreamId with engine/method/prototypeCount', async () => {
      await eventLog.appendClient({
        clientEventId: 'proto-1',
        aggregateId: 'ws_research',
        type: 'workstream.prototype.generated',
        payload: {
          payloadVersion: 1,
          prototypeId: 'proto_a',
          workstreamId: 'ws_research',
          generatedText: 'Notes on kv-cache recommendation systems.',
          embeddingSchemaVersion: 1,
          sourceEvidenceIds: ['https://example.test/a'],
          generatorModelId: 'apple-fm#reason=ok',
          generatedAt: 1_700_000_000_000,
          method: 'generated',
          evidenceWatermark: '5:abc123',
        },
        baseVector: {},
      });

      const response = await fetch(`${serverUrl}/v1/workstreams/prototypes/status`, {
        headers: headers(),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: {
          statuses: {
            workstreamId: string;
            prototypeCount: number;
            method: string;
            engineLabel: string | null;
            whyNot: string | null;
          }[];
        };
      };
      expect(body.data.statuses).toHaveLength(1);
      expect(body.data.statuses[0]).toMatchObject({
        workstreamId: 'ws_research',
        prototypeCount: 1,
        method: 'generated',
        engineLabel: 'Apple Intelligence',
        whyNot: null,
      });
    });

    it('rejects when the event log is unavailable', async () => {
      const noLogServer = createCompanionHttpServer({
        bridgeKey,
        vaultWriter: createVaultWriter(vaultRoot),
        vaultRoot,
        idempotencyStore: createIdempotencyStore(vaultRoot),
        replica: await loadOrCreateReplica(vaultRoot),
      });
      const started = await startHttpServer(noLogServer, 0);
      try {
        const response = await fetch(`${started.url}/v1/workstreams/prototypes/status`, {
          headers: headers(),
        });
        expect(response.status).toBe(503);
      } finally {
        await started.close();
      }
    });
  });

  describe('GET /v1/workstreams/suggestions + POST /v1/workstreams/suggestions/decline', () => {
    it('validates kind', async () => {
      const response = await fetch(`${serverUrl}/v1/workstreams/suggestions?kind=bogus`, {
        headers: headers(),
      });
      expect(response.status).toBe(400);
    });

    it('requires workstreamId when kind=split', async () => {
      const response = await fetch(`${serverUrl}/v1/workstreams/suggestions?kind=split`, {
        headers: headers(),
      });
      expect(response.status).toBe(400);
    });

    it('returns only emitted, non-dismissed split candidates for the given workstream', async () => {
      const store = await createSuggestionCandidateStore(vaultRoot);
      try {
        store.replaceScope('ws_research', 'split', 'rev-1', [
          {
            scopeId: 'ws_research',
            kind: 'split',
            fingerprint: 'a b',
            memberIds: ['a', 'b'],
            consecutiveStableCount: 3,
            emitted: true,
            structuralName: 'kv-cache recsys',
            createdAtMs: 1_000,
            updatedAtMs: 2_000,
            dismissed: false,
            dismissedAtMs: null,
            cohesion: 0,
            externalBest: null,
          },
          {
            scopeId: 'ws_research',
            kind: 'split',
            fingerprint: 'c d',
            memberIds: ['c', 'd'],
            consecutiveStableCount: 1,
            emitted: false,
            structuralName: null,
            createdAtMs: 1_000,
            updatedAtMs: 1_500,
            dismissed: false,
            dismissedAtMs: null,
            cohesion: 0,
            externalBest: null,
          },
        ]);
      } finally {
        store.close();
      }

      const response = await fetch(
        `${serverUrl}/v1/workstreams/suggestions?kind=split&workstreamId=ws_research`,
        { headers: headers() },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: {
          candidates: {
            kind: string;
            scopeId: string;
            fingerprint: string;
            memberCount: number;
            suggestedName: string | null;
          }[];
        };
      };
      expect(body.data.candidates).toHaveLength(1);
      expect(body.data.candidates[0]).toMatchObject({
        kind: 'split',
        scopeId: 'ws_research',
        fingerprint: 'a b',
        memberCount: 2,
        suggestedName: 'kv-cache recsys',
      });
    });

    it('kind=new-category ignores workstreamId and reads the fixed unfiled scope', async () => {
      const store = await createSuggestionCandidateStore(vaultRoot);
      try {
        store.replaceScope('__unfiled__', 'new-category', 'rev-1', [
          {
            scopeId: '__unfiled__',
            kind: 'new-category',
            fingerprint: 'x y z',
            memberIds: ['x', 'y', 'z'],
            consecutiveStableCount: 3,
            emitted: true,
            structuralName: 'weekend reading',
            createdAtMs: 1_000,
            updatedAtMs: 3_000,
            dismissed: false,
            dismissedAtMs: null,
            cohesion: 0,
            externalBest: null,
          },
        ]);
      } finally {
        store.close();
      }

      const response = await fetch(`${serverUrl}/v1/workstreams/suggestions?kind=new-category`, {
        headers: headers(),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: { candidates: { fingerprint: string }[] } };
      expect(body.data.candidates.map((c) => c.fingerprint)).toEqual(['x y z']);
    });

    it(
      'a candidate the engine emits on its liberal-default FIRST computation is immediately ' +
        'visible via GET — no hidden second gate beyond emitted && !dismissed',
      async () => {
        // Real engine call (not a hand-built store row like the tests
        // above) — proves the route's `emitted && !dismissed` filter is the
        // ONLY gate between "the engine decided to surface this" and "the
        // panel can see it." No options.stabilityMinConsecutive passed, so
        // this exercises the actual production default
        // (resolveSuggestionStabilityMinConsecutive() = 1).
        const basis = (index: number, dims = 8): Float32Array => {
          const v = new Float32Array(dims);
          v[index] = 1;
          return v;
        };
        const store = await createSuggestionCandidateStore(vaultRoot);
        try {
          const groupA = Array.from({ length: 4 }, (_, i) => ({
            id: `liberal-a-${i}`,
            embedding: basis(0),
            title: `alpha evidence ${i}`,
          }));
          const groupB = Array.from({ length: 4 }, (_, i) => ({
            id: `liberal-b-${i}`,
            embedding: basis(1),
            title: `beta evidence ${i}`,
          }));
          const result = recomputeSuggestionCandidates(store, {
            scopeId: 'ws_liberal',
            kind: 'split',
            evidence: [...groupA, ...groupB],
            revisionId: 'rev-1',
          });
          expect(result.newlyEmitted.length).toBe(2);
        } finally {
          store.close();
        }

        const response = await fetch(
          `${serverUrl}/v1/workstreams/suggestions?kind=split&workstreamId=ws_liberal`,
          { headers: headers() },
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { data: { candidates: { fingerprint: string }[] } };
        expect(body.data.candidates.length).toBe(2);
      },
    );

    it('decline marks a candidate dismissed, and it stops appearing in the read surface', async () => {
      const store = await createSuggestionCandidateStore(vaultRoot);
      try {
        store.replaceScope('ws_research', 'split', 'rev-1', [
          {
            scopeId: 'ws_research',
            kind: 'split',
            fingerprint: 'a b',
            memberIds: ['a', 'b'],
            consecutiveStableCount: 3,
            emitted: true,
            structuralName: 'kv-cache recsys',
            createdAtMs: 1_000,
            updatedAtMs: 2_000,
            dismissed: false,
            dismissedAtMs: null,
            cohesion: 0,
            externalBest: null,
          },
        ]);
      } finally {
        store.close();
      }

      const decline = await fetch(`${serverUrl}/v1/workstreams/suggestions/decline`, {
        method: 'POST',
        headers: headers('idem-decline-split-1'),
        body: JSON.stringify({ kind: 'split', workstreamId: 'ws_research', fingerprint: 'a b' }),
      });
      expect(decline.status).toBe(201);
      const declineBody = (await decline.json()) as { data: { dismissed: boolean } };
      expect(declineBody.data.dismissed).toBe(true);

      const after = await fetch(
        `${serverUrl}/v1/workstreams/suggestions?kind=split&workstreamId=ws_research`,
        { headers: headers() },
      );
      const afterBody = (await after.json()) as { data: { candidates: unknown[] } };
      expect(afterBody.data.candidates).toEqual([]);
    });

    it('decline requires workstreamId when kind=split', async () => {
      const response = await fetch(`${serverUrl}/v1/workstreams/suggestions/decline`, {
        method: 'POST',
        headers: headers('idem-decline-bad-1'),
        body: JSON.stringify({ kind: 'split', fingerprint: 'a b' }),
      });
      expect(response.status).toBe(400);
    });

    it('decline of an unknown fingerprint is a 201 no-op (dismissed:false)', async () => {
      const response = await fetch(`${serverUrl}/v1/workstreams/suggestions/decline`, {
        method: 'POST',
        headers: headers('idem-decline-unknown-1'),
        body: JSON.stringify({ kind: 'new-category', fingerprint: 'nope' }),
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { data: { dismissed: boolean } };
      expect(body.data.dismissed).toBe(false);
    });
  });
});

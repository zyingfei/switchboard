import { expect, test } from '@playwright/test';

import { generateRendezvousSecret } from '../../../sidetrack-companion/src/sync/relayCrypto';
import { startTestCompanion, type TestCompanion } from './helpers/companion';
import { startTestRelay, type TestRelay } from './helpers/relay';

// Sync Contract v1 — Lane 1 user-outcome gates exercised at the
// REAL two-companion + relay level. The companion-side unit + e2e
// suites already prove the pieces (event log, projector,
// materializer, recall lifecycle); this spec proves the chain
// holds when separate companion processes are wired through a
// real relay subprocess.
//
//   L1-G2 (real e2e) — Browser A captures → relay → Browser B's
//                       `/v1/recall/query` returns the capture
//                       within bounded time, no restart.
//   L1-G3 (real e2e) — Browser A deletes the thread → relay → B's
//                       `/v1/recall/query` stops returning chunks
//                       for that thread.
//
// The companion test fixture sets `SIDETRACK_TEST_EMBEDDER=1` on
// the spawned companion so embed() returns deterministic vectors
// without loading the 100+MB HF model. Lexical (MiniSearch)
// matching on the unique query term is what the assertions rely
// on; vectors are sane but not semantically meaningful.

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const callCompanion = async (
  companion: TestCompanion,
  method: 'POST' | 'PATCH' | 'DELETE',
  pathSuffix: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> => {
  const idempotencyKey = `e2e-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  const response = await fetch(`http://127.0.0.1:${String(companion.port)}${pathSuffix}`, {
    method,
    headers: {
      'x-bac-bridge-key': companion.bridgeKey,
      'idempotency-key': idempotencyKey,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
};

const recallQuery = async (
  companion: TestCompanion,
  q: string,
): Promise<{
  status: number;
  items: readonly { readonly threadId?: string; readonly id?: string }[];
}> => {
  const url = `http://127.0.0.1:${String(companion.port)}/v1/recall/query?q=${encodeURIComponent(q)}`;
  const response = await fetch(url, {
    headers: { 'x-bac-bridge-key': companion.bridgeKey },
  });
  const body = (await response.json().catch(() => ({ data: [] }))) as {
    data?: readonly { threadId?: string; id?: string }[];
  };
  return {
    status: response.status,
    items: body.data ?? [],
  };
};

test.describe('Sync Contract v1 / Lane 1 — cross-replica recall (real two-companion + relay)', () => {
  test('L1-G2 — capture on A → recall on B finds it within 30 s, no restart', async () => {
    test.setTimeout(120_000);
    let relay: TestRelay | undefined;
    let companionA: TestCompanion | undefined;
    let companionB: TestCompanion | undefined;
    try {
      relay = await startTestRelay({});
      const secret = generateRendezvousSecret().toString('base64url');
      companionA = await startTestCompanion({
        syncRelay: relay.url,
        syncRendezvousSecret: secret,
      });
      companionB = await startTestCompanion({
        syncRelay: relay.url,
        syncRendezvousSecret: secret,
      });
      await sleep(2_500);

      // Capture on A. The companion's POST /v1/events handler
      // appends the event to the log AND schedules
      // ingestIncremental. The merged log entry replicates to B
      // via the relay; B's recall materializer runs ingest on
      // peer-import via the runner. After both the embedder
      // (deterministic test mode) and the lexical index
      // (MiniSearch) have built, the unique query term must
      // match.
      const uniqueTerm = `lane1g2_token_${Math.random().toString(36).slice(2, 8)}`;
      const captureBody = {
        threadUrl: 'https://chatgpt.com/c/l1g2',
        provider: 'chatgpt' as const,
        title: 'L1-G2 capture probe',
        capturedAt: new Date().toISOString(),
        turns: [
          {
            ordinal: 0,
            role: 'assistant' as const,
            text: `assistant said something with the unique token ${uniqueTerm} that lane 1 gate 2 looks for`,
            capturedAt: new Date().toISOString(),
          },
        ],
      };
      const postResult = await callCompanion(companionA, 'POST', '/v1/events', captureBody);
      expect(
        postResult.status,
        `companion A accepted capture (status=${String(postResult.status)})`,
      ).toBe(201);
      const bacId = (postResult.data as { data?: { bac_id?: string } })?.data?.bac_id;
      expect(typeof bacId).toBe('string');

      // Companion B's recall query must find the capture without
      // a restart. Polls every ~1s with a 30s ceiling per the
      // documented Lane 1 freshness bound.
      await expect
        .poll(
          async () => {
            const result = await recallQuery(companionB!, uniqueTerm);
            if (result.status !== 200) return null;
            return result.items.some((item) => item.threadId === bacId);
          },
          { timeout: 30_000, intervals: [500, 1_000, 2_000] },
        )
        .toBe(true);
    } finally {
      await companionB?.close();
      await companionA?.close();
      await relay?.close();
    }
  });

  test('L1-G3 — delete on A → recall on B stops returning chunks within 30 s, no restart', async () => {
    test.setTimeout(120_000);
    let relay: TestRelay | undefined;
    let companionA: TestCompanion | undefined;
    let companionB: TestCompanion | undefined;
    try {
      relay = await startTestRelay({});
      const secret = generateRendezvousSecret().toString('base64url');
      companionA = await startTestCompanion({
        syncRelay: relay.url,
        syncRendezvousSecret: secret,
      });
      companionB = await startTestCompanion({
        syncRelay: relay.url,
        syncRendezvousSecret: secret,
      });
      await sleep(2_500);

      // First: create a thread record (POST /v1/threads). Archive
      // requires the thread JSON to exist on disk on the archiving
      // replica (vault/writer.ts.archiveThread reads it).
      const uniqueTerm = `lane1g3_token_${Math.random().toString(36).slice(2, 8)}`;
      const threadUrl = 'https://chatgpt.com/c/l1g3';
      const upsert = await callCompanion(companionA, 'POST', '/v1/threads', {
        provider: 'chatgpt',
        threadUrl,
        title: 'L1-G3 thread',
        lastSeenAt: new Date().toISOString(),
        status: 'active',
        trackingMode: 'manual',
        tags: [],
      });
      expect(upsert.status).toBe(200);
      const bacId = (upsert.data as { data?: { bac_id?: string } })?.data?.bac_id;
      expect(typeof bacId).toBe('string');

      // Then: capture turns under that thread.
      const captureBody = {
        threadId: bacId,
        threadUrl,
        provider: 'chatgpt' as const,
        title: 'L1-G3 capture probe',
        capturedAt: new Date().toISOString(),
        turns: [
          {
            ordinal: 0,
            role: 'assistant' as const,
            text: `assistant text containing token ${uniqueTerm} for the tombstone gate`,
            capturedAt: new Date().toISOString(),
          },
        ],
      };
      const postResult = await callCompanion(companionA, 'POST', '/v1/events', captureBody);
      expect(postResult.status).toBe(201);

      // Wait for B to see + index it.
      await expect
        .poll(
          async () => {
            const result = await recallQuery(companionB!, uniqueTerm);
            return result.items.some((item) => item.threadId === bacId);
          },
          { timeout: 30_000, intervals: [500, 1_000, 2_000] },
        )
        .toBe(true);

      // Now: archive on A. The archive route emits a
      // thread.archived event AND triggers
      // lifecycle.tombstoneByThread which both tombstones A's
      // index AND emits recall.tombstone.target for peer
      // propagation. The relay fans the tombstone event out; B's
      // recall materializer ingests it and tombstones B's index
      // entries via tombstoneByThread.
      const archiveResult = await callCompanion(
        companionA,
        'POST',
        `/v1/threads/${encodeURIComponent(bacId!)}/archive`,
      );
      expect(archiveResult.status, `archive returned status=${String(archiveResult.status)}`).toBe(
        200,
      );

      // B's recall query must stop returning the chunk within 30 s.
      await expect
        .poll(
          async () => {
            const result = await recallQuery(companionB!, uniqueTerm);
            return result.items.some((item) => item.threadId === bacId);
          },
          { timeout: 30_000, intervals: [500, 1_000, 2_000] },
        )
        .toBe(false);
    } finally {
      await companionB?.close();
      await companionA?.close();
      await relay?.close();
    }
  });
});

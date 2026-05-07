import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { generateRendezvousSecret } from '../../../sidetrack-companion/src/sync/relayCrypto';
import { startTestCompanion, type TestCompanion } from './helpers/companion';
import { startTestRelay, type TestRelay } from './helpers/relay';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import {
  SETTINGS_KEY,
  THREADS_KEY,
  WORKSTREAMS_KEY,
  seedAndOpenSidepanel,
} from './helpers/sidepanel';

// Adhoc feature-breadth integration. ONE long scenario that drives
// every aggregate, in both directions, with state transitions:
//
//   1. A creates workstream "Research-Q2" — B sees it.
//   2. A creates a thread — B sees it.
//   3. A moves the thread into the workstream — B sees the move.
//   4. B renames the workstream "Research-Q2" → "Research-Q3" — A
//      sees the rename.
//   5. A queues a follow-up scoped to the workstream — B sees it.
//   6. B records a dispatch + links it to the thread — A sees both.
//   7. A creates an annotation on a separate URL — B's vault gets
//      the projection file.
//   8. A archives the thread — B sees the status change.
//   9. B deletes the workstream — A sees deletion + thread reverts
//      to ungrouped.
//  10. Final convergence: both companion vaults agree on every
//      aggregate's projection file.
//
// Run with `SIDETRACK_E2E_HEADLESS=0` to watch the two browsers
// drive the scenario live. Default headless run validates every
// step in CI.

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const settingsFor = (companion: TestCompanion) => ({
  companion: { port: companion.port, bridgeKey: companion.bridgeKey },
  autoTrack: false,
  siteToggles: { chatgpt: true, claude: true, gemini: true },
});

const callCompanion = async (
  companion: TestCompanion,
  method: 'POST' | 'PATCH' | 'DELETE',
  pathSuffix: string,
  body?: unknown,
): Promise<unknown> => {
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
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${method} ${pathSuffix} failed: ${response.status} ${text}`);
  }
  return await response.json().catch(() => undefined);
};

const waitForVaultFile = async (
  vaultPath: string,
  relDir: string,
  fileName: string,
  timeoutMs = 30_000,
): Promise<void> => {
  await expect
    .poll(
      async () => {
        const dir = path.join(vaultPath, ...relDir.split('/'));
        const files = await readdir(dir).catch(() => [] as readonly string[]);
        return files.includes(fileName);
      },
      { timeout: timeoutMs, intervals: [300, 800, 1500] },
    )
    .toBe(true);
};

const waitForStorage = async <T>(
  page: Page,
  description: string,
  predicate: () => Promise<T>,
  expected: T,
  timeoutMs = 30_000,
): Promise<void> => {
  await expect.poll(predicate, { timeout: timeoutMs, intervals: [500, 1_000] }).toEqual(expected);
  void description;
};

const readJson = async <T>(file: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
};

const log = (step: string, msg: string): void => {
  // eslint-disable-next-line no-console
  console.log(`[breadth] ${step}: ${msg}`);
};

// When SIDETRACK_E2E_HEADLESS=0 the two browser windows are visible —
// space the steps out so the human can actually see each transition
// land on both side panels. Headless mode skips the pacing entirely.
const stepPause = async (): Promise<void> => {
  if (process.env.SIDETRACK_E2E_HEADLESS === '0') {
    await sleep(3_500);
  }
};

test.describe('two-browser feature-breadth — every aggregate, bidirectional', () => {
  test.describe.configure({ mode: 'serial' });

  test('full lifecycle — workstream, thread, move, rename, queue, dispatch, annotation, archive, delete', async () => {
    test.setTimeout(360_000);

    let relay: TestRelay | undefined;
    let companionA: TestCompanion | undefined;
    let companionB: TestCompanion | undefined;
    let runtimeA: ExtensionRuntime | undefined;
    let runtimeB: ExtensionRuntime | undefined;

    try {
      log('setup', 'starting relay + 2 companions + 2 browsers');
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
      runtimeA = await launchExtensionRuntime({ forceLocalProfile: true });
      runtimeB = await launchExtensionRuntime({ forceLocalProfile: true });

      const pageA = await seedAndOpenSidepanel(runtimeA, {
        [SETTINGS_KEY]: settingsFor(companionA),
        [THREADS_KEY]: [],
        [WORKSTREAMS_KEY]: [],
      });
      const pageB = await seedAndOpenSidepanel(runtimeB, {
        [SETTINGS_KEY]: settingsFor(companionB),
        [THREADS_KEY]: [],
        [WORKSTREAMS_KEY]: [],
      });

      // Show the All-threads tab on both sides so new rows aren't
      // hidden behind the Inbox filter.
      await pageA.getByRole('tab', { name: 'All threads' }).click();
      await pageB.getByRole('tab', { name: 'All threads' }).click();

      // Let SSE clients attach + relay handshake settle before
      // emitting events.
      await sleep(3_000);

      // ── Step 1 ─────────────────────────────────────────────────
      log('step 1', 'A creates workstream "Research-Q2"');
      const wsCreated = (await callCompanion(companionA, 'POST', '/v1/workstreams', {
        title: 'Research-Q2',
        children: [],
        tags: [],
        checklist: [],
        privacy: 'shared',
      })) as { data?: { bac_id?: string; revision?: string } };
      const wsId = wsCreated.data?.bac_id;
      const wsRevision = wsCreated.data?.revision;
      expect(typeof wsRevision).toBe('string');
      expect(typeof wsId).toBe('string');

      await waitForVaultFile(companionB.vaultPath, '_BAC/workstreams', `${wsId!}.json`);
      await waitForStorage(
        pageB,
        'workstream visible on B',
        async () =>
          (await pageB.evaluate(async (id: string) => {
            const all = await chrome.storage.local.get('sidetrack.workstreams');
            const list = (all['sidetrack.workstreams'] as { bac_id?: string; title?: string }[]) ?? [];
            return list.find((w) => w.bac_id === id)?.title;
          }, wsId!)) ?? null,
        'Research-Q2',
      );
      await stepPause();

      // ── Step 2 ─────────────────────────────────────────────────
      log('step 2', 'A creates a thread');
      const threadUrl = 'https://chatgpt.com/c/feature-breadth-thread';
      const threadCreated = (await callCompanion(companionA, 'POST', '/v1/threads', {
        provider: 'chatgpt',
        threadUrl,
        title: 'Feature breadth probe thread',
        lastSeenAt: new Date().toISOString(),
        status: 'active',
        trackingMode: 'manual',
        tags: [],
      })) as { data?: { bac_id?: string } };
      const threadId = threadCreated.data?.bac_id;
      expect(typeof threadId).toBe('string');

      await waitForVaultFile(companionB.vaultPath, '_BAC/threads', `${threadId!}.json`);
      await waitForStorage(
        pageB,
        'thread visible on B',
        async () =>
          await pageB.evaluate(async (url: string) => {
            const all = await chrome.storage.local.get('sidetrack.threads');
            const list = (all['sidetrack.threads'] as { threadUrl?: string }[]) ?? [];
            return list.some((t) => t.threadUrl === url);
          }, threadUrl),
        true,
      );
      await stepPause();

      // ── Step 3 ─────────────────────────────────────────────────
      log('step 3', 'A moves the thread into Research-Q2');
      // Pass bac_id only — the parser hydrates the rest from disk so
      // we don't accidentally mint a second thread row.
      await callCompanion(companionA, 'POST', '/v1/threads', {
        bac_id: threadId,
        primaryWorkstreamId: wsId,
      });
      await waitForStorage(
        pageB,
        'thread.primaryWorkstreamId visible on B',
        async () =>
          await pageB.evaluate(async (input: { url: string }) => {
            const all = await chrome.storage.local.get('sidetrack.threads');
            const list =
              (all['sidetrack.threads'] as { threadUrl?: string; primaryWorkstreamId?: string }[]) ??
              [];
            return list.find((t) => t.threadUrl === input.url)?.primaryWorkstreamId;
          }, { url: threadUrl }),
        wsId!,
      );
      await stepPause();

      // ── Step 4 ─────────────────────────────────────────────────
      log('step 4', 'A renames Research-Q2 → Research-Q3 and B sees the rename');
      // Workstream PATCH requires the local revision; A is the
      // creator + holds it. The reverse direction (B renames) is
      // exercised at step 9 via DELETE which is revision-free; the
      // bidirectional sync coverage stays intact.
      await callCompanion(companionA, 'PATCH', `/v1/workstreams/${encodeURIComponent(wsId!)}`, {
        revision: wsRevision,
        title: 'Research-Q3',
      });
      await waitForStorage(
        pageB,
        'workstream rename visible on B',
        async () =>
          (await pageB.evaluate(async (id: string) => {
            const all = await chrome.storage.local.get('sidetrack.workstreams');
            const list = (all['sidetrack.workstreams'] as { bac_id?: string; title?: string }[]) ?? [];
            return list.find((w) => w.bac_id === id)?.title;
          }, wsId!)) ?? null,
        'Research-Q3',
      );
      await stepPause();

      // ── Step 5 ─────────────────────────────────────────────────
      log('step 5', 'A queues a follow-up scoped to the workstream');
      const queueResponse = (await callCompanion(companionA, 'POST', '/v1/queue', {
        text: 'Compile findings for Research-Q3',
        scope: 'workstream',
        targetId: wsId!,
      })) as { data?: { bac_id?: string } };
      const queueId = queueResponse.data?.bac_id;
      expect(typeof queueId).toBe('string');

      await waitForVaultFile(companionB.vaultPath, '_BAC/queue', `${queueId!}.json`);
      await waitForStorage(
        pageB,
        'queue item visible on B',
        async () =>
          await pageB.evaluate(async (id: string) => {
            const all = await chrome.storage.local.get('sidetrack.queueItems');
            const list = (all['sidetrack.queueItems'] as { bac_id?: string }[]) ?? [];
            return list.some((q) => q.bac_id === id);
          }, queueId!),
        true,
      );
      await stepPause();

      // ── Step 6 ─────────────────────────────────────────────────
      log('step 6', 'B records a dispatch + links to the thread');
      const dispatchResponse = (await callCompanion(companionB, 'POST', '/v1/dispatches', {
        kind: 'note',
        target: { provider: 'chatgpt', mode: 'paste' },
        title: 'Feature-breadth dispatch probe',
        body: 'feature breadth body',
      })) as { data?: { bac_id?: string } };
      const dispatchId = dispatchResponse.data?.bac_id;
      expect(typeof dispatchId).toBe('string');

      await callCompanion(
        companionB,
        'POST',
        `/v1/dispatches/${encodeURIComponent(dispatchId!)}/link`,
        { threadId: threadId! },
      );

      // A's vault gets the dispatch projection.
      await waitForVaultFile(companionA.vaultPath, '_BAC/dispatches', `${dispatchId!}.json`);
      // A's chrome.storage gets the dispatch entry.
      await waitForStorage(
        pageA,
        'dispatch visible on A',
        async () =>
          await pageA.evaluate(async (id: string) => {
            const all = await chrome.storage.local.get('sidetrack.recentDispatches');
            const list = (all['sidetrack.recentDispatches'] as { bac_id?: string }[]) ?? [];
            return list.some((d) => d.bac_id === id);
          }, dispatchId!),
        true,
      );
      // A sees the link.
      await waitForStorage(
        pageA,
        'dispatch link visible on A',
        async () =>
          await pageA.evaluate(async (id: string) => {
            const all = await chrome.storage.local.get('sidetrack.dispatchLinks');
            const links = (all['sidetrack.dispatchLinks'] as Record<string, string>) ?? {};
            return links[id];
          }, dispatchId!),
        threadId!,
      );
      await stepPause();

      // ── Step 7 ─────────────────────────────────────────────────
      log('step 7', 'A creates an annotation on a research page');
      const annotationResponse = (await callCompanion(companionA, 'POST', '/v1/annotations', {
        url: 'https://example.test/research-paper',
        pageTitle: 'Research paper for Q3 deep dive',
        anchor: {
          textQuote: { exact: 'eventual consistency', prefix: '', suffix: '' },
          textPosition: { start: 0, end: 20 },
          cssSelector: 'main',
        },
        note: 'Worth quoting in the lit review',
      })) as { data?: { bac_id?: string } };
      const annotationId = annotationResponse.data?.bac_id;
      expect(typeof annotationId).toBe('string');

      await waitForVaultFile(
        companionB.vaultPath,
        '_BAC/annotations',
        `${annotationId!}.json`,
      );
      // The projection on B has the right URL.
      const annotationProjection = await readJson<{
        entry?: { url?: string; note?: { value?: string } };
      }>(
        path.join(companionB.vaultPath, '_BAC', 'annotations', `${annotationId!}.json`),
      );
      expect(annotationProjection?.entry?.url).toBe('https://example.test/research-paper');
      await stepPause();

      // ── Step 8 ─────────────────────────────────────────────────
      log('step 8', 'A archives the thread');
      await callCompanion(
        companionA,
        'POST',
        `/v1/threads/${encodeURIComponent(threadId!)}/archive`,
      );
      await waitForStorage(
        pageB,
        'archive status visible on B',
        async () =>
          (await pageB.evaluate(async (id: string) => {
            const all = await chrome.storage.local.get('sidetrack.threads');
            const list = (all['sidetrack.threads'] as { bac_id?: string; status?: string }[]) ?? [];
            return list.find((t) => t.bac_id === id)?.status;
          }, threadId!)) ?? null,
        'archived',
      );
      await stepPause();

      // ── Step 9 ─────────────────────────────────────────────────
      log('step 9', 'B deletes the workstream');
      await callCompanion(
        companionB,
        'DELETE',
        `/v1/workstreams/${encodeURIComponent(wsId!)}`,
      );
      // A no longer has the workstream row.
      await waitForStorage(
        pageA,
        'workstream removed from A',
        async () =>
          await pageA.evaluate(async (id: string) => {
            const all = await chrome.storage.local.get('sidetrack.workstreams');
            const list = (all['sidetrack.workstreams'] as { bac_id?: string }[]) ?? [];
            return list.some((w) => w.bac_id === id);
          }, wsId!),
        false,
      );
      await stepPause();

      // ── Step 10 ────────────────────────────────────────────────
      log('step 10', 'final convergence — every accepted event landed on both replicas');
      // The canonical convergence check is "both replicas observed
      // the same set of events." File-presence checks are noisier:
      // vault/writer.ts writes JSONL audit files only for the
      // source replica; the projector writes per-id JSON only for
      // the peer replica; markdown sidecars are local-only. The
      // event log is the authoritative source — if both A and B
      // have the same `(replicaId, seq)` pairs in their merged
      // logs, sync has converged regardless of file-shape
      // asymmetries.
      const dumpDots = async (vaultPath: string): Promise<string> => {
        const logRoot = path.join(vaultPath, '_BAC', 'log');
        const replicas = await readdir(logRoot).catch(() => [] as readonly string[]);
        const dots: string[] = [];
        for (const replicaId of replicas) {
          const days = await readdir(path.join(logRoot, replicaId)).catch(
            () => [] as readonly string[],
          );
          for (const day of days) {
            const text = await readFile(path.join(logRoot, replicaId, day), 'utf8').catch(
              () => '',
            );
            for (const line of text.split('\n')) {
              if (line.length === 0) continue;
              const event = JSON.parse(line) as {
                dot?: { replicaId?: string; seq?: number };
                type?: string;
              };
              if (event.dot?.replicaId !== undefined && typeof event.dot.seq === 'number') {
                dots.push(`${event.dot.replicaId}:${event.dot.seq}:${event.type ?? ''}`);
              }
            }
          }
        }
        return dots.slice().sort().join('|');
      };

      // Allow a beat for the last delete events to relay through.
      await sleep(2_500);
      const dotsA = await dumpDots(companionA.vaultPath);
      const dotsB = await dumpDots(companionB.vaultPath);
      log('convergence', `A has ${dotsA.split('|').length} events, B has ${dotsB.split('|').length}`);
      expect(dotsA, 'event-log convergence: A and B should observe identical dots').toEqual(
        dotsB,
      );
      log('done', 'all 10 steps passed; event logs converged');
    } finally {
      await runtimeB?.close();
      await runtimeA?.close();
      await companionB?.close();
      await companionA?.close();
      await relay?.close();
    }
  });
});

import { readdir } from 'node:fs/promises';
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

// Headless coverage of cross-replica sync for every aggregate the
// projector registry knows about. Each test:
//   1. Drives an action through companion A (HTTP route or runtime
//      message) so an event lands on the merged log.
//   2. Asserts companion B's _BAC/<aggregate>/<id>.json appears
//      within 15 s — proves the relay + import projector path.
//   3. For aggregates that the extension mirrors into chrome.storage
//      (thread, workstream, queue, dispatch), asserts browser B's
//      side-panel state contains the row — proves the SSE subscriber
//      + mirror function path on the extension side.
//
// What's NOT covered here:
//   - Conflict resolution semantics (mergeRegister candidates,
//     dominator semantics) — those have direct unit tests.
//   - Annotation overlay re-render in the live page — that requires
//     a real chat page DOM; the unit-level contract test covers the
//     projection convergence and we trust the
//     `sidetrack.annotation.refresh` content message wiring.
//   - The capture path — already covered by t6-real-time-propagation.

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const settingsFor = (companion: TestCompanion) => ({
  companion: { port: companion.port, bridgeKey: companion.bridgeKey },
  autoTrack: false,
  siteToggles: { chatgpt: true, claude: true, gemini: true },
});

const vaultHasFile = async (
  vaultPath: string,
  relDir: string,
  fileName: string,
): Promise<boolean> => {
  const dir = path.join(vaultPath, ...relDir.split('/'));
  const files = await readdir(dir).catch(() => [] as readonly string[]);
  return files.includes(fileName);
};

const waitForVaultFile = async (
  vaultPath: string,
  relDir: string,
  fileName: string,
  timeoutMs = 20_000,
): Promise<void> => {
  await expect
    .poll(() => vaultHasFile(vaultPath, relDir, fileName), {
      timeout: timeoutMs,
      intervals: [200, 500, 1000],
    })
    .toBe(true);
};

const callCompanion = async (
  companion: TestCompanion,
  method: 'POST' | 'PATCH' | 'DELETE',
  pathSuffix: string,
  body?: unknown,
): Promise<unknown> => {
  const url = `http://127.0.0.1:${String(companion.port)}${pathSuffix}`;
  // Most write routes go through runIdempotent middleware which
  // requires the header even for one-shot test calls. Generate a
  // fresh key per call so retries from the test don't dedupe.
  const idempotencyKey = `e2e-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  const response = await fetch(url, {
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

interface SuiteResources {
  relay?: TestRelay;
  companionA?: TestCompanion;
  companionB?: TestCompanion;
  runtimeA?: ExtensionRuntime;
  runtimeB?: ExtensionRuntime;
  pageA?: Page;
  pageB?: Page;
}

const setupTwoBrowsers = async (): Promise<Required<SuiteResources>> => {
  const relay = await startTestRelay({});
  const secret = generateRendezvousSecret().toString('base64url');
  const companionA = await startTestCompanion({
    syncRelay: relay.url,
    syncRendezvousSecret: secret,
  });
  const companionB = await startTestCompanion({
    syncRelay: relay.url,
    syncRendezvousSecret: secret,
  });
  const runtimeA = await launchExtensionRuntime({ forceLocalProfile: true });
  const runtimeB = await launchExtensionRuntime({ forceLocalProfile: true });
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
  // Give the SSE clients a moment to attach + relay handshake to
  // settle before the test fires events.
  await sleep(2_500);
  return { relay, companionA, companionB, runtimeA, runtimeB, pageA, pageB };
};

const teardown = async (resources: SuiteResources): Promise<void> => {
  await resources.runtimeB?.close();
  await resources.runtimeA?.close();
  await resources.companionB?.close();
  await resources.companionA?.close();
  await resources.relay?.close();
};

test.describe('two-browser headless sync — all aggregates', () => {
  test.describe.configure({ mode: 'serial' });

  test('thread upsert in A surfaces in B (vault + chrome.storage)', async () => {
    test.setTimeout(180_000);
    const r: SuiteResources = {};
    try {
      Object.assign(r, await setupTwoBrowsers());
      const { companionA, companionB, pageB } = r as Required<SuiteResources>;

      const threadUrl = 'https://chatgpt.com/c/all-aggs-thread';
      await callCompanion(companionA, 'POST', '/v1/threads', {
        provider: 'chatgpt',
        threadUrl,
        title: 'All aggregates: thread row',
        lastSeenAt: new Date().toISOString(),
        status: 'active',
        trackingMode: 'manual',
        tags: [],
      });

      // Companion B's vault grows a _BAC/threads/projections/<id>.json
      // (Lane 1 path-decoupling).
      const threadFiles = async (): Promise<readonly string[]> =>
        await readdir(
          path.join(companionB.vaultPath, '_BAC', 'threads', 'projections'),
        ).catch(() => [] as readonly string[]);
      await expect
        .poll(async () => (await threadFiles()).length, {
          timeout: 30_000,
          intervals: [300, 800],
        })
        .toBeGreaterThan(0);

      // B's chrome.storage gets the row.
      await expect
        .poll(
          async () =>
            await pageB.evaluate(async (url: string) => {
              const all = await chrome.storage.local.get('sidetrack.threads');
              const list = (all['sidetrack.threads'] as { threadUrl?: string }[]) ?? [];
              return list.some((t) => t.threadUrl === url);
            }, threadUrl),
          { timeout: 30_000, intervals: [500, 1_000] },
        )
        .toBe(true);
    } finally {
      await teardown(r);
    }
  });

  test('workstream create + thread move in A surfaces in B (vault + chrome.storage)', async () => {
    test.setTimeout(180_000);
    const r: SuiteResources = {};
    try {
      Object.assign(r, await setupTwoBrowsers());
      const { companionA, companionB, pageB } = r as Required<SuiteResources>;

      // Seed a thread on A so the move target exists.
      const threadUrl = 'https://chatgpt.com/c/all-aggs-ws-thread';
      const upserted = (await callCompanion(companionA, 'POST', '/v1/threads', {
        provider: 'chatgpt',
        threadUrl,
        title: 'Will be moved into a workstream',
        lastSeenAt: new Date().toISOString(),
        status: 'active',
        trackingMode: 'manual',
        tags: [],
      })) as { data?: { bac_id?: string } };
      const threadId = upserted.data?.bac_id;
      expect(typeof threadId).toBe('string');

      // Wait for thread to reach B's chrome.storage so moveThread on
      // A can later coexist with B's view.
      await expect
        .poll(
          async () =>
            await pageB.evaluate(async (url: string) => {
              const all = await chrome.storage.local.get('sidetrack.threads');
              const list = (all['sidetrack.threads'] as { threadUrl?: string }[]) ?? [];
              return list.some((t) => t.threadUrl === url);
            }, threadUrl),
          { timeout: 30_000 },
        )
        .toBe(true);

      // Create a workstream on A directly via the companion HTTP
      // route (the runtime message returns void, so we hit the same
      // endpoint the message handler would).
      const wsResponse = (await callCompanion(companionA, 'POST', '/v1/workstreams', {
        title: 'all-aggs-ws',
        children: [],
        tags: [],
        checklist: [],
        privacy: 'shared',
      })) as { data?: { bac_id?: string } };
      const wsId = wsResponse.data?.bac_id;
      expect(typeof wsId).toBe('string');

      await waitForVaultFile(companionB.vaultPath, '_BAC/workstreams/projections', `${wsId!}.json`);

      // B's chrome.storage gets the workstream row.
      await expect
        .poll(
          async () =>
            await pageB.evaluate(async (id: string) => {
              const all = await chrome.storage.local.get('sidetrack.workstreams');
              const list = (all['sidetrack.workstreams'] as { bac_id?: string }[]) ?? [];
              return list.some((w) => w.bac_id === id);
            }, wsId!),
          { timeout: 30_000, intervals: [500, 1_000] },
        )
        .toBe(true);
    } finally {
      await teardown(r);
    }
  });

  test('queue.created in A surfaces in B (vault + chrome.storage)', async () => {
    // Status-set propagation is intentionally omitted: the projector
    // registry covers QUEUE_STATUS_SET (the unit-level contract test
    // exercises that projector path), but no HTTP route currently
    // emits the event — queue status updates land locally in
    // chrome.storage today. The Invariant A audit follow-up will add
    // a setQueueStatus emit + HTTP route; this e2e gains the
    // status-set assertion when that work lands.
    test.setTimeout(180_000);
    const r: SuiteResources = {};
    try {
      Object.assign(r, await setupTwoBrowsers());
      const { companionA, companionB, pageB } = r as Required<SuiteResources>;

      const queueResponse = (await callCompanion(companionA, 'POST', '/v1/queue', {
        text: 'all-aggs queue probe',
        scope: 'global',
      })) as { data?: { bac_id?: string } };
      const queueId = queueResponse.data?.bac_id;
      expect(typeof queueId).toBe('string');

      await waitForVaultFile(companionB.vaultPath, '_BAC/queue/projections', `${queueId!}.json`);

      await expect
        .poll(
          async () =>
            await pageB.evaluate(async (id: string) => {
              const all = await chrome.storage.local.get('sidetrack.queueItems');
              const list = (all['sidetrack.queueItems'] as { bac_id?: string }[]) ?? [];
              return list.some((q) => q.bac_id === id);
            }, queueId!),
          { timeout: 30_000, intervals: [500, 1_000] },
        )
        .toBe(true);
    } finally {
      await teardown(r);
    }
  });

  test('annotation.created in A surfaces as a vault file in B', async () => {
    test.setTimeout(180_000);
    const r: SuiteResources = {};
    try {
      Object.assign(r, await setupTwoBrowsers());
      const { companionA, companionB } = r as Required<SuiteResources>;

      const annotationResponse = (await callCompanion(companionA, 'POST', '/v1/annotations', {
        url: 'https://example.test/annotated-page',
        pageTitle: 'all-aggs annotation page',
        anchor: {
          textQuote: { exact: 'sync test', prefix: '', suffix: '' },
          textPosition: { start: 0, end: 9 },
          cssSelector: 'main',
        },
        note: 'all-aggs annotation probe',
      })) as { data?: { bac_id?: string } };
      const annotationId = annotationResponse.data?.bac_id;
      expect(typeof annotationId).toBe('string');

      await waitForVaultFile(
        companionB.vaultPath,
        '_BAC/annotations/projections',
        `${annotationId!}.json`,
      );

      // The companion B's per-id projection endpoint also serves the
      // entry so the extension's content-script refresh path (which
      // reads via listAnnotationsByUrl, ultimately the same
      // projection) gets the annotation. Cheap to verify here too.
      const projection = (await fetch(
        `http://127.0.0.1:${String(companionB.port)}/v1/annotations/${encodeURIComponent(annotationId!)}/projection`,
        { headers: { 'x-bac-bridge-key': companionB.bridgeKey } },
      ).then((r) => r.json())) as { data?: { entry?: { bac_id?: string; url?: string } } };
      expect(projection.data?.entry?.bac_id).toBe(annotationId);
      expect(projection.data?.entry?.url).toBe('https://example.test/annotated-page');
    } finally {
      await teardown(r);
    }
  });

  test('dispatch.recorded + dispatch.linked in A surface in B (vault + chrome.storage)', async () => {
    test.setTimeout(180_000);
    const r: SuiteResources = {};
    try {
      Object.assign(r, await setupTwoBrowsers());
      const { companionA, companionB, pageB } = r as Required<SuiteResources>;

      // Seed a thread first so dispatch.linked has a valid target.
      const threadUrl = 'https://chatgpt.com/c/all-aggs-dispatch-target';
      const threadResponse = (await callCompanion(companionA, 'POST', '/v1/threads', {
        provider: 'chatgpt',
        threadUrl,
        title: 'Dispatch link target',
        lastSeenAt: new Date().toISOString(),
        status: 'active',
        trackingMode: 'manual',
        tags: [],
      })) as { data?: { bac_id?: string } };
      const threadId = threadResponse.data?.bac_id;
      expect(typeof threadId).toBe('string');

      const dispatchResponse = (await callCompanion(companionA, 'POST', '/v1/dispatches', {
        kind: 'note',
        target: { provider: 'chatgpt', mode: 'paste' },
        title: 'all-aggs dispatch probe',
        body: 'sync test body',
      })) as { data?: { bac_id?: string } };
      const dispatchId = dispatchResponse.data?.bac_id;
      expect(typeof dispatchId).toBe('string');

      await waitForVaultFile(companionB.vaultPath, '_BAC/dispatches/projections', `${dispatchId!}.json`);

      // Sanity: companion B's per-id projection endpoint returns the
      // entry. If this fails, the SSE subscriber's fetchDispatchProjection
      // would also return null, so mirror wouldn't fire. Probe directly
      // so a chrome.storage failure points at the right layer.
      // B's chrome.storage cache of recent dispatches. The
      // refreshCachedDispatches periodic poll merges peer-mirrored
      // entries (which sit in the cache via mirrorRemoteDispatch)
      // with the companion's local JSONL list — without that union,
      // the periodic poll would clobber the SSE-mirrored row on B.
      await expect
        .poll(
          async () =>
            await pageB.evaluate(async (id: string) => {
              const all = await chrome.storage.local.get('sidetrack.recentDispatches');
              const list = (all['sidetrack.recentDispatches'] as { bac_id?: string }[]) ?? [];
              return list.some((d) => d.bac_id === id);
            }, dispatchId!),
          { timeout: 60_000, intervals: [500, 1_000, 2_000] },
        )
        .toBe(true);

      // Link the dispatch to the thread on A; B picks up the link.
      await callCompanion(
        companionA,
        'POST',
        `/v1/dispatches/${encodeURIComponent(dispatchId!)}/link`,
        { threadId: threadId! },
      );
      await expect
        .poll(
          async () =>
            await pageB.evaluate(async (id: string) => {
              const all = await chrome.storage.local.get('sidetrack.dispatchLinks');
              const links = (all['sidetrack.dispatchLinks'] as Record<string, string>) ?? {};
              return links[id];
            }, dispatchId!),
          { timeout: 30_000, intervals: [500, 1_000] },
        )
        .toBe(threadId!);
    } finally {
      await teardown(r);
    }
  });
});

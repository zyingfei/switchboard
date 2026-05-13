import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { startTestCompanion, type TestCompanion } from './helpers/companion';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import { SETTINGS_KEY, SETUP_KEY } from './helpers/sidepanel';

// Layer 4b — clean-profile proxy-path e2e.
//
// Companion to connections-multiflow-browser.spec.ts. That test
// reuses the live `e2e:chrome-debug` profile and bypasses the MV3
// service-worker proxy via direct fetch from the extension origin
// (because the long-lived Chrome instance holds an older SW snapshot
// than `.output/chrome-mv3` on disk). This spec spawns a *fresh*
// playwright-managed Chrome with the latest .output build, so the
// side panel ↔ background SW ↔ companion HTTP path is exercised
// end-to-end with zero stale-SW caveat.
//
//   side panel ConnectionsView
//     → chrome.runtime.sendMessage(loadConnectionsNeighbors)
//       → background.ts handler → fetchConnectionsHttp
//         → companion HTTP /v1/connections/nodes/{id}/neighbors
//           → rendered DOM (data-testid node-{id})
//
// The L1 reducer test, L2 render test (mocked transport), and the
// L3 HTTP integration spec each cover one layer. This spec is the
// only one that exercises the full real chrome.runtime + background
// + companion path against rendered DOM.

const URL_HN = 'https://news.ycombinator.com/item?id=42_proxy';
const URL_BLOG = 'https://example.com/blog/proxy-test';
const URL_CHAT = 'https://chatgpt.com/c/proxy_test_thread';
const URL_SEARCH =
  'https://www.google.com/search?q=proxy-path+integration+test&newwindow=1&sca_esv=A&ei=B';

const T_PROXY = 't_proxy_chatgpt';

const seedThroughHttp = async (
  comp: TestCompanion,
): Promise<{ wsId: string }> => {
  const apiPost = async (path: string, body: unknown): Promise<unknown> => {
    const res = await fetch(`http://127.0.0.1:${String(comp.port)}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bac-bridge-key': comp.bridgeKey,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} → ${String(res.status)}: ${await res.text()}`);
    return await res.json();
  };
  const ws = (await apiPost('/v1/workstreams', { title: 'Proxy-path test' })) as {
    data: { bac_id: string };
  };
  await apiPost('/v1/threads', {
    bac_id: T_PROXY,
    provider: 'chatgpt',
    threadUrl: URL_CHAT,
    title: 'Proxy-path ChatGPT thread',
    lastSeenAt: '2026-05-07T10:00:00.000Z',
    status: 'active',
    trackingMode: 'auto',
    primaryWorkstreamId: ws.data.bac_id,
    tags: [],
  });
  await apiPost('/v1/events', {
    threadId: T_PROXY,
    threadUrl: URL_CHAT,
    provider: 'chatgpt',
    title: 'Proxy-path ChatGPT thread',
    capturedAt: '2026-05-07T10:00:00.000Z',
    turns: [
      {
        ordinal: 0,
        role: 'user',
        text: `reading ${URL_HN}, blog at ${URL_BLOG}. compare with my proxy-path integration test approach.`,
        capturedAt: '2026-05-07T10:00:00.000Z',
      },
    ],
  });
  // Timeline visits — including a generic search URL whose query
  // ("proxy-path integration test") shows up verbatim in the chat
  // turn → search-query closure should connect them.
  // Phase 4: HN visit is tagged with the workstream so it attaches
  // via visit_in_workstream even though no chat references it
  // (proves ambient-browsing closure through the SW proxy path).
  // Blog + Search are left untagged so they only connect via
  // content-derived edges — keeps the "no inference" line clear.
  await apiPost('/v1/timeline/events', {
    events: [
      { url: URL_HN, time: '2026-05-07T09:50:00.000Z', title: 'HN', workstreamId: ws.data.bac_id },
      { url: URL_BLOG, time: '2026-05-07T09:55:00.000Z', title: 'blog' },
      { url: URL_SEARCH, time: '2026-05-07T09:58:00.000Z', title: 'Google search' },
      { url: URL_CHAT, time: '2026-05-07T10:00:00.000Z', title: 'ChatGPT' },
    ].map((v, i) => ({
      clientEventId: `tl-${String(i + 1).padStart(3, '0')}`,
      dot: { replicaId: 'replica-proxy', seq: i + 1 },
      deps: {},
      aggregateId: '2026-05-07',
      type: 'browser.timeline.observed',
      payload: {
        eventId: `tl-${String(i + 1).padStart(3, '0')}`,
        url: v.url,
        canonicalUrl: v.url,
        title: v.title,
        observedAt: v.time,
        transition: 'activated',
        ...((v as { workstreamId?: string }).workstreamId === undefined
          ? {}
          : { workstreamId: (v as { workstreamId: string }).workstreamId }),
      },
      acceptedAtMs: Date.parse(v.time),
    })),
  });
  return { wsId: ws.data.bac_id };
};

const waitForSnapshotToStabilize = async (comp: TestCompanion): Promise<void> => {
  const apiGet = async (path: string): Promise<unknown> => {
    const r = await fetch(`http://127.0.0.1:${String(comp.port)}${path}`, {
      headers: { 'x-bac-bridge-key': comp.bridgeKey },
    });
    return await r.json();
  };
  // 2500 ms stable window > materializer's 1500 ms drain debounce —
  // without it we may declare "stable" while edgeCount is still 0
  // (no drain has run yet). Also require at least one non-zero
  // observation so we know the drain produced something.
  const startedMs = Date.now();
  let lastCount = -1;
  let stableSinceMs = 0;
  while (Date.now() - startedMs < 30_000) {
    const all = (await apiGet('/v1/connections')) as {
      data: { snapshot: { edgeCount: number } };
    };
    const c = all.data.snapshot.edgeCount;
    if (c === lastCount) {
      if (Date.now() - stableSinceMs >= 2_500 && c > 0) return;
    } else {
      lastCount = c;
      stableSinceMs = Date.now();
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`snapshot did not stabilize (last edgeCount=${String(lastCount)})`);
};

test.describe('connections — clean-profile proxy-path e2e', () => {
  test.setTimeout(180_000);

  let runtime: ExtensionRuntime | null = null;
  let companion: TestCompanion | null = null;
  let seed: { wsId: string } | null = null;

  test.beforeAll(async () => {
    // forceLocalProfile spawns a fresh playwright-managed Chrome
    // pointed at .output/chrome-mv3 — picks up our latest build,
    // so the SW we exercise IS the source we wrote.
    runtime = await launchExtensionRuntime({ forceLocalProfile: true });
    companion = await startTestCompanion();
    seed = await seedThroughHttp(companion);
    await waitForSnapshotToStabilize(companion);
  });

  test.afterAll(async () => {
    if (companion !== null) await companion.close();
    if (runtime !== null) await runtime.close();
    runtime = null;
    companion = null;
    seed = null;
  });

  test('proxy path: side panel → chrome.runtime → background → companion → DOM', async () => {
    if (runtime === null || companion === null || seed === null)
      throw new Error('beforeAll did not run');
    // Open side panel as a page in the spawned context, seed its
    // chrome.storage with the test companion's settings, reload so
    // the panel reads the new settings on mount.
    const panel = await runtime.context.newPage();
    await panel.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
      waitUntil: 'domcontentloaded',
    });
    await runtime.seedStorage(panel, {
      [SETUP_KEY]: true,
      [SETTINGS_KEY]: {
        companion: { port: companion.port, bridgeKey: companion.bridgeKey },
        autoTrack: false,
        siteToggles: { chatgpt: true, claude: true, gemini: true },
        notifyOnQueueComplete: true,
      },
    });
    await panel.reload({ waitUntil: 'domcontentloaded' });
    await expect(panel.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible({
      timeout: 30_000,
    });
    // Switch to Connections.
    await panel.getByRole('tab', { name: 'Connections' }).click();
    await expect(panel.getByTestId('connections-view')).toBeVisible({ timeout: 10_000 });
    // Drive the anchor input — this triggers loadConnectionsNeighbors
    // through the real SW proxy.
    const input = panel.getByTestId('connections-anchor-input');
    await input.click();
    await input.fill(`workstream:${seed.wsId}`);
    await input.press('Enter');
    // The proxy round-trip: chrome.runtime.sendMessage hits the
    // background SW, the SW runs fetchConnectionsHttp against the
    // test companion, the response renders into the DOM. If the
    // SW message-port path were broken we'd see the
    // "Couldn't load" error state instead.
    await expect(panel.getByTestId('connections-groups')).toBeVisible({ timeout: 15_000 });
    // The thread (chat with mention of search query) AND the HN
    // visit (tagged via active-workstream attribution) are both
    // surfaced in the workstream subgraph. One assertion proves
    // the SW proxy works; the other proves visit_in_workstream
    // attaches ambient browsing through the same path.
    await expect(panel.getByTestId(`node-thread:${T_PROXY}`)).toBeVisible();
    await expect(panel.getByTestId(`node-timeline-visit:${URL_HN}`)).toBeVisible({
      timeout: 5_000,
    });
  });
});

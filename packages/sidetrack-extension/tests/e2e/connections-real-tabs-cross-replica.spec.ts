import { expect, test, type Page } from '@playwright/test';

import { generateRendezvousSecret } from '../../../sidetrack-companion/src/sync/relayCrypto';
import { startTestCompanion, type TestCompanion } from './helpers/companion';
import { startTestRelay, type TestRelay } from './helpers/relay';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import { SETTINGS_KEY, SETUP_KEY } from './helpers/sidepanel';

// Real-tab + cross-replica e2e. Browser A drives REAL chrome.tabs
// navigations (HN, blog, search, chat, ambient, GitHub, video). The
// active-workstream attribution stamps each timeline observation
// with the focused workstream id. Browser B, listening on the same
// relay, must surface every visit + every visit_in_workstream
// edge — proves the timeline relay-sync fix carries
// browser.timeline.observed events across companions, and the
// active-workstream attribution survives the round trip.

const URL_HN = 'https://news.ycombinator.com/item?id=42_xrep_real';
const URL_BLOG = 'https://xint.io/blog/copy-fail-linux-distributions';
const URL_SEARCH = 'https://www.google.com/search?q=copy_file_range+linux+CVE+xrep';
const URL_CHAT = 'https://chatgpt.com/c/xrep_real_thread';
const URL_AMBIENT = 'https://copy.fail/';
const URL_PR = 'https://github.com/zyingfei/switchboard/pull/42_xrep_real';
const URL_VIDEO = 'https://www.youtube.com/watch?v=xrep_real_demo';

const ALL_URLS = [URL_HN, URL_BLOG, URL_SEARCH, URL_CHAT, URL_AMBIENT, URL_PR, URL_VIDEO];

const stripTrailingSlash = (u: string): string => u.replace(/\/+$/u, '');

interface ConnectionsEnvelope {
  data: {
    snapshot: {
      nodes: { id: string; metadata?: Record<string, unknown> }[];
      edges: { kind: string; fromNodeId: string; toNodeId: string }[];
    };
  };
}

const apiGet = async (comp: TestCompanion, path: string): Promise<unknown> => {
  const res = await fetch(`http://127.0.0.1:${String(comp.port)}${path}`, {
    headers: { 'x-bac-bridge-key': comp.bridgeKey },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${String(res.status)}: ${await res.text()}`);
  return await res.json();
};

const apiPost = async (
  comp: TestCompanion,
  path: string,
  body: unknown,
): Promise<unknown> => {
  const res = await fetch(`http://127.0.0.1:${String(comp.port)}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-bac-bridge-key': comp.bridgeKey,
      'Idempotency-Key': `idem-${String(Math.random()).slice(2)}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${String(res.status)}: ${await res.text()}`);
  return await res.json();
};

test.describe('connections — real chrome.tabs on Browser A syncs through relay to Browser B', () => {
  test.skip(
    process.env['SIDETRACK_E2E_SKIP_LIVE_BROWSERS'] === '1',
    'set SIDETRACK_E2E_SKIP_LIVE_BROWSERS=1 to skip when CfT is unavailable',
  );
  test.setTimeout(240_000);

  let relay: TestRelay | null = null;
  let companionA: TestCompanion | null = null;
  let companionB: TestCompanion | null = null;
  let runtimeA: ExtensionRuntime | null = null;
  let runtimeB: ExtensionRuntime | null = null;

  test.afterAll(async () => {
    if (runtimeA !== null) await runtimeA.close();
    if (runtimeB !== null) await runtimeB.close();
    if (companionA !== null) await companionA.close();
    if (companionB !== null) await companionB.close();
    if (relay !== null) await relay.close();
    runtimeA = null;
    runtimeB = null;
    companionA = null;
    companionB = null;
    relay = null;
  });

  test('Browser B sees synced ambient timeline visits + visit_in_workstream after A drives real tabs', async () => {
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

    // Stub https responses on browser A so page.goto succeeds without
    // network. Browser B never navigates these — it listens on the
    // relay and renders B's local snapshot.
    await runtimeA.context.route(/^https?:\/\//u, async (route) => {
      const url = route.request().url();
      if (ALL_URLS.some((target) => url.startsWith(target.split('?')[0]))) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<!doctype html><title>${url}</title><body>${url}</body>`,
        });
        return;
      }
      await route.fallback();
    });

    // Workstream lives on A; relay carries WORKSTREAM_UPSERTED to B.
    const wsRes = (await apiPost(companionA, '/v1/workstreams', {
      title: 'Real-tabs xrep research',
    })) as { data: { bac_id: string } };
    const wsId = wsRes.data.bac_id;

    // Configure A's panel + enable timeline + set active workstream.
    const panelA = await runtimeA.context.newPage();
    await panelA.goto(`chrome-extension://${runtimeA.extensionId}/sidepanel.html`, {
      waitUntil: 'domcontentloaded',
    });
    await runtimeA.seedStorage(panelA, {
      [SETUP_KEY]: true,
      [SETTINGS_KEY]: {
        companion: { port: companionA.port, bridgeKey: companionA.bridgeKey },
        autoTrack: false,
        siteToggles: { chatgpt: true, claude: true, gemini: true },
        notifyOnQueueComplete: true,
      },
      'sidetrack.timeline.enabled': true,
      'sidetrack.activeWorkstreamId': wsId,
    });
    const reinitA = await runtimeA.sendRuntimeMessage(panelA, {
      type: 'sidetrack.timeline.reinit',
    });
    expect((reinitA as { ok?: boolean } | null)?.ok).toBe(true);

    // Drive real navigations on A.
    for (const url of ALL_URLS) {
      const t = await runtimeA.context.newPage();
      await t.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 200));
      await t.close();
    }

    // Force-drain A's spool so its companion ingests every observation.
    const drainSenderA = await runtimeA.context.newPage();
    await drainSenderA.goto(
      `chrome-extension://${runtimeA.extensionId}/sidepanel.html`,
      { waitUntil: 'domcontentloaded' },
    );
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const r = (await runtimeA.sendRuntimeMessage(drainSenderA, {
        type: 'sidetrack.timeline.force-drain',
      })) as { ok?: boolean; drain?: { uploaded?: number; remaining?: number } } | null;
      if (r !== null && r.ok === true && (r.drain?.uploaded ?? 0) >= ALL_URLS.length) {
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    await drainSenderA.close();

    // Wait for B's connections snapshot to surface every visit through
    // the relay. Class B freshness budget is 30 s; we give 60 s here
    // for the cross-replica drains to fully settle.
    const wantNodeIds = ALL_URLS.map((u) => `timeline-visit:${stripTrailingSlash(u)}`);
    const startedMs = Date.now();
    let lastBNodes: { id: string; metadata?: Record<string, unknown> }[] = [];
    let lastBEdges: { kind: string; fromNodeId: string; toNodeId: string }[] = [];
    let allSeenOnB = false;
    while (Date.now() - startedMs < 60_000) {
      const env = (await apiGet(companionB, '/v1/connections')) as ConnectionsEnvelope;
      lastBNodes = env.data.snapshot.nodes;
      lastBEdges = env.data.snapshot.edges;
      const ids = new Set(lastBNodes.map((n) => n.id));
      if (wantNodeIds.every((w) => ids.has(w))) {
        allSeenOnB = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!allSeenOnB) {
      // eslint-disable-next-line no-console
      console.error(
        '[real-tabs-xrep] FINAL B nodes:',
        JSON.stringify(lastBNodes.map((n) => n.id)),
      );
    }
    expect(allSeenOnB).toBe(true);

    // Every visit on B must carry the workstream id stamped by A's
    // observer (LWW survives the relay round-trip).
    for (const want of wantNodeIds) {
      const node = lastBNodes.find((n) => n.id === want);
      expect(node).toBeDefined();
      expect((node?.metadata ?? {})['workstreamId']).toBe(wsId);
    }
    // visit_in_workstream edges from every visit to the workstream
    // must be present on B's snapshot — produced by the connections
    // reducer's pass 3 from event-log alone.
    const wsEdgesOnB = lastBEdges.filter(
      (e) => e.kind === 'visit_in_workstream' && e.toNodeId === `workstream:${wsId}`,
    );
    const wsEdgeFromIdsOnB = new Set(wsEdgesOnB.map((e) => e.fromNodeId));
    for (const want of wantNodeIds) {
      expect(wsEdgeFromIdsOnB.has(want)).toBe(true);
    }

    // Open B's side panel + Connections view, anchor on the synced
    // workstream, assert DOM renders all visits.
    const panelB = await runtimeB.context.newPage();
    await panelB.goto(`chrome-extension://${runtimeB.extensionId}/sidepanel.html`, {
      waitUntil: 'domcontentloaded',
    });
    await runtimeB.seedStorage(panelB, {
      [SETUP_KEY]: true,
      [SETTINGS_KEY]: {
        companion: { port: companionB.port, bridgeKey: companionB.bridgeKey },
        autoTrack: false,
        siteToggles: { chatgpt: true, claude: true, gemini: true },
        notifyOnQueueComplete: true,
      },
    });
    await panelB.reload({ waitUntil: 'domcontentloaded' });
    await expect(panelB.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible({
      timeout: 30_000,
    });
    await panelB.getByRole('tab', { name: 'Connections' }).click();
    await expect(panelB.getByTestId('connections-view')).toBeVisible({ timeout: 10_000 });
    const input = panelB.getByTestId('connections-anchor-input');
    await input.click();
    await input.fill(`workstream:${wsId}`);
    await input.press('Enter');
    await expect(panelB.getByTestId('connections-groups')).toBeVisible({ timeout: 30_000 });
    for (const want of wantNodeIds) {
      await expect(panelB.getByTestId(`node-${want}`)).toBeVisible();
    }
  });
});

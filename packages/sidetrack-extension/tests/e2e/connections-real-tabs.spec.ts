import { expect, test, type Page } from '@playwright/test';

import { startTestCompanion, type TestCompanion } from './helpers/companion';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import { SETTINGS_KEY, SETUP_KEY } from './helpers/sidepanel';

// Standalone real-tab e2e for Connections + active-workstream
// attribution. The previous timeline e2e specs all seeded
// `/v1/timeline/events` directly, which validates the side-panel
// proxy + render path but bypasses the actual chrome.tabs
// observation path. This spec drives REAL chrome.tabs navigations,
// lets the timeline observer fire, force-drains the spool, and
// asserts the Connections panel surfaces every visit + the
// visit_in_workstream attribution edge for the ambient ones.
//
// Flow (single browser, single companion):
//   1. Launch fresh Chromium + extension.
//   2. Spawn test companion + open side panel + seed companion config.
//   3. Toggle sidetrack.timeline.enabled = true and stamp
//      sidetrack.activeWorkstreamId = <wsId> in chrome.storage.local.
//   4. Reload the SW so it re-runs initializeTimelineWiring with the
//      gate now ON (the wiring is one-shot at boot per the privacy
//      posture in src/timeline/wiring.ts).
//   5. Drive real chrome.tabs navigations through goto() with
//      page.route() returning small stub HTML responses so we don't
//      need network access. chrome.tabs.onUpdated fires the timeline
//      observer for each.
//   6. Send the new force-drain runtime message; the alarm-driven
//      drain runs every 60 s in MV3 which is too slow for a test.
//   7. Wait for /v1/timeline to settle; open Connections, anchor on
//      the workstream, assert every visit appears + the ambient
//      ones surface visit_in_workstream.

const URL_HN = 'https://news.ycombinator.com/item?id=42_real_tabs';
const URL_BLOG = 'https://xint.io/blog/copy-fail-linux-distributions';
const URL_SEARCH = 'https://www.google.com/search?q=copy_file_range+linux+CVE';
const URL_CHAT = 'https://chatgpt.com/c/real_tabs_thread';
const URL_AMBIENT = 'https://copy.fail/';
const URL_PR = 'https://github.com/zyingfei/switchboard/pull/42_real_tabs';
const URL_VIDEO = 'https://www.youtube.com/watch?v=real_tabs_demo';

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

const apiPost = async (comp: TestCompanion, path: string, body: unknown): Promise<unknown> => {
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

test.describe('connections — real chrome.tabs navigation drives the timeline observer', () => {
  test.skip(
    process.env['SIDETRACK_E2E_SKIP_LIVE_BROWSERS'] === '1',
    'set SIDETRACK_E2E_SKIP_LIVE_BROWSERS=1 to skip when CfT is unavailable',
  );
  test.setTimeout(180_000);

  let companion: TestCompanion | null = null;
  let runtime: ExtensionRuntime | null = null;

  test.afterAll(async () => {
    if (runtime !== null) await runtime.close();
    if (companion !== null) await companion.close();
    runtime = null;
    companion = null;
  });

  test('every navigated URL becomes a timeline-visit node in connections + ambient ones get visit_in_workstream', async () => {
    companion = await startTestCompanion();
    runtime = await launchExtensionRuntime({ forceLocalProfile: true });

    // Stub network for every URL the test will navigate through —
    // we don't need real responses, just enough for chrome.tabs
    // .onUpdated to fire with status === 'complete'. Only intercept
    // http(s) — chrome-extension:// resources must pass through.
    await runtime.context.route(/^https?:\/\//u, async (route) => {
      const url = route.request().url();
      if (ALL_URLS.some((target) => url.startsWith(target.split('?')[0]))) {
        const title = url.startsWith('https://news.ycombinator.com')
          ? 'HN thread'
          : url.startsWith('https://xint.io')
            ? 'xint blog'
            : url.startsWith('https://www.google.com')
              ? 'google search'
              : url.startsWith('https://chatgpt.com')
                ? 'chat'
                : url.startsWith('https://copy.fail')
                  ? 'copy.fail'
                  : url.startsWith('https://github.com')
                    ? 'pr'
                    : 'video';
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<!doctype html><title>${title}</title><body><h1>${title}</h1></body>`,
        });
        return;
      }
      // Anything else (extension assets, local resources) goes through.
      await route.fallback();
    });

    // Open side panel, seed companion settings, then enable timeline +
    // stamp the active-workstream id in chrome.storage.local.
    const wsRes = (await apiPost(companion, '/v1/workstreams', {
      title: 'Real-tabs research',
    })) as { data: { bac_id: string } };
    const wsId = wsRes.data.bac_id;

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
      'sidetrack.timeline.enabled': true,
      'sidetrack.activeWorkstreamId': wsId,
    });

    // Tell the SW to re-run initializeTimelineWiring now that the
    // gate is true. Without this, the gate-check at SW boot has
    // already short-circuited and no chrome.tabs listeners are
    // registered.
    const reinitResult = await runtime.sendRuntimeMessage(panel, {
      type: 'sidetrack.timeline.reinit',
    });
    expect((reinitResult as { ok?: boolean } | null)?.ok).toBe(true);

    // Drive REAL chrome.tabs navigations — every page.goto on a
    // brand-new tab fires chrome.tabs.onUpdated which the timeline
    // observer is now listening on. The 30 s observer-coalesce
    // window is per-tab, so we open a fresh tab per URL.
    for (const url of ALL_URLS) {
      const t = await runtime.context.newPage();
      await t.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      // Brief pause so the SW has time to handle onUpdated → admit.
      await new Promise((r) => setTimeout(r, 200));
      await t.close();
    }

    // Force-drain via the new runtime message so the test doesn't
    // wait on the 60 s alarm cadence.
    const drainSender = await runtime.context.newPage();
    await drainSender.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
      waitUntil: 'domcontentloaded',
    });
    let drainResult: unknown = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      drainResult = await runtime.sendRuntimeMessage(drainSender, {
        type: 'sidetrack.timeline.force-drain',
      });
      const r = drainResult as {
        ok?: boolean;
        drain?: { uploaded?: number; remaining?: number };
      } | null;
      if (r !== null && r.ok === true && (r.drain?.uploaded ?? 0) >= ALL_URLS.length) {
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    await drainSender.close();

    // Poll companion's connections snapshot until every URL appears
    // as a timeline-visit node. Class B freshness budget is 30 s
    // post-emit.
    const startedMs = Date.now();
    let lastNodes: { id: string; metadata?: Record<string, unknown> }[] = [];
    let lastEdges: { kind: string; fromNodeId: string; toNodeId: string }[] = [];
    const wantNodeIds = ALL_URLS.map((u) => `timeline-visit:${stripTrailingSlash(u)}`);
    let allSeen = false;
    while (Date.now() - startedMs < 60_000) {
      const env = (await apiGet(companion, '/v1/connections')) as ConnectionsEnvelope;
      lastNodes = env.data.snapshot.nodes;
      lastEdges = env.data.snapshot.edges;
      const ids = new Set(lastNodes.map((n) => n.id));
      if (wantNodeIds.every((w) => ids.has(w))) {
        allSeen = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!allSeen) {
      // eslint-disable-next-line no-console
      console.error('[real-tabs] FINAL nodes:', JSON.stringify(lastNodes.map((n) => n.id)));
    }
    expect(allSeen).toBe(true);

    // Every timeline visit must carry the active workstream id in
    // metadata (the side-panel observer stamped it before emit).
    for (const want of wantNodeIds) {
      const node = lastNodes.find((n) => n.id === want);
      expect(node).toBeDefined();
      expect((node?.metadata ?? {})['workstreamId']).toBe(wsId);
    }

    // The visit_in_workstream edge must exist for every visit; the
    // ambient (non-thread, non-search) ones are the load-bearing
    // ones since they have no other attachment to the workstream.
    const wsEdges = lastEdges.filter(
      (e) => e.kind === 'visit_in_workstream' && e.toNodeId === `workstream:${wsId}`,
    );
    const wsEdgeFromIds = new Set(wsEdges.map((e) => e.fromNodeId));
    for (const want of wantNodeIds) {
      expect(wsEdgeFromIds.has(want)).toBe(true);
    }

    // Render the side panel anchored on the workstream and confirm
    // the DOM surfaces every visit + the active-workstream hint chip
    // for at least one ambient one.
    await panel.bringToFront();
    await panel.reload({ waitUntil: 'domcontentloaded' });
    await expect(panel.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible({
      timeout: 30_000,
    });
    await panel.getByRole('tab', { name: 'Connections' }).click();
    await expect(panel.getByTestId('connections-view')).toBeVisible({ timeout: 10_000 });
    const input = panel.getByTestId('connections-anchor-input');
    await input.click();
    await input.fill(`workstream:${wsId}`);
    await input.press('Enter');
    await expect(panel.getByTestId('connections-groups')).toBeVisible({ timeout: 30_000 });
    for (const want of wantNodeIds) {
      await expect(panel.getByTestId(`node-${want}`)).toBeVisible();
    }
  });
});

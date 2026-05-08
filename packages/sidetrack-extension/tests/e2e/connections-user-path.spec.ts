import { expect, test, type Page } from '@playwright/test';

import { startTestCompanion, type TestCompanion } from './helpers/companion';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import { SETTINGS_KEY, SETUP_KEY } from './helpers/sidepanel';

// Fully user-path e2e — exercises the same path a real user would
// take, end to end:
//   1. Side panel opens with companion configured (only the companion
//      port + bridge key are seeded; everything else is set via UI).
//   2. User creates a workstream via the WorkstreamPicker and selects
//      it from the workboard. No companion HTTP /v1/workstreams seed.
//   3. User opens Settings → Timeline observation, flips the toggle
//      ON, clicks "Grant URL access" so chrome.permissions.request
//      runs from a real user-gesture context.
//   4. User drives real chrome.tabs navigations through page.goto().
//      The route stub feeds tiny HTML so the test isn't network-
//      bound; chrome.tabs.onUpdated still fires for every navigation
//      so the timeline observer captures URL + title.
//   5. Test asserts visit_in_workstream attribution surfaces in the
//      Connections panel — the active workstream the user just
//      created in step 2.
//
// What is NOT seeded by this spec (every step happens via UI):
//   - timeline-enabled gate (sidetrack.timeline.enabled)
//   - active-workstream-id (sidetrack.activeWorkstreamId)
//   - workstream creation through the companion HTTP API
//   - host-permission grant (chrome.permissions.request runs from a
//     real button click)
//
// What IS still seeded (technical-layer scope, acceptable):
//   - companion port + bridge key (chrome.storage.local — there's no
//     UI flow for first-time companion provisioning that doesn't
//     require manual paste of the bridge key)
//   - real-URL responses are stubbed via context.route (the test
//     verifies the navigation-event chain, not page contents)
//   - spool drain is forced via the runtime message (without it the
//     test would wait on the 60 s alarm cadence)

const URL_HN = 'https://news.ycombinator.com/item?id=user_path_42';
const URL_BLOG = 'https://xint.io/blog/copy-fail-linux-distributions';
const URL_SEARCH = 'https://www.google.com/search?q=user_path+linux+CVE';
const URL_CHAT = 'https://chatgpt.com/c/user_path_thread';
const URL_AMBIENT = 'https://copy.fail/';
const URL_VIDEO = 'https://www.youtube.com/watch?v=user_path_demo';

const ALL_URLS = [URL_HN, URL_BLOG, URL_SEARCH, URL_CHAT, URL_AMBIENT, URL_VIDEO];

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

const WORKSTREAM_TITLE = 'User-path research';

test.describe('connections — fully user-path e2e (no setup-state seeding)', () => {
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

  test('user creates ws → enables timeline → grants permission → navigates → attribution lands', async () => {
    companion = await startTestCompanion();
    runtime = await launchExtensionRuntime({ forceLocalProfile: true });

    // Stub https responses so page.goto resolves without network. Only
    // intercept https — chrome-extension:// must pass through.
    await runtime.context.route(/^https?:\/\//u, async (route) => {
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

    // Open the side panel + seed only the companion connection.
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

    // ── Step 1: create + select workstream via UI ─────────────────────
    await panel.getByRole('button', { name: 'Add sub-workstream' }).click();
    await panel.getByPlaceholder('New workstream name…').fill(WORKSTREAM_TITLE);
    await panel.getByRole('button', { name: 'Create', exact: true }).click();
    // After create the picker stays open so the user can click into
    // the new workstream. Wait for the row to appear, then click.
    const wsRow = panel.locator('.ws-picker-row', { hasText: WORKSTREAM_TITLE }).first();
    await expect(wsRow).toBeVisible({ timeout: 15_000 });
    await wsRow.click();
    // The workstream bar should now display the new title.
    await expect(panel.locator('.ws-name', { hasText: WORKSTREAM_TITLE })).toBeVisible({
      timeout: 10_000,
    });

    // The workstream id should now be persisted in
    // chrome.storage.local under sidetrack.activeWorkstreamId — no
    // direct seed, the UI's useEffect pushed it. Read it back so we
    // can assert metadata + edges later.
    const activeWsId = await panel.evaluate(async () => {
      const got = await chrome.storage.local.get('sidetrack.activeWorkstreamId');
      const v = got['sidetrack.activeWorkstreamId'];
      return typeof v === 'string' ? v : null;
    });
    expect(activeWsId).toBeTruthy();
    if (activeWsId === null) throw new Error('active workstream id not persisted');

    // ── Step 2: open Settings → Timeline → toggle ON ──────────────────
    await panel.getByRole('button', { name: 'Settings' }).click();
    const timelineSection = panel.getByTestId('settings-timeline-section');
    await expect(timelineSection).toBeVisible({ timeout: 10_000 });
    // The Modal renders many sections; the Timeline section sits well
    // below the fold. Scroll it into view inside the modal-scroll
    // container before clicking. Playwright's scrollIntoViewIfNeeded
    // walks up to find the scrollable ancestor.
    await timelineSection.scrollIntoViewIfNeeded();
    const toggle = panel.getByTestId('settings-timeline-toggle');
    await expect(toggle).not.toBeChecked();
    // The input is visually hidden via clip-rect (see style.css
    // .switch input[type='checkbox']) so Playwright considers it
    // outside the viewport. Click the surrounding label — which
    // natively forwards the click to the input's onChange.
    const toggleLabel = panel.locator('label.switch', { hasText: 'Observe browser activity' });
    await toggleLabel.click();
    await expect(toggle).toBeChecked();
    // The notice line should mention the new state.
    await expect(panel.getByTestId('settings-timeline-notice')).toBeVisible();

    // ── Step 3: grant URL access (optional host permission) ──────────
    // Optional-permission dialogs auto-grant in Playwright's Chromium
    // launch (no UI dialog appears). If chrome.permissions.request
    // ever changes to require an explicit dialog accept, add a
    // page.on('dialog', d => d.accept()) listener before the click.
    const grantBtn = panel.getByTestId('settings-timeline-grant-permission');
    if (await grantBtn.isVisible().catch(() => false)) {
      await grantBtn.scrollIntoViewIfNeeded();
      await grantBtn.click();
      // Wait for the status row to flip to granted.
      await expect(panel.getByTestId('settings-timeline-permission-status')).toContainText(
        'granted',
        { timeout: 10_000 },
      );
    }
    // Close the modal by clicking the footer Close button. The
    // header has its own aria-label="Close" icon; we want the
    // footer one (the .btn-ghost text button).
    await panel.locator('button.btn.btn-ghost', { hasText: 'Close' }).click();

    // ── Step 4: drive REAL chrome.tabs navigations ────────────────────
    for (const url of ALL_URLS) {
      const t = await runtime.context.newPage();
      await t.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 200));
      await t.close();
    }

    // Force-drain the spool — production cadence is 60 s.
    const drainSender = await runtime.context.newPage();
    await drainSender.goto(
      `chrome-extension://${runtime.extensionId}/sidepanel.html`,
      { waitUntil: 'domcontentloaded' },
    );
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const r = (await runtime.sendRuntimeMessage(drainSender, {
        type: 'sidetrack.timeline.force-drain',
      })) as { ok?: boolean; drain?: { uploaded?: number; remaining?: number } } | null;
      if (r !== null && r.ok === true && (r.drain?.uploaded ?? 0) >= ALL_URLS.length) {
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    await drainSender.close();

    // ── Step 5: assert visit_in_workstream attribution ────────────────
    const wantNodeIds = ALL_URLS.map((u) => `timeline-visit:${stripTrailingSlash(u)}`);
    const startedMs = Date.now();
    let lastNodes: { id: string; metadata?: Record<string, unknown> }[] = [];
    let lastEdges: { kind: string; fromNodeId: string; toNodeId: string }[] = [];
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
      console.error('[user-path] FINAL nodes:', JSON.stringify(lastNodes.map((n) => n.id)));
    }
    expect(allSeen).toBe(true);

    // Every visit must carry the workstream id stamped by the observer.
    for (const want of wantNodeIds) {
      const node = lastNodes.find((n) => n.id === want);
      expect(node).toBeDefined();
      expect((node?.metadata ?? {})['workstreamId']).toBe(activeWsId);
    }
    // visit_in_workstream edges from every visit to the workstream.
    const wsEdgeFromIds = new Set(
      lastEdges
        .filter(
          (e) => e.kind === 'visit_in_workstream' && e.toNodeId === `workstream:${activeWsId}`,
        )
        .map((e) => e.fromNodeId),
    );
    for (const want of wantNodeIds) {
      expect(wsEdgeFromIds.has(want)).toBe(true);
    }

    // Render the Connections panel and verify the DOM also shows the
    // visits — proves the round-trip is fully wired (UI created the
    // workstream, UI enabled the gate, browser observed, materializer
    // graphed, side-panel renders).
    await panel.getByRole('tab', { name: 'Connections' }).click();
    await expect(panel.getByTestId('connections-view')).toBeVisible({ timeout: 10_000 });
    const input = panel.getByTestId('connections-anchor-input');
    await input.click();
    await input.fill(`workstream:${activeWsId}`);
    await input.press('Enter');
    await expect(panel.getByTestId('connections-groups')).toBeVisible({ timeout: 30_000 });
    for (const want of wantNodeIds) {
      await expect(panel.getByTestId(`node-${want}`)).toBeVisible();
    }
  });
});

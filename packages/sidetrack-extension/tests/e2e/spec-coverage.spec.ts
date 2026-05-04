// Coverage-by-spec: each test maps to one item from
// `/Users/yingfei/Downloads/bac-design-spec.html`. Synthetic-only —
// uses the seed-and-skip-wizard pattern, no real providers, fast.
import { expect, test, type Page } from '@playwright/test';

import { startProviderFixtureServer, type FixtureServer } from './helpers/fixtures';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';

const SETUP_KEY = 'sidetrack:setupCompleted';
const THREADS_KEY = 'sidetrack.threads';
const WORKSTREAMS_KEY = 'sidetrack.workstreams';
const CAPTURE_NOTES_KEY = 'sidetrack.captureNotes';
const REMINDERS_KEY = 'sidetrack.reminders';

const seedAndOpen = async (
  runtime: ExtensionRuntime,
  values: Record<string, unknown>,
): Promise<Page> => {
  const page = await runtime.context.newPage();
  await page.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
    waitUntil: 'domcontentloaded',
  });
  // Wipe any sidetrack-prefixed leftovers (CDP-attached profile may
  // have state from earlier runs).
  await page.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const toRemove = Object.keys(all).filter((k) => k.startsWith('sidetrack'));
    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove);
    }
  });
  await runtime.seedStorage(page, { [SETUP_KEY]: true, ...values });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible();
  return page;
};

const ws = (id: string, title: string, privacy: 'private' | 'shared' = 'shared') => ({
  bac_id: id,
  revision: `rev_${id}`,
  title,
  children: [] as string[],
  tags: [] as string[],
  checklist: [] as unknown[],
  privacy,
  updatedAt: new Date().toISOString(),
});

const thread = (overrides: Record<string, unknown> = {}) => {
  const now = new Date().toISOString();
  return {
    bac_id: `bac_thread_${Math.random().toString(36).slice(2, 10)}`,
    provider: 'claude',
    threadUrl: `https://claude.ai/chat/${Math.random().toString(36).slice(2, 10)}`,
    title: 'Test thread',
    lastSeenAt: now,
    status: 'active',
    trackingMode: 'manual',
    primaryWorkstreamId: 'bac_ws_default',
    tags: [] as string[],
    ...overrides,
  };
};

test.describe('spec coverage (synthetic)', () => {
  // Spec §Threads Tracking logic — All Threads buckets + dot colors
  // carry lifecycle; "Needs organize" keeps the only explicit pill.
  test('lifecycle buckets render all five states correctly', async () => {
    let runtime: ExtensionRuntime | undefined;
    const opened: Page[] = [];
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const wsId = 'bac_ws_lifecycle';
      const now = Date.now();
      const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
      const today = new Date(now).toISOString();

      const tUnread = thread({
        bac_id: 'bac_thread_unread',
        title: 'Reply received - unread',
        primaryWorkstreamId: wsId,
        lastTurnRole: 'assistant',
        lastSeenAt: today,
      });
      const tWaiting = thread({
        bac_id: 'bac_thread_waiting',
        title: 'Awaiting your reply',
        primaryWorkstreamId: wsId,
        lastTurnRole: 'user',
        lastSeenAt: today,
      });
      const tReplied = thread({
        bac_id: 'bac_thread_replied',
        title: 'You replied last',
        primaryWorkstreamId: wsId,
        lastTurnRole: 'assistant',
        lastSeenAt: today,
      });
      const tStale = thread({
        bac_id: 'bac_thread_stale',
        title: 'Stale thread',
        primaryWorkstreamId: wsId,
        lastTurnRole: 'assistant',
        lastSeenAt: eightDaysAgo,
      });
      const tNeeds = thread({
        bac_id: 'bac_thread_needs',
        title: 'Needs organize',
        primaryWorkstreamId: wsId,
        status: 'needs_organize',
        lastSeenAt: today,
      });

      const page = await seedAndOpen(runtime, {
        [WORKSTREAMS_KEY]: [ws(wsId, 'Lifecycle')],
        [THREADS_KEY]: [tUnread, tWaiting, tReplied, tStale, tNeeds],
        // tUnread has an active reminder -> Unread reply bucket.
        [REMINDERS_KEY]: [
          {
            bac_id: 'bac_reminder_unread',
            threadId: 'bac_thread_unread',
            provider: 'claude',
            detectedAt: today,
            status: 'new',
          },
        ],
      });
      opened.push(page);
      await page.getByRole('tab', { name: 'All threads' }).click();

      // Assert each lifecycle bucket / row affordance renders.
      await expect(
        page
          .locator('.thread-bucket-unread .thread', {
            has: page.locator('.name', { hasText: 'Reply received' }),
          })
          .locator('.dot.signal'),
      ).toBeVisible();
      await expect(
        page
          .locator('.thread-bucket-waiting .thread', {
            has: page.locator('.name', { hasText: 'Awaiting your reply' }),
          })
          .locator('.dot.amber'),
      ).toBeVisible();
      await expect(
        page
          .locator('.thread-bucket-normal .thread', {
            has: page.locator('.name', { hasText: 'You replied last' }),
          })
          .locator('.dot.green'),
      ).toBeVisible();
      await expect(
        page
          .locator('.thread', {
            has: page.locator('.name', { hasText: 'Stale thread' }),
          })
          .locator('.dot.gray'),
      ).toBeVisible();
      await expect(
        page
          .locator('.thread', { has: page.locator('.name', { hasText: 'Needs organize' }) })
          .locator('.lifecycle-pill'),
      ).toContainText('Needs organize');
    } finally {
      for (const p of opened) await p.close().catch(() => undefined);
      await runtime?.close();
    }
  });

  // Spec §Thread operations.1 — Move thread to different workstream.
  test('move thread to a different workstream', async () => {
    let runtime: ExtensionRuntime | undefined;
    const opened: Page[] = [];
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const t = thread({ title: 'Movable thread', primaryWorkstreamId: 'bac_ws_a' });
      const page = await seedAndOpen(runtime, {
        [WORKSTREAMS_KEY]: [ws('bac_ws_a', 'Source'), ws('bac_ws_b', 'Destination')],
        [THREADS_KEY]: [t],
      });
      opened.push(page);

      // Switch to the source workstream first so the thread row shows.
      await page.getByRole('tab', { name: 'All threads' }).click();
      await expect(page.locator('.thread .name', { hasText: 'Movable thread' })).toBeVisible();
      // v2 design pass: Move now lives behind the ⋯ overflow menu.
      const movableRow = page.locator('.thread', {
        has: page.locator('.name', { hasText: 'Movable thread' }),
      });
      await movableRow.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Move to workstream…', exact: true }).click();
      // Move-to picker shows; click "Destination".
      const destButton = page.getByRole('button', { name: /Destination/ });
      await destButton.last().click();

      // Storage assertion — primaryWorkstreamId now points to bac_ws_b.
      await page.waitForTimeout(500);
      const moved = await page.evaluate(async (key) => {
        const s = await chrome.storage.local.get([key]);
        return (s[key] as { primaryWorkstreamId?: string }[])[0]?.primaryWorkstreamId;
      }, THREADS_KEY);
      expect(moved).toBe('bac_ws_b');
    } finally {
      for (const p of opened) await p.close().catch(() => undefined);
      await runtime?.close();
    }
  });

  // Spec §Thread operations.3 — Queue follow-up, with copy/dismiss.
  test('queue: create → expand → copy → dismiss flow', async () => {
    let runtime: ExtensionRuntime | undefined;
    const opened: Page[] = [];
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const t = thread({ title: 'Queue host' });
      const page = await seedAndOpen(runtime, {
        [WORKSTREAMS_KEY]: [ws('bac_ws_default', 'Default')],
        [THREADS_KEY]: [t],
      });
      opened.push(page);
      await page.getByRole('tab', { name: 'All threads' }).click();

      // v2 design pass: Queue now lives behind the ⋯ overflow menu.
      const row = page.locator('.thread', {
        has: page.locator('.name', { hasText: 'Queue host' }),
      });
      await row.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Queue follow-up', exact: true }).click();
      await row.getByPlaceholder(/Ask next/i).fill('What about edge case X?');
      await row.getByRole('button', { name: 'Add' }).click();

      // After Add, the expand list auto-opens (submitQueueFollowUp sets
      // queueExpandFor=threadId). The pill reads "1 queued" and the
      // item text is already visible.
      await expect(row.getByText('1 queued')).toBeVisible({ timeout: 5_000 });
      await expect(row.getByText('What about edge case X?')).toBeVisible();

      // Dismiss the item — pill drops to 0 (filter is status==='pending').
      await row.getByRole('button', { name: 'Dismiss' }).click();
      await expect(row.getByText('1 queued')).toHaveCount(0, { timeout: 5_000 });
    } finally {
      for (const p of opened) await p.close().catch(() => undefined);
      await runtime?.close();
    }
  });

  // Spec §Workstream View — picker search + inline-create UX.
  test('workstream picker: search filters list', async () => {
    let runtime: ExtensionRuntime | undefined;
    const opened: Page[] = [];
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const page = await seedAndOpen(runtime, {
        [WORKSTREAMS_KEY]: [
          ws('bac_ws_alpha', 'Alpha research'),
          ws('bac_ws_beta', 'Beta planning'),
          ws('bac_ws_gamma', 'Gamma rollout'),
        ],
        [THREADS_KEY]: [],
      });
      opened.push(page);

      // Open picker by clicking the workstream name.
      await page.getByRole('button', { name: /not set/ }).click();
      await expect(page.getByPlaceholder('Search workstreams…')).toBeVisible();

      // All three rows visible.
      await expect(page.locator('.ws-picker-row', { hasText: 'Alpha research' })).toBeVisible();
      await expect(page.locator('.ws-picker-row', { hasText: 'Beta planning' })).toBeVisible();
      await expect(page.locator('.ws-picker-row', { hasText: 'Gamma rollout' })).toBeVisible();

      // Type "Beta" → only Beta remains.
      await page.getByPlaceholder('Search workstreams…').fill('Beta');
      await expect(page.locator('.ws-picker-row', { hasText: 'Beta planning' })).toBeVisible();
      await expect(page.locator('.ws-picker-row', { hasText: 'Alpha research' })).toHaveCount(0);
      await expect(page.locator('.ws-picker-row', { hasText: 'Gamma rollout' })).toHaveCount(0);
    } finally {
      for (const p of opened) await p.close().catch(() => undefined);
      await runtime?.close();
    }
  });

  // Spec §Recent captures — manual note creation.
  test('captures: add a manual note via "+ note" composer', async () => {
    let runtime: ExtensionRuntime | undefined;
    const opened: Page[] = [];
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const page = await seedAndOpen(runtime, {
        [WORKSTREAMS_KEY]: [ws('bac_ws_n', 'Notes home')],
        [THREADS_KEY]: [],
        [CAPTURE_NOTES_KEY]: [],
      });
      opened.push(page);

      await page.getByRole('button', { name: /\+ note/ }).click();
      await page.getByRole('textbox').fill('Remember to verify the redaction list.');
      await page.getByRole('button', { name: 'Save note' }).click();

      // Storage round-trip: note persists.
      await page.waitForTimeout(500);
      const persisted = await page.evaluate(async (key) => {
        const s = await chrome.storage.local.get([key]);
        const notes = s[key] as { text: string }[];
        return notes.map((n) => n.text);
      }, CAPTURE_NOTES_KEY);
      expect(persisted).toContain('Remember to verify the redaction list.');

      // UI: rendered in the Captures section.
      await expect(
        page.locator('.capture-note').getByText('Remember to verify the redaction list.'),
      ).toBeVisible();
    } finally {
      for (const p of opened) await p.close().catch(() => undefined);
      await runtime?.close();
    }
  });

  // Spec §Workstream View — "If current panel isn't tracked, page stays
  // at last status. Else, workstream should show the current tab's
  // workstream and focus on it."
  test("auto-focus: side panel switches to the current tab's workstream", async () => {
    let runtime: ExtensionRuntime | undefined;
    let fixtureServer: FixtureServer | undefined;
    const opened: Page[] = [];
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      fixtureServer = await startProviderFixtureServer();
      // Active tab needs to point at a thread URL we have tracked. Use
      // a real fixture URL so chrome.tabs.query returns it as the
      // active tab (a non-routable URL would resolve as chrome-error).
      const trackedUrl = `${fixtureServer.origin}/chatgpt.html`;
      const t = thread({
        title: 'Tracked under Beta',
        threadUrl: trackedUrl,
        primaryWorkstreamId: 'bac_ws_beta',
      });
      const page = await seedAndOpen(runtime, {
        [WORKSTREAMS_KEY]: [ws('bac_ws_alpha', 'Alpha'), ws('bac_ws_beta', 'Beta')],
        [THREADS_KEY]: [t],
      });
      opened.push(page);

      // Open the tracked URL in a new tab → currentTab → side panel
      // useEffect picks up primaryWorkstreamId='bac_ws_beta' → ws-bar
      // shows "Beta". (about:blank goto is enough — the URL doesn't
      // need to actually resolve, only that getActiveTab returns it.)
      const trackedTab = await runtime.context.newPage();
      opened.push(trackedTab);
      await trackedTab.goto(trackedUrl, { waitUntil: 'domcontentloaded' });
      await trackedTab.bringToFront();
      // Reload the side panel so its state.currentTab is recomputed
      // by the background's currentTabThread() (which queries the
      // active tab via chrome.tabs.query).
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible();

      // Workstream bar's name button should now read "Beta".
      await expect(page.locator('.ws-name')).toContainText('Beta', { timeout: 5_000 });
    } finally {
      for (const p of opened) await p.close().catch(() => undefined);
      await runtime?.close();
      await fixtureServer?.close();
    }
  });
});

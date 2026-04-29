import { expect, test } from '@playwright/test';

import { startProviderFixtureServer, type FixtureServer } from './helpers/fixtures';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';

const SETUP_KEY = 'sidetrack:setupCompleted';
const THREADS_KEY = 'sidetrack.threads';
const WORKSTREAMS_KEY = 'sidetrack.workstreams';

test('archive restore: an archived thread reappears in the workboard after Settings → Restore', async () => {
  let fixtureServer: FixtureServer | undefined;
  let runtime: ExtensionRuntime | undefined;

  try {
    fixtureServer = await startProviderFixtureServer();
    runtime = await launchExtensionRuntime();

    const seederPage = await runtime.context.newPage();
    await seederPage.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
      waitUntil: 'domcontentloaded',
    });

    const threadUrl = `${fixtureServer.origin}/archive-restore-thread.html`;
    const now = new Date().toISOString();

    await runtime.seedStorage(seederPage, {
      [SETUP_KEY]: true,
      [WORKSTREAMS_KEY]: [
        {
          bac_id: 'bac_ws_archive',
          revision: 'rev_local_seed',
          title: 'Cold storage',
          children: [],
          tags: [],
          checklist: [],
          privacy: 'shared',
          updatedAt: now,
        },
      ],
      [THREADS_KEY]: [
        {
          bac_id: 'bac_thread_archived',
          provider: 'gemini',
          threadUrl,
          title: 'Old experiment notes',
          lastSeenAt: now,
          status: 'archived',
          // Both fields set to 'archived' is what updateThreadTracking
          // produces in production; this mirrors that.
          trackingMode: 'archived',
          primaryWorkstreamId: 'bac_ws_archive',
          tags: [],
        },
      ],
    });

    await seederPage.reload({ waitUntil: 'domcontentloaded' });
    await expect(seederPage.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible();

    // Confirm the archived thread is hidden from the visible workboard
    // (visibleThreads filters trackingMode === 'archived').
    await seederPage.getByRole('tab', { name: 'All threads' }).click();
    // The thread row should not be visible (visibleThreads filters
    // trackingMode='archived'). The thread name still exists inside
    // hidden modal markup (composer / dispatch confirm) — check the
    // actual workboard list.
    await expect(
      seederPage.locator('.thread .name', { hasText: 'Old experiment notes' }),
    ).toHaveCount(0);

    // Open Settings → Archived threads.
    await seederPage.getByRole('button', { name: 'Settings' }).click();
    await expect(seederPage.getByRole('heading', { name: 'Archived threads' })).toBeVisible();
    await expect(seederPage.getByText('Old experiment notes')).toBeVisible();

    // Restore. State refresh happens via runAction → sendRequest. We
    // skip an in-modal disappearance check (the workboard underneath
    // the Settings overlay also picks up the restored row, which would
    // confuse a global getByText). Just close the modal and assert the
    // workboard.
    await seederPage.getByRole('button', { name: 'Restore' }).click();
    await seederPage.getByRole('button', { name: 'Close' }).first().click();

    // The thread is back in the workboard as a visible row in the
    // Cold storage workstream.
    await seederPage.getByRole('tab', { name: 'All threads' }).click();
    await expect(
      seederPage.locator('.thread .name', { hasText: 'Old experiment notes' }),
    ).toBeVisible({ timeout: 10_000 });
  } finally {
    await runtime?.close();
    await fixtureServer?.close();
  }
});

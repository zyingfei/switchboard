import { expect, test } from '@playwright/test';

import { isRuntimeResponse, messageTypes } from '../../src/messages';
import { startProviderFixtureServer, type FixtureServer } from './helpers/fixtures';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';

const SETUP_KEY = 'sidetrack:setupCompleted';
const THREADS_KEY = 'sidetrack.threads';
const WORKSTREAMS_KEY = 'sidetrack.workstreams';

const assertOk = (response: unknown): void => {
  if (!isRuntimeResponse(response)) {
    throw new Error('Background returned a non-Sidetrack response.');
  }
  if (!response.ok) {
    throw new Error(response.error);
  }
};

test('fork lineage: a captured thread linked to a tracked parent renders the "↰ from" lineage row', async () => {
  let fixtureServer: FixtureServer | undefined;
  let runtime: ExtensionRuntime | undefined;

  try {
    fixtureServer = await startProviderFixtureServer();
    runtime = await launchExtensionRuntime({ forceLocalProfile: true });

    const seederPage = await runtime.context.newPage();
    await seederPage.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
      waitUntil: 'domcontentloaded',
    });

    const parentUrl = `${fixtureServer.origin}/parent-thread.html`;
    const childUrl = `${fixtureServer.origin}/forked-thread.html`;
    const now = new Date().toISOString();

    await runtime.seedStorage(seederPage, {
      [SETUP_KEY]: true,
      [WORKSTREAMS_KEY]: [
        {
          bac_id: 'bac_ws_research',
          revision: 'rev_local_seed',
          title: 'Research',
          children: [],
          tags: [],
          checklist: [],
          // 'shared' so titles render verbatim — private would mask them.
          privacy: 'shared',
          updatedAt: now,
        },
      ],
      [THREADS_KEY]: [
        {
          bac_id: 'bac_thread_parent',
          provider: 'claude',
          threadUrl: parentUrl,
          title: 'Learning Review and Optimization',
          lastSeenAt: now,
          status: 'active',
          trackingMode: 'manual',
          primaryWorkstreamId: 'bac_ws_research',
          tags: [],
          lastTurnRole: 'assistant',
        },
      ],
    });

    await seederPage.reload({ waitUntil: 'domcontentloaded' });
    await expect(seederPage.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible();
    await seederPage.getByRole('tab', { name: 'All threads' }).click();
    await expect(
      seederPage.getByText('Learning Review and Optimization', { exact: false }),
    ).toBeVisible({ timeout: 10_000 });

    // Inject a synthetic capture for a child thread that names the parent
    // via forkedFromTitle. The background should resolve this against the
    // tracked parent and persist parentThreadId on the new row.
    const childCaptureResponse = await runtime.sendRuntimeMessage(seederPage, {
      type: messageTypes.autoCapture,
      capture: {
        provider: 'claude',
        threadUrl: childUrl,
        title: 'Forked: deeper into the optimization angle',
        capturedAt: new Date().toISOString(),
        forkedFromTitle: 'Learning Review and Optimization',
        forkedFromUrl: parentUrl,
        turns: [
          {
            role: 'user',
            text: 'continue from the previous thread but focus on memoization tradeoffs',
            ordinal: 0,
            capturedAt: new Date().toISOString(),
          },
          {
            role: 'assistant',
            text: 'Memoization shines when ...',
            ordinal: 1,
            capturedAt: new Date().toISOString(),
          },
        ],
      },
    });
    assertOk(childCaptureResponse);

    // Force a state refresh so the side panel re-renders against the
    // updated thread list.
    const refreshed = await runtime.sendRuntimeMessage(seederPage, {
      type: messageTypes.getWorkboardState,
    });
    assertOk(refreshed);

    // Child thread now shows the lineage line linking back to the parent.
    await expect(seederPage.getByText('Forked: deeper into the optimization angle')).toBeVisible({
      timeout: 10_000,
    });
    // The parent row gains a "1 fork" badge (rendered as ↳ + "1 fork" in
    // separate spans).
    await expect(seederPage.getByText('1 fork')).toBeVisible();
    // The child row shows "from" pointing at the parent (rendered as ↰ +
    // "from" + the parent name as separate spans).
    await expect(seederPage.getByText('from', { exact: true })).toBeVisible();
  } finally {
    await runtime?.close();
    await fixtureServer?.close();
  }
});

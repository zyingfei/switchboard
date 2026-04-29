import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

import { isRuntimeResponse, messageTypes } from '../../src/messages';
import { startTestCompanion, type TestCompanion } from './helpers/companion';
import { startProviderFixtureServer, type FixtureServer } from './helpers/fixtures';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';

const SETUP_KEY = 'sidetrack:setupCompleted';
const SETTINGS_KEY = 'sidetrack.settings';

const providerFixtures = [
  {
    fixture: 'chatgpt.html',
    label: 'ChatGPT',
    provider: 'chatgpt',
    title: 'ChatGPT Fixture Thread',
  },
  {
    fixture: 'claude.html',
    label: 'Claude',
    provider: 'claude',
    title: 'Claude Fixture Thread',
  },
  {
    fixture: 'gemini.html',
    label: 'Gemini',
    provider: 'gemini',
    title: 'Gemini Fixture Thread',
  },
] as const;

const assertRuntimeSuccess = (response: unknown): void => {
  if (!isRuntimeResponse(response)) {
    throw new Error('Extension runtime returned a non-Sidetrack response.');
  }
  if (!response.ok) {
    throw new Error(response.error);
  }
};

const readAllEventLines = async (vaultPath: string): Promise<string> => {
  const eventsDir = path.join(vaultPath, '_BAC/events');
  const files = await readdir(eventsDir);
  const chunks = await Promise.all(
    files.map((file) => readFile(path.join(eventsDir, file), 'utf8')),
  );
  return chunks.join('\n');
};

test('loads the MV3 bundle in Playwright Chromium and captures provider fixtures', async () => {
  let companion: TestCompanion | undefined;
  let fixtureServer: FixtureServer | undefined;
  let runtime: ExtensionRuntime | undefined;

  try {
    companion = await startTestCompanion();
    fixtureServer = await startProviderFixtureServer();
    runtime = await launchExtensionRuntime();

    const sidepanelPage = await runtime.context.newPage();
    await sidepanelPage.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
      waitUntil: 'domcontentloaded',
    });

    // Skip the wizard and pre-populate companion settings so the side
    // panel boots straight into the workboard talking to the test
    // companion. autoTrack=true so known-provider captures land in
    // Open threads with trackingMode='auto'.
    await runtime.seedStorage(sidepanelPage, {
      [SETUP_KEY]: true,
      [SETTINGS_KEY]: {
        companion: { port: companion.port, bridgeKey: companion.bridgeKey },
        autoTrack: true,
        siteToggles: { chatgpt: true, claude: true, gemini: true },
      },
    });

    await sidepanelPage.reload({ waitUntil: 'domcontentloaded' });
    await expect(sidepanelPage.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible();

    for (const providerFixture of providerFixtures) {
      const providerPage = await runtime.context.newPage();
      await providerPage.goto(
        `${fixtureServer.origin}/${providerFixture.fixture}?provider=${providerFixture.provider}`,
        { waitUntil: 'domcontentloaded' },
      );
      await providerPage.bringToFront();
      const response = await runtime.sendRuntimeMessage(sidepanelPage, {
        type: messageTypes.captureCurrentTab,
      });
      assertRuntimeSuccess(response);
    }

    // Refresh state and switch to the All threads view so the seeded /
    // captured threads (no workstream) all show.
    await sidepanelPage.bringToFront();
    const refreshed = await runtime.sendRuntimeMessage(sidepanelPage, {
      type: messageTypes.getWorkboardState,
    });
    assertRuntimeSuccess(refreshed);
    await sidepanelPage.getByRole('tab', { name: 'All threads' }).click();
    for (const providerFixture of providerFixtures) {
      await expect(
        sidepanelPage.locator('.thread .name', { hasText: providerFixture.title }),
      ).toBeVisible({ timeout: 10_000 });
    }

    const eventLines = await readAllEventLines(companion.vaultPath);
    for (const providerFixture of providerFixtures) {
      expect(eventLines).toContain(`"provider":"${providerFixture.provider}"`);
      expect(eventLines).toContain(`"title":"${providerFixture.title}"`);
    }
  } finally {
    await runtime?.close();
    await fixtureServer?.close();
    await companion?.close();
  }
});

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

import { isRuntimeResponse, messageTypes } from '../../src/messages';
import { startTestCompanion, type TestCompanion } from './helpers/companion';
import { startProviderFixtureServer, type FixtureServer } from './helpers/fixtures';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';

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

// TODO: this spec was written for the pre-rewrite side-panel layout (with
// "Port" + "Bridge key" labels and a "Refresh" button). After the design
// rewrite the wizard hides those controls. The new queue-lifecycle spec
// shows the seed-and-skip-wizard pattern; port the assertions in this
// spec onto the same pattern (use runtime.seedStorage to mark setup
// completed + persist companion settings, then drive the workboard).
test.skip('loads the MV3 bundle in Playwright Chromium and captures provider fixtures', async () => {
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
    await sidepanelPage.getByLabel('Port').fill(String(companion.port));
    await sidepanelPage.getByLabel('Bridge key').fill(companion.bridgeKey);
    await sidepanelPage.getByRole('button', { name: 'Connect' }).click();
    await expect(sidepanelPage.getByText('companion: running')).toBeVisible();

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

    await sidepanelPage.bringToFront();
    await sidepanelPage.getByRole('button', { name: 'Refresh' }).click();
    for (const providerFixture of providerFixtures) {
      await expect(sidepanelPage.getByText(providerFixture.title).first()).toBeVisible();
      await expect(
        sidepanelPage.getByText(new RegExp(`${providerFixture.label} / auto / active`, 'u')),
      ).toBeVisible();
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

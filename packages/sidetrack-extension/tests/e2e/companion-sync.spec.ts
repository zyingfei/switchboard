import { expect, test } from '@playwright/test';

import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import { SETTINGS_KEY, seedAndOpenSidepanel } from './helpers/sidepanel';

const configuredSettings = {
  companion: {
    port: 17_373,
    bridgeKey: 'probe_bridge_key_012345678901234567890123456789',
  },
  autoTrack: false,
  siteToggles: {
    chatgpt: true,
    claude: true,
    gemini: true,
  },
};

test.describe('companion sync (synthetic)', () => {
  test('configured companion settings leave local-only mode and show disconnected state when no companion is reachable', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const page = await seedAndOpenSidepanel(runtime, {});

      await expect(page.locator('.ws-status')).toHaveText('local-only');
      await expect(page.locator('.sys-banner')).toHaveCount(0);

      await page.evaluate(async ({ settingsKey, settings }) => {
        await chrome.storage.local.set({ [settingsKey]: settings });
      }, {
        settingsKey: SETTINGS_KEY,
        settings: configuredSettings,
      });
      await page.reload({ waitUntil: 'domcontentloaded' });

      await expect(page.locator('.ws-status')).toHaveText('vault: disconnected');
      const disconnectedBanner = page.locator('.sys-banner.sys-red');
      await expect(disconnectedBanner).toBeVisible();
      await expect(disconnectedBanner).toContainText('Companion: disconnected');
      await expect(disconnectedBanner.getByRole('button', { name: 'Open setup' })).toBeVisible();

      await page.evaluate(async ({ settingsKey, settings }) => {
        await chrome.storage.local.set({
          [settingsKey]: {
            ...settings,
            companion: {
              ...settings.companion,
              bridgeKey: '',
            },
          },
        });
      }, {
        settingsKey: SETTINGS_KEY,
        settings: configuredSettings,
      });
      await page.reload({ waitUntil: 'domcontentloaded' });

      await expect(page.locator('.ws-status')).toHaveText('local-only');
      await expect(page.locator('.sys-banner')).toHaveCount(0);
    } finally {
      await runtime?.close();
    }
  });
});

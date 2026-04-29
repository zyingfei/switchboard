import { expect, test, type Page } from '@playwright/test';

import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';

const SETTINGS_KEY = 'sidetrack.settings';
const SETUP_KEY = 'sidetrack:setupCompleted';

type SidetrackStorage = Record<string, unknown>;

const readSidetrackStorage = async (page: Page): Promise<SidetrackStorage> => {
  return await page.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.fromEntries(
      Object.entries(all).filter(([key]) => key.startsWith('sidetrack')),
    );
  });
};

const replaceSidetrackStorage = async (page: Page, values: SidetrackStorage): Promise<void> => {
  await page.evaluate(async (nextValues) => {
    const all = await chrome.storage.local.get(null);
    const toRemove = Object.keys(all).filter((key) => key.startsWith('sidetrack'));
    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove);
    }
    if (Object.keys(nextValues).length > 0) {
      await chrome.storage.local.set(nextValues);
    }
  }, values);
};

interface CompanionRecord {
  readonly port?: unknown;
  readonly bridgeKey?: unknown;
}

interface SettingsRecord {
  readonly companion?: CompanionRecord;
}

const hasConfiguredCompanion = (value: unknown): value is SettingsRecord => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const companion = (value as SettingsRecord).companion;
  return (
    companion !== undefined &&
    typeof companion.port === 'number' &&
    typeof companion.bridgeKey === 'string' &&
    companion.bridgeKey.trim().length > 0
  );
};

test.describe('live companion sync (logged-in profile)', () => {
  test.skip(
    () =>
      process.env.SIDETRACK_E2E_LIVE_COMPANION_SYNC === undefined ||
      process.env.SIDETRACK_E2E_LIVE_COMPANION_SYNC.length === 0,
    'opt-in: requires SIDETRACK_E2E_LIVE_COMPANION_SYNC=1',
  );
  test.skip(
    () =>
      (process.env.SIDETRACK_USER_DATA_DIR === undefined ||
        process.env.SIDETRACK_USER_DATA_DIR.length === 0) &&
      (process.env.SIDETRACK_E2E_CDP_URL === undefined ||
        process.env.SIDETRACK_E2E_CDP_URL.length === 0),
    'requires SIDETRACK_USER_DATA_DIR or SIDETRACK_E2E_CDP_URL',
  );

  test('real configured companion settings render synced, clearing them returns the UI to local-only, and restoring them re-syncs', async () => {
    let runtime: ExtensionRuntime | undefined;
    let page: Page | undefined;
    let originalStorage: SidetrackStorage | undefined;

    try {
      runtime = await launchExtensionRuntime();
      page = await runtime.context.newPage();
      await page.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
        waitUntil: 'domcontentloaded',
      });

      originalStorage = await readSidetrackStorage(page);
      const originalSettings = originalStorage[SETTINGS_KEY];
      test.skip(
        !hasConfiguredCompanion(originalSettings),
        'requires an existing sidetrack.settings companion bridgeKey in the attached Chrome profile',
      );

      await replaceSidetrackStorage(page, {
        ...originalStorage,
        [SETUP_KEY]: true,
      });
      await page.reload({ waitUntil: 'domcontentloaded' });

      await expect(page.locator('.ws-status')).toHaveText('vault: synced');
      await expect(page.locator('.sys-banner')).toHaveCount(0);

      await page.evaluate(async (settingsKey) => {
        const current = (await chrome.storage.local.get(settingsKey))[settingsKey] as SettingsRecord;
        await chrome.storage.local.set({
          [settingsKey]: {
            ...current,
            companion: {
              ...current.companion,
              bridgeKey: '',
            },
          },
        });
      }, SETTINGS_KEY);
      await page.reload({ waitUntil: 'domcontentloaded' });

      await expect(page.locator('.ws-status')).toHaveText('local-only');
      await expect(page.locator('.sys-banner')).toHaveCount(0);

      await replaceSidetrackStorage(page, {
        ...originalStorage,
        [SETUP_KEY]: true,
      });
      await page.reload({ waitUntil: 'domcontentloaded' });

      await expect(page.locator('.ws-status')).toHaveText('vault: synced');
      await expect(page.locator('.sys-banner')).toHaveCount(0);
    } finally {
      if (page !== undefined && originalStorage !== undefined) {
        await replaceSidetrackStorage(page, originalStorage);
      }
      await runtime?.close();
    }
  });
});

import { expect, type Page } from '@playwright/test';

import { isRuntimeResponse } from '../../../src/messages';
import type { ExtensionRuntime } from './runtime';

export const SETUP_KEY = 'sidetrack:setupCompleted';
export const SETTINGS_KEY = 'sidetrack.settings';
export const THREADS_KEY = 'sidetrack.threads';
export const WORKSTREAMS_KEY = 'sidetrack.workstreams';
export const REMINDERS_KEY = 'sidetrack.reminders';

export const assertOk = (response: unknown): void => {
  if (!isRuntimeResponse(response)) {
    throw new Error('Background returned a non-Sidetrack response.');
  }
  if (!response.ok) {
    throw new Error(response.error);
  }
};

export const clearSidetrackStorage = async (page: Page): Promise<void> => {
  await page.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const toRemove = Object.keys(all).filter((key) => key.startsWith('sidetrack'));
    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove);
    }
  });
};

export const seedAndOpenSidepanel = async (
  runtime: ExtensionRuntime,
  values: Record<string, unknown>,
): Promise<Page> => {
  const page = await runtime.context.newPage();
  await page.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
    waitUntil: 'domcontentloaded',
  });
  await clearSidetrackStorage(page);
  await runtime.seedStorage(page, { [SETUP_KEY]: true, ...values });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible();
  return page;
};

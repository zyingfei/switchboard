import { expect, test, type Page } from '@playwright/test';

import { messageTypes } from '../../src/messages';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import { assertOk, seedAndOpenSidepanel } from './helpers/sidepanel';

interface StoredThread {
  readonly bac_id: string;
  readonly threadUrl: string;
  readonly parentThreadId?: string;
}

const readThreadByUrl = async (page: Page, url: string): Promise<StoredThread | null> => {
  return await page.evaluate(async (targetUrl) => {
    const state = await chrome.storage.local.get(['sidetrack.threads']);
    const threads = state['sidetrack.threads'] as readonly StoredThread[] | undefined;
    return threads?.find((thread) => thread.threadUrl === targetUrl) ?? null;
  }, url);
};

const captureCurrentTab = async (runtime: ExtensionRuntime, sidepanel: Page, tab: Page) => {
  await tab.bringToFront();
  const response = await runtime.sendRuntimeMessage(sidepanel, {
    type: messageTypes.captureCurrentTab,
  });
  assertOk(response);
  await sidepanel.bringToFront();
  await sidepanel.waitForTimeout(500);
};

test.describe('live fork lineage (logged-in profile)', () => {
  test.skip(
    () =>
      process.env.SIDETRACK_E2E_LIVE_FORK_LINEAGE === undefined ||
      process.env.SIDETRACK_E2E_LIVE_FORK_LINEAGE.length === 0,
    'opt-in: requires SIDETRACK_E2E_LIVE_FORK_LINEAGE=1',
  );
  test.skip(
    () =>
      (process.env.SIDETRACK_USER_DATA_DIR === undefined ||
        process.env.SIDETRACK_USER_DATA_DIR.length === 0) &&
      (process.env.SIDETRACK_E2E_CDP_URL === undefined ||
        process.env.SIDETRACK_E2E_CDP_URL.length === 0),
    'requires SIDETRACK_USER_DATA_DIR or SIDETRACK_E2E_CDP_URL',
  );

  test('Claude branched thread links back to its tracked parent', async () => {
    const parentUrl = process.env.SIDETRACK_E2E_CLAUDE_FORK_PARENT_URL;
    const childUrl = process.env.SIDETRACK_E2E_CLAUDE_FORK_CHILD_URL;
    test.skip(
      parentUrl === undefined ||
        parentUrl.length === 0 ||
        childUrl === undefined ||
        childUrl.length === 0,
      'requires SIDETRACK_E2E_CLAUDE_FORK_PARENT_URL and SIDETRACK_E2E_CLAUDE_FORK_CHILD_URL',
    );

    test.setTimeout(120_000);
    let runtime: ExtensionRuntime | undefined;
    const opened: Page[] = [];
    try {
      runtime = await launchExtensionRuntime();
      const sidepanel = await seedAndOpenSidepanel(runtime, {});
      opened.push(sidepanel);
      await sidepanel.getByRole('tab', { name: 'All threads' }).click();

      const parentPage = await runtime.context.newPage();
      opened.push(parentPage);
      if (parentUrl === undefined || childUrl === undefined) {
        throw new Error(
          'Missing required SIDETRACK_E2E_CLAUDE_FORK_PARENT_URL or SIDETRACK_E2E_CLAUDE_FORK_CHILD_URL.',
        );
      }
      await parentPage.goto(parentUrl, { waitUntil: 'domcontentloaded' });
      await parentPage.waitForTimeout(10_000);
      await captureCurrentTab(runtime, sidepanel, parentPage);

      await expect
        .poll(() => readThreadByUrl(sidepanel, parentUrl), { timeout: 20_000 })
        .not.toBeNull();

      const childPage = await runtime.context.newPage();
      opened.push(childPage);
      await childPage.goto(childUrl, { waitUntil: 'domcontentloaded' });
      await childPage.waitForTimeout(10_000);
      await captureCurrentTab(runtime, sidepanel, childPage);

      await expect
        .poll(() => readThreadByUrl(sidepanel, childUrl), { timeout: 20_000 })
        .not.toBeNull();

      const parent = await readThreadByUrl(sidepanel, parentUrl);
      const child = await readThreadByUrl(sidepanel, childUrl);
      expect(parent?.bac_id).toBeTruthy();
      expect(child?.parentThreadId).toBe(parent?.bac_id);

      await expect(sidepanel.getByText('1 fork')).toBeVisible({ timeout: 10_000 });
      await expect(sidepanel.locator('.thread-lineage')).toContainText('from');
    } finally {
      for (const page of opened) {
        await page.close().catch(() => undefined);
      }
      await runtime?.close();
    }
  });
});

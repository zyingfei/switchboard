// Synthetic e2e for the first-launch Wizard. The unit tests in
// components.test.tsx cover the Wizard component in isolation; this
// spec verifies the App-level integration:
//   - Wizard auto-pops when setupCompleted=null/false AND bridgeKey is empty
//   - "Skip" exits cleanly and persists setupCompleted=true so the
//     wizard doesn't re-pop on the next mount
//
// Note: doesn't use seedAndOpenSidepanel because that helper sets
// setupCompleted=true (which suppresses the wizard).
import { expect, test } from '@playwright/test';

import { clearSidetrackStorage } from './helpers/sidepanel';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';

const SETUP_KEY = 'sidetrack:setupCompleted';

test.describe('first-launch Wizard (synthetic)', () => {
  test('Wizard auto-pops on first launch and Skip persists setupCompleted=true', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const page = await runtime.context.newPage();
      await page.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
        waitUntil: 'domcontentloaded',
      });
      // Fresh first-launch state — no SETUP_KEY, no settings.
      await clearSidetrackStorage(page);
      await page.reload({ waitUntil: 'domcontentloaded' });

      // Wizard should pop without us touching anything.
      const wizard = page.locator('.modal').filter({
        has: page.getByRole('heading', { name: 'Set up Sidetrack' }),
      });
      await expect(wizard).toBeVisible();

      // Modal subtitle shows the current step label.
      await expect(wizard).toContainText(/step \d+ of \d+/u);
      await expect(wizard).toContainText('Welcome');

      // Skip dismisses the wizard. After dismissal, the workboard
      // should mount without the wizard re-popping. The skip
      // affordance is a link-styled button "Use Sidetrack without
      // vault sync →" — not a literal "Skip" button.
      await wizard.getByRole('button', { name: /Use Sidetrack without vault sync/u }).click();
      await expect(wizard).toHaveCount(0);
      await expect(page.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible();

      // Storage round-trip: SETUP_KEY persisted to true.
      const stored = await page.evaluate(async (key) => {
        const all = await chrome.storage.local.get([key]);
        return all[key] ?? null;
      }, SETUP_KEY);
      expect(stored).toBe(true);

      // Reload — wizard does NOT re-pop because setupCompleted=true.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible();
      await expect(
        page.locator('.modal').filter({
          has: page.getByRole('heading', { name: 'Set up Sidetrack' }),
        }),
      ).toHaveCount(0);
    } finally {
      await runtime?.close();
    }
  });

  test('Wizard does NOT auto-pop when setupCompleted=true is already seeded', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const page = await runtime.context.newPage();
      await page.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
        waitUntil: 'domcontentloaded',
      });
      await clearSidetrackStorage(page);
      await runtime.seedStorage(page, { [SETUP_KEY]: true });
      await page.reload({ waitUntil: 'domcontentloaded' });

      await expect(page.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible();
      await expect(
        page.locator('.modal').filter({
          has: page.getByRole('heading', { name: 'Set up Sidetrack' }),
        }),
      ).toHaveCount(0);
    } finally {
      await runtime?.close();
    }
  });
});

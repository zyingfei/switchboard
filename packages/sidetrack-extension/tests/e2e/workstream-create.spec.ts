// Synthetic e2e for the workstream-creation flow via the picker's "+"
// (Add sub-workstream) affordance. Complements workstream-privacy
// which only verifies rendering of seeded workstreams.
import { expect, test } from '@playwright/test';

import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import { WORKSTREAMS_KEY, seedAndOpenSidepanel } from './helpers/sidepanel';

test.describe('workstream creation (synthetic)', () => {
  test('clicking "Add sub-workstream" opens the picker create form; submitting persists a new workstream', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const page = await seedAndOpenSidepanel(runtime, {
        [WORKSTREAMS_KEY]: [
          {
            bac_id: 'bac_ws_existing',
            revision: 'rev_existing',
            title: 'Existing workstream',
            children: [] as string[],
            tags: [] as string[],
            checklist: [] as unknown[],
            privacy: 'shared' as const,
            updatedAt: '2026-04-29T12:00:00.000Z',
          },
        ],
      });

      // Open the picker via the + button on the workstream bar.
      await page.getByRole('button', { name: 'Add sub-workstream' }).click();
      const picker = page.locator('.ws-picker');
      await expect(picker).toBeVisible();

      // Existing workstream renders as a row. The create form is open
      // because we entered via the "+" path (createMode=true).
      await expect(picker.getByText('Existing workstream')).toBeVisible();
      const createInput = picker.locator('.ws-picker-create-input');
      await expect(createInput).toBeVisible();

      // Fill out + submit (Enter key submits the form).
      await createInput.fill('Brand new workstream');
      await createInput.press('Enter');

      // After create the picker stays open but the create form closes
      // and the new workstream renders in the list.
      await expect(picker).toBeVisible();
      await expect(picker.getByText('Brand new workstream')).toBeVisible();

      const persisted = await page.evaluate(
        async (storageKey) => {
          const all = await chrome.storage.local.get([storageKey]);
          const ws = (all[storageKey] ?? []) as { title: string; privacy: string }[];
          return ws.map((w) => ({ title: w.title, privacy: w.privacy }));
        },
        WORKSTREAMS_KEY,
      );
      expect(persisted).toContainEqual({
        title: 'Brand new workstream',
        privacy: 'shared',
      });
    } finally {
      await runtime?.close();
    }
  });

  test('search filters the picker list to matching workstreams', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const ws = (id: string, title: string) => ({
        bac_id: id,
        revision: `rev_${id}`,
        title,
        children: [] as string[],
        tags: [] as string[],
        checklist: [] as unknown[],
        privacy: 'shared' as const,
        updatedAt: '2026-04-29T12:00:00.000Z',
      });
      const page = await seedAndOpenSidepanel(runtime, {
        [WORKSTREAMS_KEY]: [
          ws('bac_ws_alpha', 'Apple research'),
          ws('bac_ws_beta', 'Banana logistics'),
          ws('bac_ws_gamma', 'Cherry archive'),
        ],
      });

      await page.getByRole('button', { name: 'Add sub-workstream' }).click();
      const picker = page.locator('.ws-picker');
      await expect(picker).toBeVisible();

      // All three rows render.
      await expect(picker.getByText('Apple research')).toBeVisible();
      await expect(picker.getByText('Banana logistics')).toBeVisible();
      await expect(picker.getByText('Cherry archive')).toBeVisible();

      // Filtering narrows to just one match.
      await picker.locator('input.ws-picker-search').fill('banana');
      await expect(picker.getByText('Banana logistics')).toBeVisible();
      await expect(picker.getByText('Apple research')).toHaveCount(0);
      await expect(picker.getByText('Cherry archive')).toHaveCount(0);
    } finally {
      await runtime?.close();
    }
  });
});

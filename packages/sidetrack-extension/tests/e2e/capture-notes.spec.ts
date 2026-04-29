// Synthetic e2e for the capture-note edit + delete flow. spec-coverage
// already covers create-via-+note-composer; this fills in the other
// two CRUD paths.
import { expect, test } from '@playwright/test';

import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import { WORKSTREAMS_KEY, seedAndOpenSidepanel } from './helpers/sidepanel';

const CAPTURE_NOTES_KEY = 'sidetrack.captureNotes';

const now = '2026-04-29T12:00:00.000Z';

const ws = (id: string, title: string) => ({
  bac_id: id,
  revision: `rev_${id}`,
  title,
  children: [] as string[],
  tags: [] as string[],
  checklist: [] as unknown[],
  privacy: 'shared' as const,
  updatedAt: now,
});

const note = (id: string, text: string, workstreamId: string) => ({
  bac_id: id,
  kind: 'manual' as const,
  text,
  workstreamId,
  createdAt: now,
  updatedAt: now,
});

test.describe('capture-note edit / delete (synthetic)', () => {
  test('Edit on an existing note opens the composer pre-filled and saves the new text', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const wsId = 'bac_ws_notes';
      const noteId = 'bac_note_alpha';
      const original = 'Original note body';
      const updated = 'Updated note body';

      const page = await seedAndOpenSidepanel(runtime, {
        [WORKSTREAMS_KEY]: [ws(wsId, 'Notes suite')],
        [CAPTURE_NOTES_KEY]: [note(noteId, original, wsId)],
      });

      // App default viewMode is 'workstream' and the picker starts at
      // Inbox (workstreamId=undefined), which filters our seeded note
      // out. Switch to "All threads" view so all notes are visible.
      await page.getByRole('tab', { name: 'All threads' }).click();
      await expect(page.getByText(original)).toBeVisible();

      // Click Edit on that note → composer opens pre-filled.
      const noteRow = page.locator('.capture').filter({ hasText: original });
      await noteRow.getByRole('button', { name: 'Edit' }).click();

      const editor = page.locator('.note-compose textarea');
      await expect(editor).toBeVisible();
      await expect(editor).toHaveValue(original);

      // Replace the text and click "Update note".
      await editor.fill(updated);
      await page.getByRole('button', { name: 'Update note' }).click();

      // After save, the new text appears and the old one doesn't.
      await expect(page.getByText(updated)).toBeVisible();
      await expect(page.getByText(original)).toHaveCount(0);

      // Storage reflects the update.
      const storedText = await page.evaluate(
        async (storageKey) => {
          const all = await chrome.storage.local.get([storageKey]);
          const notes = (all[storageKey] ?? []) as { text: string }[];
          return notes[0]?.text ?? null;
        },
        CAPTURE_NOTES_KEY,
      );
      expect(storedText).toBe(updated);
    } finally {
      await runtime?.close();
    }
  });

  test('Delete on a note removes it from the captures rail and from storage', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const wsId = 'bac_ws_notes';
      const keepId = 'bac_note_keep';
      const dropId = 'bac_note_drop';

      const page = await seedAndOpenSidepanel(runtime, {
        [WORKSTREAMS_KEY]: [ws(wsId, 'Notes suite')],
        [CAPTURE_NOTES_KEY]: [
          note(keepId, 'Keep this note', wsId),
          note(dropId, 'Drop this note', wsId),
        ],
      });

      await page.getByRole('tab', { name: 'All threads' }).click();
      await expect(page.getByText('Keep this note')).toBeVisible();
      await expect(page.getByText('Drop this note')).toBeVisible();

      const dropRow = page.locator('.capture').filter({ hasText: 'Drop this note' });
      await dropRow.getByRole('button', { name: 'Delete' }).click();

      await expect(page.getByText('Drop this note')).toHaveCount(0);
      await expect(page.getByText('Keep this note')).toBeVisible();

      const storedIds = await page.evaluate(
        async (storageKey) => {
          const all = await chrome.storage.local.get([storageKey]);
          const notes = (all[storageKey] ?? []) as { bac_id: string }[];
          return notes.map((n) => n.bac_id);
        },
        CAPTURE_NOTES_KEY,
      );
      expect(storedIds).toEqual([keepId]);
    } finally {
      await runtime?.close();
    }
  });
});

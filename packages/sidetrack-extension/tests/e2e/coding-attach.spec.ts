import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

import {
  seedAndOpenSidepanel,
  SETTINGS_KEY,
  THREADS_KEY,
  WORKSTREAMS_KEY,
} from './helpers/sidepanel';
import { createMockVaultCompanion, type MockVaultCompanion } from './helpers/mockVaultCompanion';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';

const workstreamId = 'bac_ws_coding_attach';

const workstream = {
  bac_id: workstreamId,
  revision: 'rev_coding_attach',
  title: 'Coding attach synthetic',
  children: [] as string[],
  tags: [] as string[],
  checklist: [] as unknown[],
  privacy: 'shared' as const,
  updatedAt: '2026-04-29T00:00:00.000Z',
};

const readTokenRecord = async (
  vaultPath: string,
): Promise<{ readonly file: string; readonly token: string; readonly record: unknown }> => {
  const tokenDir = path.join(vaultPath, '_BAC', 'coding', 'tokens');
  const tokenFiles = (await readdir(tokenDir)).filter((name) => name.endsWith('.json'));
  expect(tokenFiles).toHaveLength(1);
  const file = tokenFiles[0];
  const token = file.replace(/\.json$/u, '');
  return {
    file,
    token,
    record: JSON.parse(await readFile(path.join(tokenDir, file), 'utf8')) as unknown,
  };
};

const expectTokenConsumed = async (vaultPath: string, token: string): Promise<void> => {
  await expect
    .poll(async () => {
      try {
        await access(path.join(vaultPath, '_BAC', 'coding', 'tokens', `${token}.json`));
        return 'present';
      } catch {
        return 'missing';
      }
    })
    .toBe('missing');
};

test.describe('coding attach (synthetic)', () => {
  test('mints a token, renders the session row, then detaches and invalidates reuse', async () => {
    let companion: MockVaultCompanion | undefined;
    let runtime: ExtensionRuntime | undefined;

    try {
      companion = await createMockVaultCompanion();
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      await companion.attach(runtime.context);

      const sidepanel = await seedAndOpenSidepanel(runtime, {
        [SETTINGS_KEY]: {
          companion: { port: companion.port, bridgeKey: companion.bridgeKey },
          autoTrack: false,
          siteToggles: { chatgpt: true, claude: true, gemini: true },
        },
        [THREADS_KEY]: [],
        [WORKSTREAMS_KEY]: [workstream],
      });

      await sidepanel.getByRole('button', { name: 'Attach coding session' }).click();
      await expect(sidepanel.getByRole('heading', { name: 'Attach coding session' })).toBeVisible();
      await sidepanel.locator('select').selectOption({ label: workstream.title });
      await sidepanel.getByRole('button', { name: 'Generate prompt' }).click();
      await expect(sidepanel.locator('.coding-handoff')).toBeVisible();

      const minted = await readTokenRecord(companion.vaultPath);
      expect(minted.token).toHaveLength(16);
      expect(JSON.stringify(minted.record)).toContain(workstreamId);

      const registerResult = await companion.writer.registerCodingSession(
        {
          token: minted.token,
          tool: 'codex',
          cwd: '/tmp/sidetrack-coding-attach',
          branch: 'ux/design-tokens-and-extended-live-tests',
          sessionId: 'synthetic-session',
          name: 'codex · synthetic',
          resumeCommand: 'codex resume synthetic-session',
        },
        'synthetic-register',
      );
      expect(registerResult.workstreamId).toBe(workstreamId);
      await expectTokenConsumed(companion.vaultPath, minted.token);

      await sidepanel.reload({ waitUntil: 'domcontentloaded' });
      await expect(sidepanel.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible();
      await sidepanel.getByRole('button', { name: /not set/ }).click();
      await sidepanel.locator('.ws-picker-row', { hasText: workstream.title }).click();

      await expect(
        sidepanel.locator('.coding-session-row .name', { hasText: 'codex · synthetic' }),
      ).toBeVisible({ timeout: 10_000 });

      const row = sidepanel
        .locator('.coding-session-row')
        .filter({ has: sidepanel.locator('.name', { hasText: 'codex · synthetic' }) });
      await expect(row.locator('.stamp')).toContainText('codex');
      await expect(row.getByRole('button', { name: 'Detach' })).toBeVisible();

      const activeCompanion = companion;
      await expect(async () => {
        await activeCompanion.writer.registerCodingSession(
          {
            token: minted.token,
            tool: 'codex',
            cwd: '/tmp/sidetrack-coding-attach',
            branch: 'reuse-should-fail',
            sessionId: 'synthetic-session-reuse',
            name: 'codex · duplicate',
          },
          'synthetic-register-reuse',
        );
      }).rejects.toThrow(/Attach token/i);

      await row.getByRole('button', { name: 'Detach' }).click();
      await expect(row).toHaveCount(0, { timeout: 10_000 });

      const detached = await companion.writer.listCodingSessions({ workstreamId });
      expect(detached).toHaveLength(1);
      expect(detached[0]?.status).toBe('detached');
    } finally {
      await runtime?.close();
      await companion?.close();
    }
  });
});

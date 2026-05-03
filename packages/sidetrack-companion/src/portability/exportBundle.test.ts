import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { exportSettings } from './exportBundle.js';

const settings = {
  autoSendOptIn: { chatgpt: true, claude: true, gemini: true },
  defaultPacketKind: 'research',
  defaultDispatchTarget: 'claude',
  screenShareSafeMode: false,
  revision: '0',
};

describe('exportSettings', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-export-test-'));
    await mkdir(join(vaultRoot, '_BAC', '.config'), { recursive: true });
    await mkdir(join(vaultRoot, '_BAC', 'workstreams'), { recursive: true });
    await writeFile(
      join(vaultRoot, '_BAC', '.config', 'settings.json'),
      JSON.stringify(settings),
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('exports settings and sorted workstreams while excluding vault contents', async () => {
    await writeFile(
      join(vaultRoot, '_BAC', 'workstreams', 'b.json'),
      JSON.stringify({ bac_id: 'ws_b', title: 'B' }),
      'utf8',
    );
    await writeFile(
      join(vaultRoot, '_BAC', 'workstreams', 'a.json'),
      JSON.stringify({ bac_id: 'ws_a', title: 'A' }),
      'utf8',
    );

    const bundle = await exportSettings(vaultRoot);

    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.settings).toEqual(settings);
    expect(bundle.workstreams.map((workstream) => workstream.bac_id)).toEqual(['ws_a', 'ws_b']);
    expect(bundle.templates).toEqual([]);
  });
});

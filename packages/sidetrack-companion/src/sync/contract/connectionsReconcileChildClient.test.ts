import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildReconcileChildEnv,
  runReconcileInChild,
  setReconcileChildScriptOverride,
} from './connectionsReconcileChildClient.js';

let tempDirs: string[] = [];

afterEach(async () => {
  setReconcileChildScriptOverride(undefined);
  vi.restoreAllMocks();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe('reconcile child env', () => {
  it('forwards the connections store mode into the child process env', () => {
    expect(
      buildReconcileChildEnv({
        PATH: '/bin',
        SIDETRACK_CONNECTIONS_STORE: 'json',
      })['SIDETRACK_CONNECTIONS_STORE'],
    ).toBe('json');
  });

  it('logs post-drain IPC receipt timing for successful child replies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sidetrack-reconcile-child-'));
    tempDirs.push(dir);
    const entry = join(dir, 'child.cjs');
    await writeFile(
      entry,
      [
        "process.on('message', (message) => {",
        "  process.send({ seq: message.seq, ok: true, snapshotRevision: 'rev-child-test' });",
        '});',
      ].join('\n'),
    );
    setReconcileChildScriptOverride(entry);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(runReconcileInChild({ vaultRoot: dir, seq: 7 })).resolves.toEqual({
      seq: 7,
      ok: true,
      snapshotRevision: 'rev-child-test',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[connections-phase] post-drain.ipc-message'),
    );
  });
});

import { describe, expect, it } from 'vitest';

import { pickInstaller } from './index.js';
import type { ExecPort, FilePort } from './types.js';

const fakeFiles = (): FilePort & {
  readonly writes: Map<string, string>;
  readonly removed: string[];
} => {
  const writes = new Map<string, string>();
  const removed: string[] = [];
  return {
    writes,
    removed,
    mkdir: () => Promise.resolve(),
    writeFile: (path: string, body: string) => {
      writes.set(path, body);
      return Promise.resolve();
    },
    rm: (path: string) => {
      removed.push(path);
      writes.delete(path);
      return Promise.resolve();
    },
    exists: (path: string) => Promise.resolve(writes.has(path)),
  };
};

const fakeExec = (): ExecPort & { readonly calls: { file: string; args: readonly string[] }[] } => {
  const calls: { file: string; args: readonly string[] }[] = [];
  return {
    calls,
    execFile: (file: string, args: readonly string[]) => {
      calls.push({ file, args });
      return Promise.resolve();
    },
  };
};

describe('service installers', () => {
  it('installs and uninstalls launchd idempotently', async () => {
    const files = fakeFiles();
    const exec = fakeExec();
    const installer = pickInstaller('darwin', { homeDir: '/home/test', files, exec });

    const result = await installer.install({
      vaultPath: '/vault',
      port: 17373,
      companionBin: '/bin/sidetrack',
    });
    await installer.install({
      vaultPath: '/vault',
      port: 17373,
      companionBin: '/bin/sidetrack',
    });
    await installer.uninstall();
    await installer.uninstall();

    expect(result.path).toBe('/home/test/Library/LaunchAgents/com.sidetrack.companion.plist');
    expect(exec.calls.map((call) => call.file)).toContain('launchctl');
    expect(files.removed).toContain(result.path);
  });

  it('installs and uninstalls systemd user service idempotently', async () => {
    const files = fakeFiles();
    const exec = fakeExec();
    const installer = pickInstaller('linux', { homeDir: '/home/test', files, exec });

    const result = await installer.install({
      vaultPath: '/vault',
      port: 17373,
      companionBin: '/bin/sidetrack',
    });
    await installer.install({
      vaultPath: '/vault',
      port: 17373,
      companionBin: '/bin/sidetrack',
    });
    await installer.uninstall();
    await installer.uninstall();

    expect(result.path).toBe('/home/test/.config/systemd/user/sidetrack-companion.service');
    expect(exec.calls.some((call) => call.args.includes('enable'))).toBe(true);
    expect(files.removed).toContain(result.path);
  });

  it('installs and uninstalls Windows scheduled task idempotently', async () => {
    const exec = fakeExec();
    const installer = pickInstaller('win32', { exec });

    const result = await installer.install({
      vaultPath: 'C:\\vault',
      port: 17373,
      companionBin: 'sidetrack.exe',
    });
    await installer.install({
      vaultPath: 'C:\\vault',
      port: 17373,
      companionBin: 'sidetrack.exe',
    });
    await installer.uninstall();
    await installer.uninstall();

    expect(result.path).toBe('SidetrackCompanion');
    expect(exec.calls.every((call) => call.file === 'schtasks.exe')).toBe(true);
    expect(exec.calls.some((call) => call.args.includes('/Create'))).toBe(true);
  });
});

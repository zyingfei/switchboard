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

  it('launchd installs the local Bun checkout command with managed MCP when requested', async () => {
    const files = fakeFiles();
    const exec = fakeExec();
    const installer = pickInstaller('darwin', { homeDir: '/home/test', files, exec });

    const result = await installer.install({
      vaultPath: '/Users/test/Sidetrack vault',
      port: 17373,
      companionCommand: ['/usr/local/bin/bun', '/repo/packages/sidetrack-companion/dist/cli.js'],
      mcpPort: 8721,
      syncRelayLocalPort: 18443,
    });

    const body = files.writes.get(result.path) ?? '';
    expect(body).toContain('<string>/usr/local/bin/bun</string>');
    expect(body).toContain('<string>--smol</string>');
    expect(body).toContain('<string>/repo/packages/sidetrack-companion/dist/cli.js</string>');
    expect(body).toContain('<string>--vault</string>');
    expect(body).toContain('<string>/Users/test/Sidetrack vault</string>');
    expect(body).toContain('<string>--mcp-port</string>');
    expect(body).toContain('<string>8721</string>');
    expect(body).toContain('<string>--sync-relay-local</string>');
    expect(body).toContain('<string>18443</string>');
    expect(body).not.toContain('sync-rendezvous');
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

  it('systemd unit renders label/exec/respawn/vault/port for the local checkout', async () => {
    const files = fakeFiles();
    const exec = fakeExec();
    const installer = pickInstaller('linux', { homeDir: '/home/test', files, exec });

    const result = await installer.install({
      vaultPath: '/home/test/Sidetrack vault',
      port: 17379,
      companionCommand: ['/usr/local/bin/bun', '/repo/packages/sidetrack-companion/dist/cli.js'],
      mcpPort: 8721,
    });
    const body = files.writes.get(result.path) ?? '';

    // Unit identity.
    expect(result.path.endsWith('sidetrack-companion.service')).toBe(true);
    expect(body).toContain('Description=Sidetrack companion');
    // KeepAlive equivalent: respawn on crash without a tight loop, and no
    // permanent start-limit hold during a flaky startup.
    expect(body).toContain('Restart=always');
    expect(body).toContain('RestartSec=5');
    expect(body).toContain('StartLimitIntervalSec=0');
    expect(body).toContain('WantedBy=default.target');
    // Exec line: --smol Bun checkout, shell-quoted vault (has a space), port.
    expect(body).toContain("ExecStart='/usr/local/bin/bun' '--smol'");
    expect(body).toContain("'/repo/packages/sidetrack-companion/dist/cli.js'");
    expect(body).toContain("'--vault' '/home/test/Sidetrack vault'");
    expect(body).toContain("'--port' '17379'");
    expect(body).toContain("'--mcp-port' '8721'");
    // enable --now gives RunAtLoad; daemon-reload picks up the new unit.
    expect(exec.calls.some((call) => call.args.includes('daemon-reload'))).toBe(true);
    expect(exec.calls.some((call) => call.args.join(' ') === '--user enable --now sidetrack-companion.service')).toBe(true);
  });

  it('launchd plist renders KeepAlive + RunAtLoad for auto-respawn', async () => {
    const files = fakeFiles();
    const exec = fakeExec();
    const installer = pickInstaller('darwin', { homeDir: '/home/test', files, exec });

    const result = await installer.install({
      vaultPath: '/vault',
      port: 17373,
      companionCommand: ['/usr/local/bin/bun', '/repo/dist/cli.js'],
    });
    const body = files.writes.get(result.path) ?? '';

    expect(body).toContain('<key>Label</key><string>com.sidetrack.companion</string>');
    expect(body).toContain('<key>RunAtLoad</key><true/>');
    expect(body).toContain('<key>KeepAlive</key><true/>');
    expect(body).toContain('<string>--vault</string>');
    expect(body).toContain('<string>/vault</string>');
    expect(body).toContain('<string>--port</string>');
    expect(body).toContain('<string>17373</string>');
  });

  it('pickInstaller selects the platform-correct generator', () => {
    const deps = { homeDir: '/home/test' } as const;
    expect(pickInstaller('darwin', deps).path).toBe(
      '/home/test/Library/LaunchAgents/com.sidetrack.companion.plist',
    );
    expect(pickInstaller('linux', deps).path).toBe(
      '/home/test/.config/systemd/user/sidetrack-companion.service',
    );
    expect(pickInstaller('win32', {}).path).toBe('SidetrackCompanion');
    expect(() => pickInstaller('freebsd' as NodeJS.Platform, deps)).toThrow(/unsupported platform/);
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

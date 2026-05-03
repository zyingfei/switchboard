import { dirname, join } from 'node:path';

import type {
  ExecPort,
  FilePort,
  Installer,
  InstallOptions,
  InstallResult,
  ServiceStatus,
} from './types.js';

const UNIT = 'sidetrack-companion.service';

const shellEscape = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const serviceFile = (opts: InstallOptions): string => `[Unit]
Description=Sidetrack companion

[Service]
ExecStart=${shellEscape(opts.companionBin ?? process.execPath)} --vault ${shellEscape(opts.vaultPath)} --port ${String(opts.port)}
Restart=always

[Install]
WantedBy=default.target
`;

export class SystemdInstaller implements Installer {
  readonly path: string;

  constructor(
    homeDir: string,
    private readonly files: FilePort,
    private readonly exec: ExecPort,
  ) {
    this.path = join(homeDir, '.config', 'systemd', 'user', UNIT);
  }

  async install(opts: InstallOptions): Promise<InstallResult> {
    await this.files.mkdir(dirname(this.path));
    await this.files.writeFile(this.path, serviceFile(opts));
    await this.exec.execFile('systemctl', ['--user', 'daemon-reload']);
    await this.exec.execFile('systemctl', ['--user', 'enable', '--now', UNIT]);
    return { platform: 'linux', path: this.path, installed: true, running: true };
  }

  async uninstall(): Promise<void> {
    await this.exec.execFile('systemctl', ['--user', 'disable', '--now', UNIT]).catch(() => undefined);
    await this.files.rm(this.path);
    await this.exec.execFile('systemctl', ['--user', 'daemon-reload']).catch(() => undefined);
  }

  async status(): Promise<ServiceStatus> {
    const installed = await this.files.exists(this.path);
    return { platform: 'linux', installed, running: installed, path: this.path };
  }
}

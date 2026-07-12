import { dirname, join } from 'node:path';

import { buildCompanionServiceCommand } from './command.js';
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

// Mirror of launchd's KeepAlive/RunAtLoad: `enable --now` gives RunAtLoad,
// `Restart=always` + `RestartSec` gives crash respawn without a tight
// restart loop. StartLimitIntervalSec=0 disables systemd's default
// start-limit burst guard so a companion that flaps during startup (e.g.
// waiting on a model download) is not permanently held down after 5 fast
// exits — the §15 30-day window needs it to keep trying, not give up.
const serviceFile = (opts: InstallOptions): string => `[Unit]
Description=Sidetrack companion
StartLimitIntervalSec=0

[Service]
ExecStart=${buildCompanionServiceCommand(opts).map(shellEscape).join(' ')}
Restart=always
RestartSec=5

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
    // Best-effort: keep the --user manager (and thus the companion)
    // running after the user logs out, so the service actually survives
    // an unattended session. Requires no root for the current user's own
    // linger; if the host forbids it we don't fail the install — the
    // service still runs while a session is active.
    await this.exec
      .execFile('loginctl', ['enable-linger', process.env['USER'] ?? ''])
      .catch(() => undefined);
    return { platform: 'linux', path: this.path, installed: true, running: true };
  }

  async uninstall(): Promise<void> {
    await this.exec
      .execFile('systemctl', ['--user', 'disable', '--now', UNIT])
      .catch(() => undefined);
    await this.files.rm(this.path);
    await this.exec.execFile('systemctl', ['--user', 'daemon-reload']).catch(() => undefined);
  }

  async status(): Promise<ServiceStatus> {
    const installed = await this.files.exists(this.path);
    return { platform: 'linux', installed, running: installed, path: this.path };
  }
}

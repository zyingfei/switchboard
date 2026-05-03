import type { ExecPort, Installer, InstallOptions, InstallResult, ServiceStatus } from './types.js';

const TASK_NAME = 'SidetrackCompanion';

const command = (opts: InstallOptions): string =>
  `"${opts.companionBin ?? process.execPath}" --vault "${opts.vaultPath}" --port ${String(opts.port)}`;

export class SchedulerInstaller implements Installer {
  readonly path = TASK_NAME;

  constructor(private readonly exec: ExecPort) {}

  async install(opts: InstallOptions): Promise<InstallResult> {
    await this.exec
      .execFile('schtasks.exe', ['/Delete', '/TN', TASK_NAME, '/F'])
      .catch(() => undefined);
    await this.exec.execFile('schtasks.exe', [
      '/Create',
      '/TN',
      TASK_NAME,
      '/SC',
      'ONLOGON',
      '/TR',
      command(opts),
      '/F',
    ]);
    await this.exec.execFile('schtasks.exe', ['/Run', '/TN', TASK_NAME]).catch(() => undefined);
    return { platform: 'win32', path: TASK_NAME, installed: true, running: true };
  }

  async uninstall(): Promise<void> {
    await this.exec
      .execFile('schtasks.exe', ['/Delete', '/TN', TASK_NAME, '/F'])
      .catch(() => undefined);
  }

  async status(): Promise<ServiceStatus> {
    try {
      await this.exec.execFile('schtasks.exe', ['/Query', '/TN', TASK_NAME]);
      return { platform: 'win32', installed: true, running: true, path: TASK_NAME };
    } catch {
      return { platform: 'win32', installed: false, running: false, path: TASK_NAME };
    }
  }
}

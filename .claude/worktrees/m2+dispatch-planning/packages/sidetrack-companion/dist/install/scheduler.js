import { buildCompanionServiceCommand } from './command.js';
const TASK_NAME = 'SidetrackCompanion';
const command = (opts) => buildCompanionServiceCommand(opts)
    .map((arg) => `"${arg.replaceAll('"', '\\"')}"`)
    .join(' ');
export class SchedulerInstaller {
    exec;
    path = TASK_NAME;
    constructor(exec) {
        this.exec = exec;
    }
    async install(opts) {
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
    async uninstall() {
        await this.exec
            .execFile('schtasks.exe', ['/Delete', '/TN', TASK_NAME, '/F'])
            .catch(() => undefined);
    }
    async status() {
        try {
            await this.exec.execFile('schtasks.exe', ['/Query', '/TN', TASK_NAME]);
            return { platform: 'win32', installed: true, running: true, path: TASK_NAME };
        }
        catch {
            return { platform: 'win32', installed: false, running: false, path: TASK_NAME };
        }
    }
}
//# sourceMappingURL=scheduler.js.map
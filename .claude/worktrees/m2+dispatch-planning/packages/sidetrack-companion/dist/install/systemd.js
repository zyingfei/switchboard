import { dirname, join } from 'node:path';
import { buildCompanionServiceCommand } from './command.js';
const UNIT = 'sidetrack-companion.service';
const shellEscape = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const serviceFile = (opts) => `[Unit]
Description=Sidetrack companion

[Service]
ExecStart=${buildCompanionServiceCommand(opts).map(shellEscape).join(' ')}
Restart=always

[Install]
WantedBy=default.target
`;
export class SystemdInstaller {
    files;
    exec;
    path;
    constructor(homeDir, files, exec) {
        this.files = files;
        this.exec = exec;
        this.path = join(homeDir, '.config', 'systemd', 'user', UNIT);
    }
    async install(opts) {
        await this.files.mkdir(dirname(this.path));
        await this.files.writeFile(this.path, serviceFile(opts));
        await this.exec.execFile('systemctl', ['--user', 'daemon-reload']);
        await this.exec.execFile('systemctl', ['--user', 'enable', '--now', UNIT]);
        return { platform: 'linux', path: this.path, installed: true, running: true };
    }
    async uninstall() {
        await this.exec
            .execFile('systemctl', ['--user', 'disable', '--now', UNIT])
            .catch(() => undefined);
        await this.files.rm(this.path);
        await this.exec.execFile('systemctl', ['--user', 'daemon-reload']).catch(() => undefined);
    }
    async status() {
        const installed = await this.files.exists(this.path);
        return { platform: 'linux', installed, running: installed, path: this.path };
    }
}
//# sourceMappingURL=systemd.js.map
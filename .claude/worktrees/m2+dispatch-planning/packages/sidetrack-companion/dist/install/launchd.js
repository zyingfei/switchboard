import { dirname, join } from 'node:path';
import { buildCompanionServiceCommand } from './command.js';
const LABEL = 'com.sidetrack.companion';
const xmlEscape = (value) => value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
const plist = (opts) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${buildCompanionServiceCommand(opts)
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
export class LaunchdInstaller {
    files;
    exec;
    path;
    constructor(homeDir, files, exec) {
        this.files = files;
        this.exec = exec;
        this.path = join(homeDir, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    }
    async install(opts) {
        await this.files.mkdir(dirname(this.path));
        await this.files.writeFile(this.path, plist(opts));
        await this.exec
            .execFile('launchctl', ['bootout', `gui/${String(process.getuid?.() ?? 0)}`, this.path])
            .catch(() => undefined);
        await this.exec.execFile('launchctl', [
            'bootstrap',
            `gui/${String(process.getuid?.() ?? 0)}`,
            this.path,
        ]);
        return { platform: 'darwin', path: this.path, installed: true, running: true };
    }
    async uninstall() {
        await this.exec
            .execFile('launchctl', ['bootout', `gui/${String(process.getuid?.() ?? 0)}`, this.path])
            .catch(() => undefined);
        await this.files.rm(this.path);
    }
    async status() {
        const installed = await this.files.exists(this.path);
        return { platform: 'darwin', installed, running: installed, path: this.path };
    }
}
//# sourceMappingURL=launchd.js.map
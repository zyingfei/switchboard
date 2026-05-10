import { homedir } from 'node:os';
import { LaunchdInstaller } from './launchd.js';
import { nodeExecPort, nodeFilePort } from './ports.js';
import { SchedulerInstaller } from './scheduler.js';
import { SystemdInstaller } from './systemd.js';
export const pickInstaller = (platform = process.platform, deps = {}) => {
    const homeDir = deps.homeDir ?? homedir();
    const files = deps.files ?? nodeFilePort;
    const exec = deps.exec ?? nodeExecPort;
    if (platform === 'darwin') {
        return new LaunchdInstaller(homeDir, files, exec);
    }
    if (platform === 'linux') {
        return new SystemdInstaller(homeDir, files, exec);
    }
    if (platform === 'win32') {
        return new SchedulerInstaller(exec);
    }
    throw new Error(`unsupported platform: ${platform}`);
};
//# sourceMappingURL=index.js.map
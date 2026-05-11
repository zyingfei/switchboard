import type { ExecPort, FilePort, Installer, InstallOptions, InstallResult, ServiceStatus } from './types.js';
export declare class LaunchdInstaller implements Installer {
    private readonly files;
    private readonly exec;
    readonly path: string;
    constructor(homeDir: string, files: FilePort, exec: ExecPort);
    install(opts: InstallOptions): Promise<InstallResult>;
    uninstall(): Promise<void>;
    status(): Promise<ServiceStatus>;
}
//# sourceMappingURL=launchd.d.ts.map
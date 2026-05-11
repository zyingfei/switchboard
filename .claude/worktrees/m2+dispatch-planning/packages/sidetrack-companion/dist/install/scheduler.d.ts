import type { ExecPort, Installer, InstallOptions, InstallResult, ServiceStatus } from './types.js';
export declare class SchedulerInstaller implements Installer {
    private readonly exec;
    readonly path = "SidetrackCompanion";
    constructor(exec: ExecPort);
    install(opts: InstallOptions): Promise<InstallResult>;
    uninstall(): Promise<void>;
    status(): Promise<ServiceStatus>;
}
//# sourceMappingURL=scheduler.d.ts.map
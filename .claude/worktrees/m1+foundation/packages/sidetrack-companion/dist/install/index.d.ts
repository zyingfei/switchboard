import type { ExecPort, FilePort, Installer } from './types.js';
export declare const pickInstaller: (platform?: NodeJS.Platform, deps?: {
    readonly homeDir?: string;
    readonly files?: FilePort;
    readonly exec?: ExecPort;
}) => Installer;
export type { Installer, InstallOptions, InstallResult, ServiceStatus } from './types.js';
//# sourceMappingURL=index.d.ts.map
export interface InstallOptions {
  readonly vaultPath: string;
  readonly port: number;
  readonly companionBin?: string;
}

export interface InstallResult {
  readonly platform: NodeJS.Platform;
  readonly path: string;
  readonly installed: boolean;
  readonly running: boolean;
}

export interface ServiceStatus {
  readonly installed: boolean;
  readonly running: boolean;
  readonly platform: NodeJS.Platform;
  readonly path?: string;
}

export interface ExecPort {
  readonly execFile: (file: string, args: readonly string[]) => Promise<void>;
}

export interface Installer {
  readonly install: (opts: InstallOptions) => Promise<InstallResult>;
  readonly uninstall: () => Promise<void>;
  readonly status: () => Promise<ServiceStatus>;
}

export interface FilePort {
  readonly mkdir: (path: string) => Promise<void>;
  readonly writeFile: (path: string, body: string) => Promise<void>;
  readonly rm: (path: string) => Promise<void>;
  readonly exists: (path: string) => Promise<boolean>;
}

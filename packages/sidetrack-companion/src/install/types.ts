export interface InstallOptions {
  readonly vaultPath: string;
  readonly port: number;
  // Executable command prefix for the companion. For local checkout
  // installs this is usually [process.execPath, "dist/cli.js"]; for a
  // packaged binary it can be just ["sidetrack-companion"].
  readonly companionCommand?: readonly string[];
  // Legacy packaged-binary shortcut retained for existing tests and
  // callers. Ignored when companionCommand is set.
  readonly companionBin?: string;
  readonly mcpPort?: number;
  readonly mcpBin?: string;
  // Persist sync startup mode for login services. The rendezvous
  // secret itself is intentionally not embedded in the service file;
  // the CLI reads/reuses `_BAC/.config/sync-rendezvous.secret`.
  readonly syncRelay?: string;
  readonly syncRelayLocalPort?: number;
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

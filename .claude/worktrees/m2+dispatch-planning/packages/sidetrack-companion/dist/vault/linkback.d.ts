export interface LinkedNote {
    readonly workstreamId: string;
    readonly notePath: string;
    readonly title: string;
    readonly updatedAt: string;
}
export interface FsDirent {
    readonly name: string;
    readonly isDirectory: () => boolean;
    readonly isFile: () => boolean;
}
export interface FsPort {
    readonly readdir: (path: string) => Promise<readonly FsDirent[]>;
    readonly lstat: (path: string) => Promise<{
        readonly isSymbolicLink: () => boolean;
    }>;
    readonly stat: (path: string) => Promise<{
        readonly size: number;
        readonly mtime: Date;
    }>;
    readonly readFile: (path: string) => Promise<string>;
}
export declare const nodeFsPort: FsPort;
export declare const scanVaultForLinkedNotes: (vaultRoot: string, fs?: FsPort) => Promise<readonly LinkedNote[]>;
//# sourceMappingURL=linkback.d.ts.map
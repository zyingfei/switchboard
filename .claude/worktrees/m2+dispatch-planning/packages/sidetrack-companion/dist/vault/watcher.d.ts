export type VaultChangeKind = 'thread' | 'workstream' | 'dispatch' | 'audit' | 'annotation' | 'recall' | 'other';
export interface VaultChangeEvent {
    readonly type: 'created' | 'modified' | 'deleted';
    readonly relPath: string;
    readonly at: string;
    readonly kind: VaultChangeKind;
}
export interface VaultWatcher {
    readonly close: () => Promise<void>;
}
export declare const createVaultWatcher: (vaultRoot: string, opts: {
    readonly debounceMs?: number;
    readonly onChange: (event: VaultChangeEvent) => void;
}) => VaultWatcher;
//# sourceMappingURL=watcher.d.ts.map
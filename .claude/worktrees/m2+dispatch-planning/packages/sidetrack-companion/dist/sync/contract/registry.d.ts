export type StateClass = 'aggregate-projection' | 'derived-cache' | 'local-only' | 'identity-auth' | 'extraction-revision' | 'plugin-tier-bounded';
export type RecoveryMode = 'replay-event-log' | 'source-scoped-reextract' | 'on-demand-rebuild' | 'spool-drain' | 'none';
export interface SurfaceContract {
    readonly surface: string;
    readonly class: StateClass;
    readonly materializer?: string;
    readonly peerFreshnessMs?: number;
    readonly recovery?: RecoveryMode;
    readonly localOnlyReason?: string;
}
export interface ContractEntry {
    readonly eventType: string;
    readonly surfaces: readonly SurfaceContract[];
}
export declare const KNOWN_MATERIALIZERS: ReadonlySet<string>;
export declare const CONTRACT_REGISTRY: readonly ContractEntry[];
export declare const REGISTERED_EVENT_TYPES: ReadonlySet<string>;
export declare const entriesForMaterializer: (name: string) => readonly ContractEntry[];
export declare const eventTypesForMaterializer: (name: string) => ReadonlySet<string>;
//# sourceMappingURL=registry.d.ts.map
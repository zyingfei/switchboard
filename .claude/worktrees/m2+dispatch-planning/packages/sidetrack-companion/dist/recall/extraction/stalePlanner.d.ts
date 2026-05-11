import type { ExtractionStore } from './store.js';
export type SourceUpgradeStatus = 'current' | 'stored-reextract' | 'live-provider' | 'not-upgradeable';
export interface UpgradePlan {
    readonly bySource: ReadonlyMap<string, SourceUpgradeStatus>;
    readonly counts: {
        readonly current: number;
        readonly storedReextract: number;
        readonly liveProvider: number;
        readonly notUpgradeable: number;
    };
}
export declare const planExtractionUpgrade: (store: ExtractionStore) => Promise<UpgradePlan>;
//# sourceMappingURL=stalePlanner.d.ts.map
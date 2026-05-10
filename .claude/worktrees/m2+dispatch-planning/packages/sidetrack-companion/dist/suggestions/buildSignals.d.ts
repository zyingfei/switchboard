import { type IndexFile } from '../recall/indexFile.js';
import type { SignalSet } from './score.js';
export interface BuildSignalsWorkstream {
    readonly id: string;
    readonly title: string;
    readonly description?: string;
}
type Embedder = (texts: readonly string[]) => Promise<readonly Float32Array[]>;
export declare const buildSignals: (vaultRoot: string, threadId: string, workstreams: readonly BuildSignalsWorkstream[], indexReader?: (path: string) => Promise<IndexFile | null>, embedder?: Embedder) => Promise<SignalSet>;
export {};
//# sourceMappingURL=buildSignals.d.ts.map
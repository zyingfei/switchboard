import MiniSearch from 'minisearch';
import type { LiveVaultSnapshot } from './liveVaultReader.js';
export interface SearchHit {
    readonly kind: 'thread' | 'queue' | 'reminder';
    readonly id: string;
    readonly title: string;
    readonly score: number;
    readonly excerpt: string;
}
interface SearchDocument {
    readonly searchId: string;
    readonly kind: SearchHit['kind'];
    readonly id: string;
    readonly title: string;
    readonly body: string;
    readonly tags: string;
    readonly excerpt: string;
}
type SearchIndex = MiniSearch<SearchDocument>;
export declare const buildIndex: (snapshot: LiveVaultSnapshot) => SearchIndex;
export declare const searchIndex: (snapshot: LiveVaultSnapshot, query: string) => readonly SearchHit[];
export {};
//# sourceMappingURL=searchIndex.d.ts.map
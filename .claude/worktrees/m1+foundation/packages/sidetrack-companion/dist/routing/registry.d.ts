import type { Bucket, BucketPickInput } from './types.js';
export interface BucketRegistry {
    readonly readBuckets: () => Promise<readonly Bucket[]>;
    readonly writeBuckets: (buckets: readonly Bucket[]) => Promise<void>;
    readonly pickBucket: (input: BucketPickInput) => Promise<Bucket>;
}
export declare const createBucketRegistry: (primaryVaultRoot: string) => BucketRegistry;
//# sourceMappingURL=registry.d.ts.map
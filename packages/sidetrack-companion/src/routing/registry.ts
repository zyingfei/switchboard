import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { Bucket, BucketPickInput, Matcher } from './types.js';

interface BucketsDocument {
  readonly buckets: readonly Bucket[];
}

export interface BucketRegistry {
  readonly readBuckets: () => Promise<readonly Bucket[]>;
  readonly writeBuckets: (buckets: readonly Bucket[]) => Promise<void>;
  readonly pickBucket: (input: BucketPickInput) => Promise<Bucket>;
}

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 64);

const defaultBucket = (primaryVaultRoot: string): Bucket => ({
  id: 'default',
  label: 'Default',
  vaultRoot: primaryVaultRoot,
  matchers: [],
});

const bucketsPath = (primaryVaultRoot: string): string =>
  join(primaryVaultRoot, '_BAC', 'buckets.json');

const isMatcher = (value: unknown): value is Matcher => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as { readonly kind?: unknown; readonly value?: unknown };
  return (
    typeof record.value === 'string' &&
    (record.kind === 'workstream' || record.kind === 'provider' || record.kind === 'urlPattern')
  );
};

const parseBucketsDocument = (value: unknown): BucketsDocument => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { buckets: [] };
  }
  const record = value as { readonly buckets?: unknown };
  if (!Array.isArray(record.buckets)) {
    return { buckets: [] };
  }
  const buckets = record.buckets.flatMap((candidate): readonly Bucket[] => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      return [];
    }
    const bucket = candidate as {
      readonly id?: unknown;
      readonly label?: unknown;
      readonly vaultRoot?: unknown;
      readonly matchers?: unknown;
    };
    if (
      typeof bucket.id !== 'string' ||
      bucket.id === 'default' ||
      typeof bucket.label !== 'string' ||
      typeof bucket.vaultRoot !== 'string' ||
      !Array.isArray(bucket.matchers)
    ) {
      return [];
    }
    return [
      {
        id: bucket.id,
        label: bucket.label,
        vaultRoot: bucket.vaultRoot,
        matchers: bucket.matchers.filter(isMatcher),
      },
    ];
  });
  return { buckets };
};

const matcherMatches = (matcher: Matcher, input: BucketPickInput): boolean => {
  if (matcher.kind === 'workstream') {
    return input.workstreamId === matcher.value;
  }
  if (matcher.kind === 'provider') {
    return input.provider === matcher.value;
  }
  if (input.url === undefined) {
    return false;
  }
  try {
    return new RegExp(matcher.value, 'u').test(input.url);
  } catch {
    return input.url.includes(matcher.value);
  }
};

const validateBuckets = async (buckets: readonly Bucket[]): Promise<readonly Bucket[]> => {
  const ids = new Set<string>();
  const normalized: Bucket[] = [];
  for (const bucket of buckets) {
    if (!isAbsolute(bucket.vaultRoot)) {
      throw new Error('bucket vaultRoot must be an absolute path.');
    }
    await stat(bucket.vaultRoot);
    const id = bucket.id.length > 0 ? bucket.id : slugify(bucket.label);
    if (id.length === 0 || id === 'default' || ids.has(id)) {
      throw new Error('bucket ids must be unique non-default slugs.');
    }
    ids.add(id);
    normalized.push({ ...bucket, id });
  }
  return normalized;
};

export const createBucketRegistry = (primaryVaultRoot: string): BucketRegistry => {
  const path = bucketsPath(primaryVaultRoot);
  const readStored = async (): Promise<readonly Bucket[]> => {
    try {
      return parseBucketsDocument(JSON.parse(await readFile(path, 'utf8')) as unknown).buckets;
    } catch {
      return [];
    }
  };

  return {
    async readBuckets() {
      return [defaultBucket(primaryVaultRoot), ...(await readStored())];
    },
    async writeBuckets(buckets) {
      const nonDefault = buckets.filter((bucket) => bucket.id !== 'default');
      const validated = await validateBuckets(nonDefault);
      await mkdir(join(primaryVaultRoot, '_BAC'), { recursive: true });
      await writeFile(path, `${JSON.stringify({ buckets: validated }, null, 2)}\n`, 'utf8');
    },
    async pickBucket(input) {
      const buckets = await readStored();
      return (
        buckets.find((bucket) => bucket.matchers.some((matcher) => matcherMatches(matcher, input))) ??
        defaultBucket(primaryVaultRoot)
      );
    },
  };
};

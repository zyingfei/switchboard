import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
const slugify = (value) => value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 64);
const defaultBucket = (primaryVaultRoot) => ({
    id: 'default',
    label: 'Default',
    vaultRoot: primaryVaultRoot,
    matchers: [],
});
const bucketsPath = (primaryVaultRoot) => join(primaryVaultRoot, '_BAC', 'buckets.json');
const isMatcher = (value) => {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const record = value;
    return (typeof record.value === 'string' &&
        (record.kind === 'workstream' || record.kind === 'provider' || record.kind === 'urlPattern'));
};
const parseBucketsDocument = (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { buckets: [] };
    }
    const record = value;
    if (!Array.isArray(record.buckets)) {
        return { buckets: [] };
    }
    const buckets = record.buckets.flatMap((candidate) => {
        if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
            return [];
        }
        const bucket = candidate;
        if (typeof bucket.id !== 'string' ||
            bucket.id === 'default' ||
            typeof bucket.label !== 'string' ||
            typeof bucket.vaultRoot !== 'string' ||
            !Array.isArray(bucket.matchers)) {
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
const matcherMatches = (matcher, input) => {
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
    }
    catch {
        return input.url.includes(matcher.value);
    }
};
const validateBuckets = async (buckets) => {
    const ids = new Set();
    const normalized = [];
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
export const createBucketRegistry = (primaryVaultRoot) => {
    const path = bucketsPath(primaryVaultRoot);
    const readStored = async () => {
        try {
            return parseBucketsDocument(JSON.parse(await readFile(path, 'utf8'))).buckets;
        }
        catch {
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
            return (buckets.find((bucket) => bucket.matchers.some((matcher) => matcherMatches(matcher, input))) ??
                defaultBucket(primaryVaultRoot));
        },
    };
};
//# sourceMappingURL=registry.js.map
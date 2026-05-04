import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBucketRegistry } from './registry.js';

describe('bucket registry', () => {
  let primary: string;
  let secondary: string;

  beforeEach(async () => {
    primary = await mkdtemp(join(tmpdir(), 'sidetrack-buckets-primary-'));
    secondary = await mkdtemp(join(tmpdir(), 'sidetrack-buckets-secondary-'));
  });

  afterEach(async () => {
    await rm(primary, { recursive: true, force: true });
    await rm(secondary, { recursive: true, force: true });
  });

  it('bootstraps with an implicit default bucket when buckets.json is missing', async () => {
    const registry = createBucketRegistry(primary);

    await expect(registry.readBuckets()).resolves.toEqual([
      { id: 'default', label: 'Default', vaultRoot: primary, matchers: [] },
    ]);
  });

  it('round-trips buckets and uses first-match-wins routing', async () => {
    const registry = createBucketRegistry(primary);
    await registry.writeBuckets([
      {
        id: 'first',
        label: 'First',
        vaultRoot: secondary,
        matchers: [{ kind: 'provider', value: 'chatgpt' }],
      },
      {
        id: 'second',
        label: 'Second',
        vaultRoot: primary,
        matchers: [{ kind: 'provider', value: 'chatgpt' }],
      },
    ]);

    expect(await registry.readBuckets()).toMatchObject([
      { id: 'default', vaultRoot: primary },
      { id: 'first', vaultRoot: secondary },
      { id: 'second', vaultRoot: primary },
    ]);
    await expect(registry.pickBucket({ provider: 'chatgpt' })).resolves.toMatchObject({
      id: 'first',
    });
  });

  it('falls back to default when no matcher applies', async () => {
    const registry = createBucketRegistry(primary);
    await registry.writeBuckets([
      {
        id: 'docs',
        label: 'Docs',
        vaultRoot: secondary,
        matchers: [{ kind: 'urlPattern', value: 'docs.example.test' }],
      },
    ]);

    await expect(registry.pickBucket({ provider: 'claude' })).resolves.toMatchObject({
      id: 'default',
      vaultRoot: primary,
    });
  });
});

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadOrCreateReplica,
  replicaIdPath,
  replicaSeqPath,
} from './replicaId.js';

describe('replica context', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-replica-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('generates a v4 replica id on first start and reuses it after restart', async () => {
    const first = await loadOrCreateReplica(vaultRoot);
    expect(first.created).toBe(true);
    expect(first.replicaId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const onDisk = (await readFile(replicaIdPath(vaultRoot), 'utf8')).trim();
    expect(onDisk).toBe(first.replicaId);

    const second = await loadOrCreateReplica(vaultRoot);
    expect(second.created).toBe(false);
    expect(second.replicaId).toBe(first.replicaId);
  });

  it('regenerates the id if the file holds garbage', async () => {
    await loadOrCreateReplica(vaultRoot);
    await writeFile(replicaIdPath(vaultRoot), 'not-a-uuid\n', 'utf8');

    const recovered = await loadOrCreateReplica(vaultRoot);
    expect(recovered.created).toBe(true);
    expect(recovered.replicaId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('hands out monotonically increasing seq values that survive reload', async () => {
    const ctx = await loadOrCreateReplica(vaultRoot);
    expect(await ctx.nextSeq()).toBe(1);
    expect(await ctx.nextSeq()).toBe(2);
    expect(await ctx.nextSeq()).toBe(3);
    expect(ctx.peekSeq()).toBe(3);

    const onDisk = (await readFile(replicaSeqPath(vaultRoot), 'utf8')).trim();
    expect(onDisk).toBe('3');

    const reloaded = await loadOrCreateReplica(vaultRoot);
    expect(reloaded.peekSeq()).toBe(3);
    expect(await reloaded.nextSeq()).toBe(4);
  });

  it('serializes concurrent nextSeq callers so values are unique and contiguous', async () => {
    const ctx = await loadOrCreateReplica(vaultRoot);
    const results = await Promise.all(
      Array.from({ length: 32 }, () => ctx.nextSeq()),
    );
    const sorted = [...results].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
    expect(ctx.peekSeq()).toBe(32);
  });

  it('observeSeq bumps the counter past peer values but never lowers it', async () => {
    const ctx = await loadOrCreateReplica(vaultRoot);
    await ctx.nextSeq(); // -> 1
    await ctx.observeSeq(10);
    expect(ctx.peekSeq()).toBe(10);
    expect(await ctx.nextSeq()).toBe(11);

    await ctx.observeSeq(5);
    expect(ctx.peekSeq()).toBe(11);
  });

  it('treats a malformed seq file as zero', async () => {
    const first = await loadOrCreateReplica(vaultRoot);
    await first.nextSeq(); // creates the file at value 1
    await writeFile(replicaSeqPath(vaultRoot), 'oops\n', 'utf8');

    const reloaded = await loadOrCreateReplica(vaultRoot);
    expect(reloaded.peekSeq()).toBe(0);
    expect(await reloaded.nextSeq()).toBe(1);
  });

  it('migrates a pre-rename replica-lamport file forward into replica-seq', async () => {
    await mkdir(join(vaultRoot, '_BAC', '.config'), { recursive: true });
    const legacyPath = join(vaultRoot, '_BAC', '.config', 'replica-lamport');
    await writeFile(legacyPath, '42\n', 'utf8');

    const ctx = await loadOrCreateReplica(vaultRoot);
    expect(ctx.peekSeq()).toBe(42);
    expect(await ctx.nextSeq()).toBe(43);

    // Legacy file is removed after migration to avoid two sources of
    // truth.
    await expect(readFile(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readFile(replicaSeqPath(vaultRoot), 'utf8')).trim()).toBe('43');
  });
});

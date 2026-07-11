import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createVaultWriter } from './writer.js';

describe('createVaultWriter — createWorkstream privacy default', () => {
  let vaultRoot: string;
  let writer: ReturnType<typeof createVaultWriter>;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-writer-'));
    writer = createVaultWriter(vaultRoot);
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const readWorkstreamJson = async (bac_id: string): Promise<Record<string, unknown>> => {
    const raw = await readFile(join(vaultRoot, '_BAC', 'workstreams', `${bac_id}.json`), 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  };

  it("create without explicit privacy yields 'private'", async () => {
    const result = await writer.createWorkstream({ title: 'New workstream' }, 'req-1');
    const record = await readWorkstreamJson(result.bac_id);
    expect(record['privacy']).toBe('private');
  });

  it("create with explicit 'shared' still stores 'shared'", async () => {
    const result = await writer.createWorkstream(
      { title: 'Shared workstream', privacy: 'shared' },
      'req-2',
    );
    const record = await readWorkstreamJson(result.bac_id);
    expect(record['privacy']).toBe('shared');
  });

  it("create with explicit 'public' still stores 'public'", async () => {
    const result = await writer.createWorkstream(
      { title: 'Public workstream', privacy: 'public' },
      'req-3',
    );
    const record = await readWorkstreamJson(result.bac_id);
    expect(record['privacy']).toBe('public');
  });

  it("create with explicit 'private' stores 'private'", async () => {
    const result = await writer.createWorkstream(
      { title: 'Private workstream', privacy: 'private' },
      'req-4',
    );
    const record = await readWorkstreamJson(result.bac_id);
    expect(record['privacy']).toBe('private');
  });
});

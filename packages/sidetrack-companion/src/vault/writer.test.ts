import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SettingsRevisionConflictError, WorkstreamRevisionConflictError, createVaultWriter } from './writer.js';

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

// Recursively collect every file path under `root`. Used to assert an
// export never wrote a byte outside the vault boundary.
const collectFiles = async (root: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        out.push(full);
      }
    }
  };
  await walk(root);
  return out;
};

describe('createVaultWriter — export path-traversal confinement', () => {
  let containerRoot: string;
  let vaultRoot: string;
  let writer: ReturnType<typeof createVaultWriter>;

  beforeEach(async () => {
    // Nest the vault one level down so we can assert nothing escaped
    // into the PARENT of the vault (where a `..`-titled workstream
    // would land if the sanitizer/guard were defeated).
    containerRoot = await mkdtemp(join(tmpdir(), 'sidetrack-export-confine-'));
    vaultRoot = join(containerRoot, 'vault');
    await mkdir(vaultRoot, { recursive: true });
    writer = createVaultWriter(vaultRoot);
  });

  afterEach(async () => {
    await rm(containerRoot, { recursive: true, force: true });
  });

  const filesOutsideVault = async (): Promise<string[]> => {
    const all = await collectFiles(containerRoot);
    return all.filter((p) => !p.startsWith(vaultRoot + '/') && p !== vaultRoot);
  };

  it("export of a '.. ..' titled workstream writes nothing outside the vault", async () => {
    const created = await writer.createWorkstream({ title: '.. ..' }, 'req-trav-1');
    const before = await filesOutsideVault();

    const result = await writer.exportWorkstream(created.bac_id, {});

    // Sanitizer remaps the traversal title to the bac_id → the report
    // lands INSIDE the vault, never in the parent directory.
    expect(result.files).toHaveLength(1);
    const reportPath = result.files[0]!.path;
    expect(reportPath.startsWith('..')).toBe(false);
    expect(reportPath).toContain(created.bac_id);
    const onDisk = join(vaultRoot, reportPath);
    await expect(readFile(onDisk, 'utf8')).resolves.toContain(`bac_id: ${created.bac_id}`);

    // Nothing escaped the vault boundary.
    expect(await filesOutsideVault()).toEqual(before);
  });

  it('export of a 4-deep chain of traversal-titled workstreams stays inside the vault', async () => {
    // root → a → b → leaf, every title a directory-escape attempt.
    const root = await writer.createWorkstream({ title: '.. ..' }, 'req-chain-root');
    const a = await writer.createWorkstream(
      { title: '. .', parentId: root.bac_id },
      'req-chain-a',
    );
    const b = await writer.createWorkstream(
      { title: '..', parentId: a.bac_id },
      'req-chain-b',
    );
    const leaf = await writer.createWorkstream(
      { title: '.. .. .. ..', parentId: b.bac_id },
      'req-chain-leaf',
    );
    const before = await filesOutsideVault();

    const result = await writer.exportWorkstream(leaf.bac_id, {});

    expect(result.files).toHaveLength(1);
    const reportPath = result.files[0]!.path;
    // Every segment was neutered to a bac_id — no `..` anywhere.
    expect(reportPath.split('/').includes('..')).toBe(false);
    const onDisk = join(vaultRoot, reportPath);
    await expect(readFile(onDisk, 'utf8')).resolves.toContain(`bac_id: ${leaf.bac_id}`);
    expect(await filesOutsideVault()).toEqual(before);
  });

  it("export of a '_BAC' titled workstream does not write under vault/_BAC", async () => {
    const created = await writer.createWorkstream({ title: '_BAC' }, 'req-bac-1');

    const result = await writer.exportWorkstream(created.bac_id, {});

    const reportPath = result.files[0]!.path;
    // The user-facing report must never land inside the machine-managed
    // _BAC tree. Sanitizer remaps the `_BAC` title to the bac_id.
    expect(reportPath.startsWith('_BAC/')).toBe(false);
    expect(reportPath).toContain(created.bac_id);
    // The only thing under _BAC/workstreams for this id is the sidecar
    // .md + .json — never a `-report<N>.md`.
    const bacWorkstreams = await collectFiles(join(vaultRoot, '_BAC', 'workstreams'));
    expect(bacWorkstreams.some((p) => p.includes('-report'))).toBe(false);
  });

  it('a normal nested workstream exports to the expected tree path with report-N increment', async () => {
    const parent = await writer.createWorkstream({ title: 'Parent WS' }, 'req-norm-p');
    const child = await writer.createWorkstream(
      { title: 'Child WS', parentId: parent.bac_id },
      'req-norm-c',
    );

    const first = await writer.exportWorkstream(child.bac_id, {});
    expect(first.files[0]!.path).toBe('Parent WS/Child WS/Child WS-report1.md');

    const second = await writer.exportWorkstream(child.bac_id, {});
    expect(second.files[0]!.path).toBe('Parent WS/Child WS/Child WS-report2.md');
  });
});

describe('createVaultWriter — updateWorkstream revision conflict', () => {
  let vaultRoot: string;
  let writer: ReturnType<typeof createVaultWriter>;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-ws-rev-'));
    writer = createVaultWriter(vaultRoot);
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const iso = '2026-07-11T00:00:00.000Z';
  const item = (
    id: string,
    text: string,
    checked: boolean,
  ): { id: string; text: string; checked: boolean; createdAt: string; updatedAt: string } => ({
    id,
    text,
    checked,
    createdAt: iso,
    updatedAt: iso,
  });

  const readChecklist = async (bac_id: string): Promise<unknown> => {
    const raw = await readFile(join(vaultRoot, '_BAC', 'workstreams', `${bac_id}.json`), 'utf8');
    return (JSON.parse(raw) as Record<string, unknown>)['checklist'];
  };

  it('rejects a stale revision and leaves the record untouched', async () => {
    const created = await writer.createWorkstream(
      { title: 'Ticket', checklist: [item('i1', 'a', true)] },
      'req-r1',
    );
    // First writer advances the revision.
    const advanced = await writer.updateWorkstream(
      created.bac_id,
      { revision: created.revision, checklist: [item('i1', 'a', true), item('i2', 'b', true)] },
      'req-r2',
    );
    expect(advanced.revision).not.toBe(created.revision);

    // Second writer, still holding the ORIGINAL revision, must be
    // rejected — otherwise it would clobber the freshly-ticked 'b'.
    await expect(
      writer.updateWorkstream(
        created.bac_id,
        { revision: created.revision, checklist: [item('i1', 'a', false)] },
        'req-r3',
      ),
    ).rejects.toBeInstanceOf(WorkstreamRevisionConflictError);
    // A WorkstreamRevisionConflictError is a SettingsRevisionConflictError
    // subclass, so the HTTP layer's existing 409 branch catches it.
    await expect(
      writer.updateWorkstream(
        created.bac_id,
        { revision: created.revision, checklist: [] },
        'req-r3b',
      ),
    ).rejects.toBeInstanceOf(SettingsRevisionConflictError);

    // The on-disk checklist still reflects the FIRST writer's PATCH.
    const checklist = (await readChecklist(created.bac_id)) as { text: string }[];
    expect(checklist.map((c) => c.text)).toEqual(['a', 'b']);
  });

  it('accepts a fresh (matching) revision and applies the PATCH', async () => {
    const created = await writer.createWorkstream({ title: 'Ticket 2' }, 'req-r4');
    const updated = await writer.updateWorkstream(
      created.bac_id,
      { revision: created.revision, checklist: [item('x1', 'x', false)] },
      'req-r5',
    );
    expect(updated.revision).not.toBe(created.revision);
    // The caller's read-revision must never persist onto disk.
    const raw = await readFile(
      join(vaultRoot, '_BAC', 'workstreams', `${created.bac_id}.json`),
      'utf8',
    );
    const record = JSON.parse(raw) as Record<string, unknown>;
    expect(record['revision']).toBe(updated.revision);
    expect(record['revision']).not.toBe(created.revision);
    const checklist = record['checklist'] as { text: string }[];
    expect(checklist.map((c) => c.text)).toEqual(['x']);
  });
});

describe('createVaultWriter — concurrent export report-N allocation', () => {
  let vaultRoot: string;
  let writer: ReturnType<typeof createVaultWriter>;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-export-race-'));
    writer = createVaultWriter(vaultRoot);
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('two simultaneous exports of the same workstream get distinct report paths', async () => {
    const created = await writer.createWorkstream({ title: 'Race WS' }, 'req-race');
    const [a, b] = await Promise.all([
      writer.exportWorkstream(created.bac_id, {}),
      writer.exportWorkstream(created.bac_id, {}),
    ]);
    const pathA = a.files[0]!.path;
    const pathB = b.files[0]!.path;
    // No double-write: the two exports never resolve to the same file.
    expect(pathA).not.toBe(pathB);
    expect(new Set([pathA, pathB])).toEqual(
      new Set(['Race WS/Race WS-report1.md', 'Race WS/Race WS-report2.md']),
    );
    // Both files exist on disk with the workstream body.
    for (const p of [pathA, pathB]) {
      await expect(readFile(join(vaultRoot, p), 'utf8')).resolves.toContain(
        `bac_id: ${created.bac_id}`,
      );
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createLocalWorkstream,
  readWorkstreams,
  updateLocalWorkstream,
} from '../../src/background/state';

const installChromeStorageMock = (): void => {
  const values: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn((query: Record<string, unknown> | string | null | undefined) => {
          if (typeof query === 'string') {
            return Promise.resolve({ [query]: values[query] });
          }
          if (query !== null && query !== undefined && typeof query === 'object') {
            return Promise.resolve(
              Object.fromEntries(
                Object.entries(query).map(([key, fallback]) => [key, values[key] ?? fallback]),
              ),
            );
          }
          return Promise.resolve({ ...values });
        }),
        set: vi.fn((next: Record<string, unknown>) => {
          Object.assign(values, next);
          return Promise.resolve();
        }),
      },
    },
  });
};

describe('updateLocalWorkstream — rename / reparent / detach', () => {
  beforeEach(() => {
    installChromeStorageMock();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const seedTree = async () => {
    const parentA = await createLocalWorkstream({ title: 'Parent A' });
    const parentB = await createLocalWorkstream({ title: 'Parent B' });
    const child = await createLocalWorkstream({ title: 'Child', parentId: parentA.bac_id });
    return { parentA, parentB, child };
  };

  it('renames a workstream without disturbing parent or children', async () => {
    const { parentA, child } = await seedTree();
    const next = await updateLocalWorkstream(child.bac_id, {
      revision: child.revision,
      title: 'Child renamed',
    });
    expect(next?.title).toBe('Child renamed');
    expect(next?.parentId).toBe(parentA.bac_id);
    const all = await readWorkstreams();
    expect(all.find((w) => w.bac_id === parentA.bac_id)?.children).toContain(child.bac_id);
  });

  it('re-parents from parentA to parentB and updates both parents children arrays', async () => {
    const { parentA, parentB, child } = await seedTree();
    const next = await updateLocalWorkstream(child.bac_id, {
      revision: child.revision,
      parentId: parentB.bac_id,
    });
    expect(next?.parentId).toBe(parentB.bac_id);
    const all = await readWorkstreams();
    expect(all.find((w) => w.bac_id === parentA.bac_id)?.children ?? []).not.toContain(
      child.bac_id,
    );
    expect(all.find((w) => w.bac_id === parentB.bac_id)?.children ?? []).toContain(child.bac_id);
  });

  it('detaches with parentId=null — drops parent on the record AND removes self from prior parent', async () => {
    const { parentA, child } = await seedTree();
    const next = await updateLocalWorkstream(child.bac_id, {
      revision: child.revision,
      parentId: null,
    });
    expect(next?.parentId).toBeUndefined();
    const all = await readWorkstreams();
    expect(all.find((w) => w.bac_id === parentA.bac_id)?.children ?? []).not.toContain(
      child.bac_id,
    );
  });

  it('preserves parentId when the update omits it (default partial-update behavior)', async () => {
    const { parentA, child } = await seedTree();
    const next = await updateLocalWorkstream(child.bac_id, {
      revision: child.revision,
      title: 'just-rename',
    });
    expect(next?.parentId).toBe(parentA.bac_id);
    expect(next?.title).toBe('just-rename');
  });
});

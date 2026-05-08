import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeFileAtomic, writeJsonAtomic } from './atomic.js';

describe('atomic vault writes', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sidetrack-atomic-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writeFileAtomic writes the body to the final path', async () => {
    const path = join(root, 'nested', 'record.txt');

    await writeFileAtomic(path, 'ready\n');

    await expect(readFile(path, 'utf8')).resolves.toBe('ready\n');
  });

  it('concurrent writeFileAtomic calls both succeed without exposing partial writes', async () => {
    const path = join(root, 'shared.txt');
    const first = `first:${'a'.repeat(256 * 1024)}\n`;
    const second = `second:${'b'.repeat(256 * 1024)}\n`;
    const completeBodies = new Set(['seed\n', first, second]);
    const observed: string[] = [];
    let writesDone = false;

    await writeFileAtomic(path, 'seed\n');
    const reader = (async (): Promise<void> => {
      while (!writesDone) {
        observed.push(await readFile(path, 'utf8'));
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
    })();

    await Promise.all([writeFileAtomic(path, first), writeFileAtomic(path, second)]);
    writesDone = true;
    await reader;

    const final = await readFile(path, 'utf8');
    expect([first, second]).toContain(final);
    expect(observed.every((body) => completeBodies.has(body))).toBe(true);
  });

  it('cleans up the temp file when the final rename fails', async () => {
    const path = join(root, 'target.txt');
    await mkdir(path);

    await expect(writeFileAtomic(path, 'cannot replace a directory')).rejects.toBeInstanceOf(Error);

    const leftovers = (await readdir(root)).filter(
      (name) => name.startsWith('.target.txt.') && name.endsWith('.tmp'),
    );
    expect(leftovers).toEqual([]);
  });

  it('writeJsonAtomic pretty-prints JSON, round-trips values, and ends with newline', async () => {
    const path = join(root, 'json', 'state.json');
    const value = {
      name: 'Sidetrack',
      enabled: true,
      counts: [1, 2, 3],
      nested: { missing: null, labels: ['alpha', 'beta'] },
    };

    await writeJsonAtomic(path, value);

    const raw = await readFile(path, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toBe(`${JSON.stringify(value, null, 2)}\n`);
    expect(JSON.parse(raw) as unknown).toEqual(value);
  });
});

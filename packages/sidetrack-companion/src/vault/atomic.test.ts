import * as fsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeFileAtomic, writeJsonAtomic } from './atomic.js';

describe('atomic vault writes', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sidetrack-atomic-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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

  it('fsyncs the temp file descriptor AND the parent directory before/after the rename', async () => {
    const path = join(root, 'durable', 'record.txt');
    const dir = join(root, 'durable');

    // Wrap the real `open` so every returned handle records that its
    // `.sync()` was called and which target it belonged to. The temp
    // file (a `.record.txt.<rev>.tmp` under `dir`) and the directory
    // fd (opened on `dir` itself) must BOTH be synced.
    const syncedTargets: string[] = [];
    const realOpen = fsPromises.open.bind(fsPromises);
    const openSpy = vi
      .spyOn(fsPromises, 'open')
      .mockImplementation(async (target, ...rest: unknown[]) => {
        const handle = await (realOpen as typeof fsPromises.open)(
          target as never,
          ...(rest as never[]),
        );
        const realSync = handle.sync.bind(handle);
        handle.sync = async (): Promise<void> => {
          syncedTargets.push(String(target));
          await realSync();
        };
        return handle;
      });

    await writeFileAtomic(path, 'durable\n');

    // The temp fd sync: some target under `dir` whose basename is the
    // temp pattern.
    const tempSynced = syncedTargets.some(
      (t) => basename(t).startsWith('.record.txt.') && t.endsWith('.tmp'),
    );
    expect(tempSynced).toBe(true);
    // The directory fd sync: `dir` opened directly.
    expect(syncedTargets).toContain(dir);

    openSpy.mockRestore();
    await expect(readFile(path, 'utf8')).resolves.toBe('durable\n');
  });

  it('does not fail the write when the directory fsync is unsupported (EINVAL)', async () => {
    const path = join(root, 'noDirSync', 'record.txt');
    const dir = join(root, 'noDirSync');

    // Ensure the directory exists so the dir-open path is reached.
    await mkdir(dir, { recursive: true });

    const realOpen = fsPromises.open.bind(fsPromises);
    const openSpy = vi
      .spyOn(fsPromises, 'open')
      .mockImplementation(async (target, ...rest: unknown[]) => {
        const handle = await (realOpen as typeof fsPromises.open)(
          target as never,
          ...(rest as never[]),
        );
        // Only the directory handle (opened read-only on `dir`) throws
        // an unsupported-fsync error; the temp-file handle syncs fine.
        if (String(target) === dir) {
          handle.sync = async (): Promise<void> => {
            const err = new Error('fsync not supported') as Error & { code: string };
            err.code = 'EINVAL';
            throw err;
          };
        }
        return handle;
      });

    // Must resolve — an unsupported dir fsync is best-effort, never fatal.
    await expect(writeFileAtomic(path, 'still durable\n')).resolves.toBeUndefined();

    openSpy.mockRestore();
    await expect(readFile(path, 'utf8')).resolves.toBe('still durable\n');
  });

  it('does not fail the write when the temp-fd fsync is unsupported (ENOTSUP)', async () => {
    const path = join(root, 'noFdSync', 'record.txt');
    const dir = join(root, 'noFdSync');
    await mkdir(dir, { recursive: true });

    const realOpen = fsPromises.open.bind(fsPromises);
    const openSpy = vi
      .spyOn(fsPromises, 'open')
      .mockImplementation(async (target, ...rest: unknown[]) => {
        const handle = await (realOpen as typeof fsPromises.open)(
          target as never,
          ...(rest as never[]),
        );
        // The temp-file handle (write mode, under `dir`) rejects fsync.
        if (basename(String(target)).startsWith('.record.txt.')) {
          handle.sync = async (): Promise<void> => {
            const err = new Error('fsync not supported') as Error & { code: string };
            err.code = 'ENOTSUP';
            throw err;
          };
        }
        return handle;
      });

    await expect(writeFileAtomic(path, 'fd sync skipped\n')).resolves.toBeUndefined();

    openSpy.mockRestore();
    await expect(readFile(path, 'utf8')).resolves.toBe('fd sync skipped\n');
  });

  it('leaves the ORIGINAL file intact and drops no temp litter when interrupted before rename', async () => {
    const path = join(root, 'interrupted.txt');
    await writeFile(path, 'original\n', 'utf8');

    // Force a failure AFTER the temp file is written but BEFORE the
    // rename by making `rename` throw. The original must survive and no
    // `.interrupted.txt.<rev>.tmp` may be left behind.
    const renameSpy = vi.spyOn(fsPromises, 'rename').mockImplementation(async () => {
      throw new Error('simulated crash before rename');
    });

    await expect(writeFileAtomic(path, 'replacement\n')).rejects.toThrow(
      'simulated crash before rename',
    );

    renameSpy.mockRestore();

    // Original content is untouched.
    await expect(readFile(path, 'utf8')).resolves.toBe('original\n');
    // No temp litter remains.
    const leftovers = (await readdir(root)).filter(
      (name) => name.startsWith('.interrupted.txt.') && name.endsWith('.tmp'),
    );
    expect(leftovers).toEqual([]);
  });
});

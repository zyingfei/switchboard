import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CRASH_EXIT_CODE,
  createCrashHandler,
  installCrashHandlers,
  type CrashRecord,
} from './crashHandler.js';

describe('crash handler', () => {
  let vaultRoot: string | undefined;

  afterEach(async () => {
    if (vaultRoot !== undefined) {
      await rm(vaultRoot, { recursive: true, force: true });
      vaultRoot = undefined;
    }
  });

  it('writes a durable crash record and exits non-zero when invoked with a synthetic error', async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-crash-'));
    const exitCodes: number[] = [];
    const stderr: string[] = [];
    const handle = createCrashHandler({
      getVaultRoot: () => vaultRoot,
      getPhaseId: () => 'phase-42',
      exit: (code) => {
        exitCodes.push(code);
      },
      writeStderr: (text) => {
        stderr.push(text);
      },
      now: () => new Date('2026-07-11T00:00:00.000Z'),
    });

    handle('uncaughtException', new Error('boom'));

    // Exited non-zero, exactly once.
    expect(exitCodes).toEqual([CRASH_EXIT_CODE]);
    expect(CRASH_EXIT_CODE).not.toBe(0);

    // Structured post-mortem on stderr.
    expect(stderr.join('')).toContain('[crash]');
    expect(stderr.join('')).toContain('boom');

    // Durable record under _BAC/diagnostics/crash-<ts>.json.
    const diagDir = join(vaultRoot as string, '_BAC', 'diagnostics');
    const files = await readdir(diagDir);
    const crashFiles = files.filter((f) => f.startsWith('crash-') && f.endsWith('.json'));
    expect(crashFiles).toHaveLength(1);
    const raw = await readFile(join(diagDir, crashFiles[0] as string), 'utf8');
    const record = JSON.parse(raw.trim()) as CrashRecord;
    expect(record.kind).toBe('uncaughtException');
    expect(record.name).toBe('Error');
    expect(record.message).toBe('boom');
    expect(record.stack).toContain('Error: boom');
    expect(record.timestamp).toBe('2026-07-11T00:00:00.000Z');
    expect(record.phaseId).toBe('phase-42');
  });

  it('is re-entrancy guarded — a second invocation still forces exit but writes no second record', async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-crash-'));
    const exitCodes: number[] = [];
    let writes = 0;
    const handle = createCrashHandler({
      getVaultRoot: () => vaultRoot,
      exit: (code) => {
        exitCodes.push(code);
      },
      writeStderr: () => undefined,
      writeCrashRecord: () => {
        writes += 1;
      },
    });

    handle('uncaughtException', new Error('first'));
    handle('unhandledRejection', new Error('second'));

    // Both invocations exit non-zero; only the first writes a record.
    expect(exitCodes).toEqual([CRASH_EXIT_CODE, CRASH_EXIT_CODE]);
    expect(writes).toBe(1);
  });

  it('logs to stderr and still exits when the vault root is unknown (pre-resolution throw)', () => {
    const exitCodes: number[] = [];
    const stderr: string[] = [];
    let writes = 0;
    const handle = createCrashHandler({
      getVaultRoot: () => undefined,
      exit: (code) => {
        exitCodes.push(code);
      },
      writeStderr: (text) => {
        stderr.push(text);
      },
      writeCrashRecord: () => {
        writes += 1;
      },
    });

    handle('uncaughtException', 'a raw string throw');

    expect(exitCodes).toEqual([CRASH_EXIT_CODE]);
    expect(writes).toBe(0);
    expect(stderr.join('')).toContain('a raw string throw');
  });

  it('a throw inside the record writer never masks the exit', () => {
    const exitCodes: number[] = [];
    const handle = createCrashHandler({
      getVaultRoot: () => '/does/not/matter',
      exit: (code) => {
        exitCodes.push(code);
      },
      writeStderr: () => undefined,
      writeCrashRecord: () => {
        throw new Error('disk full');
      },
    });

    // Must not throw out of the handler.
    expect(() => handle('uncaughtException', new Error('boom'))).not.toThrow();
    expect(exitCodes).toEqual([CRASH_EXIT_CODE]);
  });

  it('installCrashHandlers registers + unregisters process listeners', () => {
    const before = process.listenerCount('uncaughtException');
    const uninstall = installCrashHandlers({
      getVaultRoot: () => undefined,
      exit: () => undefined,
      writeStderr: () => undefined,
    });
    expect(process.listenerCount('uncaughtException')).toBe(before + 1);
    expect(process.listenerCount('unhandledRejection')).toBeGreaterThanOrEqual(1);
    uninstall();
    expect(process.listenerCount('uncaughtException')).toBe(before);
  });
});

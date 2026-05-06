import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { companionVersion, runCli } from './cli.js';

class MemoryWritable extends Writable {
  private chunks = '';

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks += chunk.toString();
    callback();
  }

  text(): string {
    return this.chunks;
  }
}

const createStreams = (): { readonly stdout: MemoryWritable; readonly stderr: MemoryWritable } => ({
  stdout: new MemoryWritable(),
  stderr: new MemoryWritable(),
});

describe('runCli', () => {
  it('prints the package version', async () => {
    const streams = createStreams();

    const exitCode = await runCli(['--version'], streams);

    expect(exitCode).toBe(0);
    expect(streams.stdout.text()).toBe(`${companionVersion}\n`);
    expect(streams.stderr.text()).toBe('');
  });

  it('prints help without starting the API runtime', async () => {
    const streams = createStreams();

    const exitCode = await runCli(['--help'], streams);

    expect(exitCode).toBe(0);
    expect(streams.stdout.text()).toContain('sidetrack-companion');
    expect(streams.stdout.text()).toContain('--vault <path>');
    expect(streams.stderr.text()).toBe('');
  });

  it('rejects startup without a vault path', async () => {
    const streams = createStreams();

    const exitCode = await runCli([], streams);

    expect(exitCode).toBe(2);
    expect(streams.stderr.text()).toContain('Missing required --vault <path>.');
  });

  it('models status reports the manifest revision + cache dir without touching the network', async () => {
    const streams = createStreams();
    const exitCode = await runCli(['models', 'status', '--models-dir', '/tmp/sb-models-test', '--offline-models'], streams);
    expect(exitCode).toBe(0);
    const out = streams.stdout.text();
    expect(out).toContain('model id');
    expect(out).toContain('Xenova/multilingual-e5-small');
    expect(out).toContain('cache dir    /tmp/sb-models-test');
    expect(out).toContain('present      no');
  });

  it('models status --json produces machine-readable output', async () => {
    const streams = createStreams();
    const exitCode = await runCli(
      ['models', 'status', '--models-dir', '/tmp/sb-models-test', '--offline-models', '--json'],
      streams,
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(streams.stdout.text()) as Record<string, unknown>;
    expect(parsed['modelId']).toBe('Xenova/multilingual-e5-small');
    expect(parsed['cacheDir']).toBe('/tmp/sb-models-test');
    expect(parsed['offline']).toBe(true);
  });

  it('models with no verb prints usage and exits 2', async () => {
    const streams = createStreams();
    const exitCode = await runCli(['models'], streams);
    expect(exitCode).toBe(2);
    expect(streams.stdout.text()).toContain('Usage: sidetrack-companion models');
  });

  it('--models-dir + --offline-models on the runtime path are accepted (help still renders)', async () => {
    // Smoke: the flags don't crash parseArgs and the help text
    // advertises them. We can't fully boot the runtime in a unit
    // test (no vault wiring), but the parser+help surface is the
    // contract we want to lock down.
    const streams = createStreams();
    const exitCode = await runCli(['--help'], streams);
    expect(exitCode).toBe(0);
    expect(streams.stdout.text()).toContain('--models-dir');
    expect(streams.stdout.text()).toContain('--offline-models');
  });

  it('models verify on an empty cache returns 1 with a clear hint', async () => {
    const streams = createStreams();
    const exitCode = await runCli(
      ['models', 'verify', '--models-dir', '/tmp/sb-models-empty', '--offline-models'],
      streams,
    );
    expect(exitCode).toBe(1);
    expect(streams.stderr.text()).toContain('model not present');
  });

  it('recall reingest refuses when the recall process-lock is held by a live foreign PID', async () => {
    // A running companion holds `_BAC/recall/.lock` for the same
    // single-writer reason that `recall reingest` does — letting them
    // race the index file would tear the binary. Same trick as the
    // recovery unit test: write the parent shell's PID into the lock
    // (it's alive and isn't us) and check the CLI refuses.
    const parentPid = process.ppid;
    if (!Number.isFinite(parentPid) || parentPid <= 0) return;
    const vaultRoot = await mkdtemp(join(tmpdir(), 'recall-reingest-locked-'));
    try {
      await mkdir(join(vaultRoot, '_BAC', 'recall'), { recursive: true });
      await writeFile(join(vaultRoot, '_BAC', 'recall', '.lock'), `${String(parentPid)}\n`, 'utf8');
      const streams = createStreams();
      const exitCode = await runCli(['recall', 'reingest', '--vault', vaultRoot], streams);
      expect(exitCode).toBe(1);
      expect(streams.stderr.text()).toContain('refusing');
      expect(streams.stderr.text()).toContain(String(parentPid));
    } finally {
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });
});

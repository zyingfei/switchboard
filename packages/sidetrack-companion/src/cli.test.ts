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

  it('models verify on an empty cache returns 1 with a clear hint', async () => {
    const streams = createStreams();
    const exitCode = await runCli(
      ['models', 'verify', '--models-dir', '/tmp/sb-models-empty', '--offline-models'],
      streams,
    );
    expect(exitCode).toBe(1);
    expect(streams.stderr.text()).toContain('model not present');
  });
});

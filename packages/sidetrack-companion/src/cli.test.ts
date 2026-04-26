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
});

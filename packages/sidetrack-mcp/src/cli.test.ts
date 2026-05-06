import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { sidetrackToolNames } from './capabilities.js';
import { mcpVersion, runCli } from './cli.js';

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
    expect(streams.stdout.text()).toBe(`${mcpVersion}\n`);
    expect(streams.stderr.text()).toBe('');
  });

  it('lists the M1 read-only tool surface', async () => {
    const streams = createStreams();

    const exitCode = await runCli(['--list-tools'], streams);

    expect(exitCode).toBe(0);
    expect(streams.stdout.text().trim().split('\n')).toEqual(sidetrackToolNames);
  });

  it('rejects startup without a vault path', async () => {
    const streams = createStreams();

    const exitCode = await runCli([], streams);

    expect(exitCode).toBe(2);
    expect(streams.stderr.text()).toContain('Missing required --vault <path>.');
  });

  it('rejects an unsupported transport', async () => {
    await expect(runCli(['--transport', 'sse'], createStreams())).rejects.toThrow(
      '--transport must be either stdio or websocket.',
    );
  });
});

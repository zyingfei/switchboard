import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IndexFile } from '../recall/indexFile.js';
import { buildSignals } from './buildSignals.js';

const vector = (x: number, y: number): Float32Array => {
  const output = new Float32Array(384);
  output[0] = x;
  output[1] = y;
  return output;
};

describe('buildSignals', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-build-signals-test-'));
    await mkdir(join(vaultRoot, '_BAC', 'threads'), { recursive: true });
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('builds lexical, vector, and link signals from vault threads plus index entries', async () => {
    await writeFile(
      join(vaultRoot, '_BAC', 'threads', 'thread_target.json'),
      JSON.stringify({
        bac_id: 'thread_target',
        title: 'Vector recall backend',
        primaryWorkstreamId: 'ws_recall',
      }),
      'utf8',
    );
    await writeFile(
      join(vaultRoot, '_BAC', 'threads', 'thread_member.json'),
      JSON.stringify({
        bac_id: 'thread_member',
        title: 'Recall index member',
        primaryWorkstreamId: 'ws_recall',
      }),
      'utf8',
    );
    const index: IndexFile = {
      modelId: 'stub',
      items: [
        {
          id: 'target:0',
          threadId: 'thread_target',
          capturedAt: '2026-05-03T00:00:00.000Z',
          embedding: vector(1, 0),
        },
        {
          id: 'member:0',
          threadId: 'thread_member',
          capturedAt: '2026-05-03T00:00:00.000Z',
          embedding: vector(1, 0),
        },
      ],
    };

    const signals = await buildSignals(
      vaultRoot,
      'thread_target',
      [
        { id: 'ws_recall', title: 'Recall backend' },
        { id: 'ws_other', title: 'Unrelated design' },
      ],
      () => Promise.resolve(index),
    );

    expect(signals.lexical['ws_recall']).toBeGreaterThan(signals.lexical['ws_other'] ?? 0);
    expect(signals.vector['ws_recall']).toBe(1);
    expect(signals.link['ws_recall']).toBe(1);
    expect(signals.link['ws_other']).toBe(0);
  });
});

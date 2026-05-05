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

  it('rescues the cold-start "hackernews" / "Hacker News Summary" case via trigrams + containment', async () => {
    // Reproduces the exact scenario from scripts/why-no-suggestion.mjs:
    // a fresh "hackernews" workstream with 0 members, and a thread
    // titled "Hacker News Summary May 4". Pre-fix this scored 0 on
    // every signal; with trigram tokens + ws→thread containment
    // it now lands a meaningful lexical score, which combined with
    // the cold-start vector centroid clears the 0.25 threshold.
    await writeFile(
      join(vaultRoot, '_BAC', 'threads', 'thread_hn.json'),
      JSON.stringify({
        bac_id: 'thread_hn',
        title: 'Hacker News Summary May 4',
      }),
      'utf8',
    );
    const threadEmbedding = vector(0.7, 0.3); // arbitrary but consistent
    const index: IndexFile = {
      modelId: 'stub',
      items: [
        {
          id: 'thread_hn:0',
          threadId: 'thread_hn',
          capturedAt: '2026-05-04T00:00:00.000Z',
          embedding: threadEmbedding,
        },
      ],
    };
    // Stub embedder returns a vector close to the thread's so the
    // cold-start cosine is non-trivial but not artificially perfect.
    const stubEmbedder = () =>
      Promise.resolve([vector(0.6, 0.4)] as readonly Float32Array[]);
    const signals = await buildSignals(
      vaultRoot,
      'thread_hn',
      [{ id: 'ws_hn', title: 'hackernews' }],
      () => Promise.resolve(index),
      stubEmbedder,
    );
    expect(signals.lexical['ws_hn']).toBeGreaterThan(0.5);
    expect(signals.vector['ws_hn']).toBeGreaterThan(0);
  });
});

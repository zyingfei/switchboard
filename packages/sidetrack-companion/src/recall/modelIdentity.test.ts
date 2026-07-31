import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'bun:test';

import { RECALL_MODEL, RECALL_MODEL_ID } from './modelManifest.js';
import { embedTextHash } from './embeddingCache.js';
import { VISIT_SIMILARITY_MODEL_ID } from '../connections/visitSimilarity.js';
import { profileFor } from '../recall-v2/model-registry.js';

// E2 — SINGLE MODEL IDENTITY (audit 2026-07-29 §G2/§E2).
//
// Two similarity substrates share one embedder: the materialized visit
// similarity (own embed path + HNSW store) and the recall-v2 doc/chunk vectors
// (feeds the content + ai lanes). Before this, FOUR modules carried their own
// copy of the string 'Xenova/multilingual-e5-small' and THREE carried their own
// copy of the dimension 384. None of the divergences would have failed
// anything loudly:
//   * the visit-similarity revision stamps a modelId that need not match the
//     model that produced its vectors;
//   * recall-v2's retrieval-tuning registry MISSES on an unknown id and
//     silently returns a "safe default" that DISABLES the semantic gap-gate;
//   * the sqlite-vec column width is the vector dimension, and nothing in
//     application code checks vector length on the way in.
//
// These are the compile-and-run assertions that make a half-applied model swap
// impossible. They deliberately do NOT pin the literal value — pinning it would
// just be a fifth copy. They pin the RELATIONSHIP: everything derives from the
// manifest.

/** `src/` root, derived from this test file's own location. */
const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const readSource = async (relativeToSrc: string): Promise<string> =>
  await readFile(join(SRC_DIR, relativeToSrc), 'utf8');

/**
 * Source with `//` and ` * ` comment lines stripped. These assertions are about
 * what the code DECLARES; a comment that quotes the old literal while
 * explaining why it was removed is exactly the documentation we want to keep.
 */
const readCode = async (relativeToSrc: string): Promise<string> =>
  (await readSource(relativeToSrc))
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    })
    .join('\n');

describe('single model identity across similarity substrates', () => {
  it('visit-similarity stamps the manifest model id, not its own literal', () => {
    expect(VISIT_SIMILARITY_MODEL_ID).toBe(RECALL_MODEL.modelId);
  });

  it('the recall-v2 retrieval profile resolves for the manifest model (never the unsafe default)', () => {
    // profileFor strips the '#rev=...#prefix-query-v1' suffix, so both the bare
    // id and the composed RECALL_MODEL_ID must land on the calibrated entry.
    for (const id of [RECALL_MODEL.modelId, RECALL_MODEL_ID]) {
      const profile = profileFor(id);
      expect(profile.modelId).toBe(RECALL_MODEL.modelId);
      // 'default-unsafe' is the fallback that turns the gap-gate off — a
      // retrieval-quality change with no failure attached to it.
      expect(profile.calibratedAt).not.toBe('default-unsafe');
      expect(profile.embeddingDim).toBe(RECALL_MODEL.embeddingDim);
    }
  });

  it('the composed index identity embeds the manifest id AND revision', () => {
    // RECALL_MODEL_ID is what the on-disk index headers are compared against;
    // if it stopped folding the revision, a bug-fix HF revision bump would
    // serve stale vectors instead of marking the index stale.
    expect(RECALL_MODEL_ID).toContain(RECALL_MODEL.modelId);
    expect(RECALL_MODEL_ID).toContain(RECALL_MODEL.revision);
  });

  it('the shared embed-cache key derivation is one function, over the exact text', () => {
    // Every substrate keys the shared cache with THIS function. A second hash
    // over the same texts would put two disjoint keyspaces in one file and
    // guarantee a 0% cross-substrate hit rate — silently, since a miss is
    // indistinguishable from a cold cache.
    const text = 'passage: Example Title\n\nbody text';
    expect(embedTextHash(text)).toBe(embedTextHash(text));
    expect(embedTextHash(text)).not.toBe(embedTextHash(`${text} `));
    // sha256 hex — the width the cache file's record framing assumes.
    expect(embedTextHash(text)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('the recall-v2 vector tables are declared at the manifest dimension', async () => {
    // The vec0 column width IS the embedding dimension. Asserting the DDL is
    // built from the manifest means a dimension change that forgot this file
    // fails here, instead of surfacing as vectors the native extension
    // silently rejects (nothing in application code checks vector length).
    const code = await readCode('recall-v2/store/sqlite.ts');
    expect(code).toContain('RECALL_MODEL.embeddingDim');
    expect(code.toLowerCase()).not.toContain(`float[${String(RECALL_MODEL.embeddingDim)}]`);
  });

  it('no module re-declares the model id as a literal', async () => {
    // The manifest is the one place the literal may appear in executable code.
    // Design-rationale comments elsewhere are fine; this checks the modules
    // that previously held an ASSIGNABLE second copy.
    const suspects = [
      'connections/visitSimilarity.ts',
      'connections/types.ts',
      'producers/visit-resembles-revision.ts',
      'recall-v2/model-registry.ts',
    ];
    for (const relative of suspects) {
      expect(await readCode(relative)).not.toContain(`'${RECALL_MODEL.modelId}'`);
    }
  });
});

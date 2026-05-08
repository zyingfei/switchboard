import { describe, expect, it } from 'vitest';

import { embed, getEmbedder, MODEL_ID } from './embedder.js';

describe('embedder module', () => {
  it('exports the expected lazy embedder interface', () => {
    // V3: identity string includes the manifest revision so a sha
    // bump marks the index stale through lifecycle's check.
    expect(MODEL_ID).toContain('Xenova/multilingual-e5-small');
    expect(MODEL_ID).toContain('rev=');
    expect(MODEL_ID).toContain('prefix-query-v1');
    expect(typeof getEmbedder).toBe('function');
    expect(typeof embed).toBe('function');
  });

  it('gives eval cluster tokens predictable deterministic neighborhoods', async () => {
    const prior = process.env['SIDETRACK_TEST_EMBEDDER'];
    process.env['SIDETRACK_TEST_EMBEDDER'] = '1';
    try {
      const [pgA, pgB, negative] = await embed([
        'query: sidetrack_eval_postgres merge write skew',
        'passage: sidetrack_eval_postgres merge lock ordering',
        'passage: sidetrack_eval_negative invoice aging',
      ]);
      const cosine = (left: Float32Array, right: Float32Array): number =>
        left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
      expect(pgA).toBeDefined();
      expect(pgB).toBeDefined();
      expect(negative).toBeDefined();
      if (pgA === undefined || pgB === undefined || negative === undefined) {
        throw new Error('Expected deterministic test vectors.');
      }
      expect(cosine(pgA, pgB)).toBeGreaterThan(0.95);
      expect(cosine(pgA, negative)).toBeLessThan(0.2);
    } finally {
      if (prior === undefined) {
        delete process.env['SIDETRACK_TEST_EMBEDDER'];
      } else {
        process.env['SIDETRACK_TEST_EMBEDDER'] = prior;
      }
    }
  });

  it.skipIf(process.env['SIDETRACK_RUN_EMBEDDER_TESTS'] !== 'true')(
    'embeds text as a normalized 384-dim vector',
    async () => {
      const [vector] = await embed(['hello']);
      const norm = Math.sqrt(
        Array.from(vector ?? []).reduce((sum, value) => sum + value * value, 0),
      );

      expect(vector).toBeInstanceOf(Float32Array);
      expect(vector).toHaveLength(384);
      expect(norm).toBeGreaterThan(0.99);
      expect(norm).toBeLessThan(1.01);
    },
  );
});

import { describe, expect, it } from 'vitest';

import { embed, getEmbedder, MODEL_ID } from './embedder.js';

describe('embedder module', () => {
  it('exports the expected lazy embedder interface', () => {
    expect(MODEL_ID).toBe('Xenova/multilingual-e5-small#prefix-query-v1');
    expect(typeof getEmbedder).toBe('function');
    expect(typeof embed).toBe('function');
  });

  it.skipIf(process.env['CI'] === 'true')('embeds text as a normalized 384-dim vector', async () => {
    const [vector] = await embed(['hello']);
    const norm = Math.sqrt(Array.from(vector ?? []).reduce((sum, value) => sum + value * value, 0));

    expect(vector).toBeInstanceOf(Float32Array);
    expect(vector).toHaveLength(384);
    expect(norm).toBeGreaterThan(0.99);
    expect(norm).toBeLessThan(1.01);
  });
});

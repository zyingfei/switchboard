import { afterEach, describe, expect, it } from 'vitest';

import { embed, setEmbedderOverride } from './embedder.js';

describe('embedder input policy boundary', () => {
  afterEach(() => {
    setEmbedderOverride(undefined);
  });

  it('hands an override the exact same legacy model inputs as in-process inference', async () => {
    const received: string[][] = [];
    setEmbedderOverride(async (texts) => {
      received.push([...texts]);
      return texts.map(() => new Float32Array(384));
    });

    await embed(['passage: body', 'query: focus']);

    expect(received).toEqual([['query: passage: body', 'query: query: focus']]);
  });
});

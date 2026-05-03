import { performance } from 'node:perf_hooks';

import { INDEX_DIM } from './indexFile.js';

export const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

type FeatureExtractionPipeline = (
    texts: readonly string[],
    options: { readonly pooling: 'mean'; readonly normalize: true },
) => Promise<{ readonly data: ArrayLike<number>; readonly dims?: readonly number[] }>;

let pipelinePromise: Promise<FeatureExtractionPipeline> | undefined;

export const getEmbedder = async (): Promise<FeatureExtractionPipeline> => {
  if (pipelinePromise === undefined) {
    const started = performance.now();
    pipelinePromise = import('@xenova/transformers').then(async (module) => {
      const pipe = (await module.pipeline(
        'feature-extraction',
        MODEL_ID,
      )) as unknown as FeatureExtractionPipeline;
      // eslint-disable-next-line no-console
      console.info(
        `[recall] loaded embedding model ${MODEL_ID} in ${String(Math.round(performance.now() - started))}ms`,
      );
      return pipe;
    });
  }
  return await pipelinePromise;
};

const normalize = (values: Float32Array): Float32Array => {
  let sum = 0;
  for (const value of values) {
    sum += value * value;
  }
  const length = Math.sqrt(sum) || 1;
  return Float32Array.from(values, (value) => value / length);
};

export const embed = async (texts: readonly string[]): Promise<readonly Float32Array[]> => {
  if (texts.length === 0) {
    return [];
  }
  const pipe = await getEmbedder();
  const output = await pipe(texts, { pooling: 'mean', normalize: true });
  const data = Array.from(output.data);
  const rows = output.dims?.[0] ?? texts.length;
  const dim = output.dims?.[1] ?? INDEX_DIM;
  const vectors: Float32Array[] = [];
  for (let row = 0; row < rows; row += 1) {
    vectors.push(normalize(Float32Array.from(data.slice(row * dim, (row + 1) * dim))));
  }
  return vectors;
};

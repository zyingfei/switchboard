export const cosine = (left: Float32Array, right: Float32Array): number => {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  for (let index = 0; index < length; index += 1) {
    dot += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return dot;
};

const normalize = (vector: Float32Array): Float32Array => {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  const length = Math.sqrt(sum);
  if (length === 0) {
    return vector;
  }
  return Float32Array.from(vector, (value) => value / length);
};

export const meanNormalized = (vectors: readonly Float32Array[]): Float32Array | null => {
  if (vectors.length === 0) {
    return null;
  }
  const dim = vectors[0]?.length ?? 0;
  const mean = new Float32Array(dim);
  for (const vector of vectors) {
    for (let index = 0; index < dim; index += 1) {
      mean[index] = (mean[index] ?? 0) + (vector[index] ?? 0) / vectors.length;
    }
  }
  return normalize(mean);
};

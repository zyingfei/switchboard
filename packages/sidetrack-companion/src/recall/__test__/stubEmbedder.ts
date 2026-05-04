export const stubEmbed = (texts: readonly string[]): Promise<readonly Float32Array[]> =>
  Promise.resolve(texts.map((text) => {
    const vector = new Float32Array(384);
    const first = text.length % 2 === 0 ? 1 : 0;
    vector[0] = first;
    vector[1] = first === 1 ? 0 : 1;
    return vector;
  }));

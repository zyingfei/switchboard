export const stubEmbed = (texts: readonly string[]): Promise<readonly Float32Array[]> =>
  Promise.resolve(
    texts.map((text) => {
      const vector = new Float32Array(384);
      // Overrides receive exact model inputs. Ignore the canonical legacy
      // wrapper so this historical test stub preserves its prior fixture
      // vectors while still exercising the production prefix boundary.
      const unwrapped = text.replace(/^query:\s/iu, '');
      const first = unwrapped.length % 2 === 0 ? 1 : 0;
      vector[0] = first;
      vector[1] = first === 1 ? 0 : 1;
      return vector;
    }),
  );

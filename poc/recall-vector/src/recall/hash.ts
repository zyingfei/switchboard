const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export const hashText = (input: string): string => {
  let hash = FNV_OFFSET;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

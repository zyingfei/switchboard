const FNV1A_32_OFFSET = 0x811c9dc5;
const FNV1A_32_PRIME = 0x01000193;
const UINT32_MASK = 0xffffffff;

export const fnv1a32 = (input: string): number => {
  const bytes = new TextEncoder().encode(input);
  let hash = FNV1A_32_OFFSET;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, FNV1A_32_PRIME) >>> 0;
  }
  return hash >>> 0;
};

export const fnv1a32Hex = (input: string): string => fnv1a32(input).toString(16).padStart(8, '0');

export const saltedFnv1a32Hex = (salt: string, input: string): string =>
  fnv1a32Hex(`${salt}|${input}`);

export const hammingDistanceHex32 = (leftHex: string, rightHex: string): number => {
  const left = Number.parseInt(leftHex, 16) >>> 0;
  const right = Number.parseInt(rightHex, 16) >>> 0;
  let value = (left ^ right) >>> 0;
  let count = 0;
  while (value !== 0) {
    value &= value - 1;
    count += 1;
  }
  return count;
};

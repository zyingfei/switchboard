const FNV1A_64_OFFSET = 0xcbf29ce484222325n;
const FNV1A_64_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

const tokenPattern = /[\p{L}\p{N}_-]+/gu;

export const hashToken64 = (token: string): bigint => {
  const bytes = new TextEncoder().encode(token);
  let hash = FNV1A_64_OFFSET;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV1A_64_PRIME) & UINT64_MASK;
  }
  return hash;
};

export const tokenizeForSimhash = (text: string): readonly string[] =>
  [...text.toLocaleLowerCase().matchAll(tokenPattern)].map((match) => match[0]).slice(0, 128);

const bigintToBytes = (value: bigint): Uint8Array => {
  const bytes = new Uint8Array(8);
  for (let i = 7; i >= 0; i -= 1) {
    bytes[i] = Number((value >> BigInt((7 - i) * 8)) & 0xffn);
  }
  return bytes;
};

const bytesToBigint = (bytes: Uint8Array): bigint => {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
};

export const uint64ToBase64 = (value: bigint): string => {
  const bytes = bigintToBytes(value & UINT64_MASK);
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export const base64ToUint64 = (value: string): bigint => {
  if (typeof Buffer !== 'undefined') return bytesToBigint(new Uint8Array(Buffer.from(value, 'base64')));
  const binary = atob(value);
  return bytesToBigint(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
};

export const simhash64Bigint = (text: string): bigint => {
  const tokens = tokenizeForSimhash(text);
  if (tokens.length === 0) return 0n;
  const weights = Array.from({ length: 64 }, () => 0);
  for (const token of tokens) {
    const hash = hashToken64(token);
    for (let bit = 0; bit < 64; bit += 1) {
      const mask = 1n << BigInt(bit);
      weights[bit] += (hash & mask) === 0n ? -1 : 1;
    }
  }
  let out = 0n;
  for (let bit = 0; bit < 64; bit += 1) {
    if ((weights[bit] ?? 0) >= 0) out |= 1n << BigInt(bit);
  }
  return out & UINT64_MASK;
};

export const simhash64Base64 = (text: string): string => uint64ToBase64(simhash64Bigint(text));

export const hammingDistance64 = (leftBase64: string, rightBase64: string): number => {
  let value = base64ToUint64(leftBase64) ^ base64ToUint64(rightBase64);
  let distance = 0;
  while (value !== 0n) {
    value &= value - 1n;
    distance += 1;
  }
  return distance;
};

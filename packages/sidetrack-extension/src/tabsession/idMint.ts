const CROCKFORD32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const char32 = (index: number): string => {
  if (index < 0 || index >= CROCKFORD32.length) {
    throw new Error(`Invalid base32 index ${String(index)}.`);
  }
  return CROCKFORD32[index] ?? '';
};

const encodeUlidTime = (timeMs: number): string => {
  let value = BigInt(timeMs);
  let out = '';
  for (let i = 0; i < 10; i += 1) {
    out = char32(Number(value % 32n)) + out;
    value /= 32n;
  }
  return out;
};

const defaultRandomBytes = (): Uint8Array => {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
};

const encodeUlidRandom = (bytes: Uint8Array): string => {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 16) {
      bits -= 5;
      out += char32((buffer >> bits) & 31);
    }
  }
  while (out.length < 16) out += char32(0);
  return out;
};

export const mintTabSessionId = (
  now: Date = new Date(),
  randomBytes: () => Uint8Array = defaultRandomBytes,
): string => `tses_${encodeUlidTime(now.getTime())}${encodeUlidRandom(randomBytes())}`;

import { randomBytes } from 'node:crypto';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const randomBase32 = (length: number): string => {
  const bytes = randomBytes(length);
  let output = '';

  for (const byte of bytes) {
    output += alphabet.charAt(byte % alphabet.length);
  }

  return output;
};

export const createBacId = (): string => randomBase32(16);

export const createRevision = (): string => randomBase32(20);

export const createRequestId = (): string => `req_${randomBase32(20)}`;

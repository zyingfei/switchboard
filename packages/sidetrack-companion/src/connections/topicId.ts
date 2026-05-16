import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';

const encoder = new TextEncoder();

export const sha256Base64UrlPrefix = async (value: string, length = 16): Promise<string> => {
  const digest = await webcrypto.subtle.digest('SHA-256', encoder.encode(value));
  return Buffer.from(new Uint8Array(digest))
    .toString('base64')
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '')
    .slice(0, length);
};

export const topicId = async (members: readonly string[]): Promise<string> => {
  const canonicalMembers = [...members].sort();
  const digest = await sha256Base64UrlPrefix(canonicalMembers.join('\n'));
  return `topic:${digest}`;
};

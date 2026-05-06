import { describe, expect, it } from 'vitest';

import {
  decodeBytes,
  decodeFrame,
  encodeBytes,
  encodeFrame,
  type PublishFrame,
} from './relayProtocol.js';

describe('relayProtocol', () => {
  it('round-trips every frame kind', () => {
    const cases = [
      { kind: 'HELLO', protocol_version: 1 } as const,
      {
        kind: 'WELCOME',
        server_version: '0.0.0',
        max_event_size: 65536,
        max_buffer_seconds: 86400,
      } as const,
      {
        kind: 'SUBSCRIBE',
        rendezvous_id: 'AAAA',
        replica_id: 'A',
        sender_public_key: 'pk',
      } as const,
      {
        kind: 'PUBLISH',
        rendezvous_id: 'r',
        replica_id: 'A',
        ciphertext: 'cc',
        nonce: 'nn',
        signature: 'ss',
        sender_public_key: 'pk',
        ttl_seconds: 600,
      } as const,
      {
        kind: 'EVENT',
        rendezvous_id: 'r',
        sender_replica_id: 'A',
        ciphertext: 'cc',
        nonce: 'nn',
        signature: 'ss',
        sender_public_key: 'pk',
        received_at: 1_700_000_000_000,
      } as const,
      { kind: 'PING' } as const,
      { kind: 'PONG' } as const,
      { kind: 'ERROR', code: 'BAD', message: 'broken' } as const,
    ];
    for (const frame of cases) {
      const encoded = encodeFrame(frame);
      const decoded = decodeFrame(encoded);
      expect(decoded).toEqual(frame);
    }
  });

  it('decodeFrame returns null for malformed input', () => {
    expect(decodeFrame(Buffer.from('not json'))).toBeNull();
    expect(decodeFrame(Buffer.from('{"kind":"NOPE"}'))).toBeNull();
    expect(decodeFrame(Buffer.from('{"kind":"PUBLISH"}'))).toBeNull();
  });

  it('decodeFrame strips unknown fields by reconstructing the typed shape', () => {
    const raw = JSON.stringify({
      kind: 'PUBLISH',
      rendezvous_id: 'r',
      replica_id: 'A',
      ciphertext: 'cc',
      nonce: 'nn',
      signature: 'ss',
      sender_public_key: 'pk',
      mystery: 'extra-field',
    });
    const decoded = decodeFrame(Buffer.from(raw, 'utf8')) as PublishFrame | null;
    expect(decoded).not.toBeNull();
    expect((decoded as unknown as Record<string, unknown>)['mystery']).toBeUndefined();
  });

  it('encodeBytes / decodeBytes survive arbitrary binary content', () => {
    const data = Buffer.from([0, 1, 2, 0xff, 0x80, 0x7f]);
    expect(decodeBytes(encodeBytes(data)).equals(data)).toBe(true);
  });
});

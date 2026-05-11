// Relay wire protocol.
//
// Frames are JSON over WebSocket binary frames. Binary fields
// (rendezvous_id, ciphertext, nonce, sender_public_key, signature)
// are base64url-encoded — JSON cannot carry raw bytes natively. The
// spec calls for CBOR ultimately; JSON keeps the first cut simple
// and human-debuggable. Switching to CBOR is a wire-format swap
// later, the semantics don't change.
export const PROTOCOL_VERSION = 1;
export const encodeFrame = (frame) => Buffer.from(JSON.stringify(frame), 'utf8');
const isString = (value) => typeof value === 'string';
const isFrameKind = (value) => value === 'HELLO' ||
    value === 'WELCOME' ||
    value === 'SUBSCRIBE' ||
    value === 'PUBLISH' ||
    value === 'EVENT' ||
    value === 'PING' ||
    value === 'PONG' ||
    value === 'ERROR';
export const decodeFrame = (data) => {
    let raw;
    if (typeof data === 'string')
        raw = data;
    else
        raw = data.toString('utf8');
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null)
        return null;
    const obj = parsed;
    if (!isFrameKind(obj['kind']))
        return null;
    switch (obj['kind']) {
        case 'HELLO':
            return typeof obj['protocol_version'] === 'number'
                ? ({ kind: 'HELLO', protocol_version: obj['protocol_version'] })
                : null;
        case 'WELCOME':
            return isString(obj['server_version']) &&
                typeof obj['max_event_size'] === 'number' &&
                typeof obj['max_buffer_seconds'] === 'number'
                ? ({
                    kind: 'WELCOME',
                    server_version: obj['server_version'],
                    max_event_size: obj['max_event_size'],
                    max_buffer_seconds: obj['max_buffer_seconds'],
                })
                : null;
        case 'SUBSCRIBE':
            return isString(obj['rendezvous_id']) &&
                isString(obj['replica_id']) &&
                isString(obj['sender_public_key'])
                ? ({
                    kind: 'SUBSCRIBE',
                    rendezvous_id: obj['rendezvous_id'],
                    replica_id: obj['replica_id'],
                    sender_public_key: obj['sender_public_key'],
                })
                : null;
        case 'PUBLISH':
            return isString(obj['rendezvous_id']) &&
                isString(obj['replica_id']) &&
                isString(obj['ciphertext']) &&
                isString(obj['nonce']) &&
                isString(obj['signature']) &&
                isString(obj['sender_public_key'])
                ? ({
                    kind: 'PUBLISH',
                    rendezvous_id: obj['rendezvous_id'],
                    replica_id: obj['replica_id'],
                    ciphertext: obj['ciphertext'],
                    nonce: obj['nonce'],
                    signature: obj['signature'],
                    sender_public_key: obj['sender_public_key'],
                    ...(typeof obj['ttl_seconds'] === 'number' ? { ttl_seconds: obj['ttl_seconds'] } : {}),
                })
                : null;
        case 'EVENT':
            return isString(obj['rendezvous_id']) &&
                isString(obj['sender_replica_id']) &&
                isString(obj['ciphertext']) &&
                isString(obj['nonce']) &&
                isString(obj['signature']) &&
                isString(obj['sender_public_key']) &&
                typeof obj['received_at'] === 'number'
                ? ({
                    kind: 'EVENT',
                    rendezvous_id: obj['rendezvous_id'],
                    sender_replica_id: obj['sender_replica_id'],
                    ciphertext: obj['ciphertext'],
                    nonce: obj['nonce'],
                    signature: obj['signature'],
                    sender_public_key: obj['sender_public_key'],
                    received_at: obj['received_at'],
                })
                : null;
        case 'PING':
            return { kind: 'PING' };
        case 'PONG':
            return { kind: 'PONG' };
        case 'ERROR':
            return isString(obj['code']) && isString(obj['message'])
                ? ({ kind: 'ERROR', code: obj['code'], message: obj['message'] })
                : null;
    }
};
export const encodeBytes = (buffer) => buffer.toString('base64url');
export const decodeBytes = (encoded) => Buffer.from(encoded, 'base64url');
//# sourceMappingURL=relayProtocol.js.map
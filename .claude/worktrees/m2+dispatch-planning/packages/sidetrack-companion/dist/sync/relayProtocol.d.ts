export declare const PROTOCOL_VERSION: 1;
export type FrameKind = 'HELLO' | 'WELCOME' | 'SUBSCRIBE' | 'PUBLISH' | 'EVENT' | 'PING' | 'PONG' | 'ERROR';
export interface HelloFrame {
    readonly kind: 'HELLO';
    readonly protocol_version: number;
}
export interface WelcomeFrame {
    readonly kind: 'WELCOME';
    readonly server_version: string;
    readonly max_event_size: number;
    readonly max_buffer_seconds: number;
}
export interface SubscribeFrame {
    readonly kind: 'SUBSCRIBE';
    readonly rendezvous_id: string;
    readonly replica_id: string;
    readonly sender_public_key: string;
}
export interface PublishFrame {
    readonly kind: 'PUBLISH';
    readonly rendezvous_id: string;
    readonly replica_id: string;
    readonly ciphertext: string;
    readonly nonce: string;
    readonly signature: string;
    readonly sender_public_key: string;
    readonly ttl_seconds?: number;
}
export interface EventFrame {
    readonly kind: 'EVENT';
    readonly rendezvous_id: string;
    readonly sender_replica_id: string;
    readonly ciphertext: string;
    readonly nonce: string;
    readonly signature: string;
    readonly sender_public_key: string;
    readonly received_at: number;
}
export interface PingFrame {
    readonly kind: 'PING';
}
export interface PongFrame {
    readonly kind: 'PONG';
}
export interface ErrorFrame {
    readonly kind: 'ERROR';
    readonly code: string;
    readonly message: string;
}
export type RelayFrame = HelloFrame | WelcomeFrame | SubscribeFrame | PublishFrame | EventFrame | PingFrame | PongFrame | ErrorFrame;
export declare const encodeFrame: (frame: RelayFrame) => Buffer;
export declare const decodeFrame: (data: Buffer | string) => RelayFrame | null;
export declare const encodeBytes: (buffer: Buffer) => string;
export declare const decodeBytes: (encoded: string) => Buffer;
//# sourceMappingURL=relayProtocol.d.ts.map
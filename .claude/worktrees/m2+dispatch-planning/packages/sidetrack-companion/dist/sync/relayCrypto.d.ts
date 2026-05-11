export interface RendezvousMaterial {
    readonly rendezvousId: Buffer;
    readonly rendezvousKey: Buffer;
}
export declare const deriveRendezvous: (rendezvousSecret: Buffer) => RendezvousMaterial;
export declare const generateRendezvousSecret: () => Buffer;
export interface ReplicaKeyPair {
    readonly publicKey: Buffer;
    readonly privateKey: Buffer;
}
export declare const generateReplicaKeyPair: () => ReplicaKeyPair;
export declare const extractRawEd25519Public: (spkiDer: Buffer) => Buffer;
export declare const extractRawEd25519Private: (pkcs8Der: Buffer) => Buffer;
export declare const signCanonicalEvent: (privateKey: Buffer, canonicalBytes: Buffer) => Buffer;
export declare const verifyCanonicalEvent: (publicKey: Buffer, canonicalBytes: Buffer, signature: Buffer) => boolean;
export declare const signFrame: (privateKey: Buffer, replicaId: string, lamport: number, payloadBytes: Buffer) => Buffer;
export declare const verifyFrame: (publicKey: Buffer, replicaId: string, lamport: number, payloadBytes: Buffer, signature: Buffer) => boolean;
export interface SealedFrame {
    readonly nonce: Buffer;
    readonly ciphertext: Buffer;
}
export declare const sealFrame: (rendezvousKey: Buffer, rendezvousId: Buffer, senderReplicaId: string, plaintext: Buffer) => SealedFrame;
export declare const openFrame: (rendezvousKey: Buffer, rendezvousId: Buffer, senderReplicaId: string, sealed: SealedFrame) => Buffer;
export declare class ReplayCache {
    private readonly seen;
    private readonly order;
    observe(senderReplicaId: string, nonce: Buffer): boolean;
}
//# sourceMappingURL=relayCrypto.d.ts.map
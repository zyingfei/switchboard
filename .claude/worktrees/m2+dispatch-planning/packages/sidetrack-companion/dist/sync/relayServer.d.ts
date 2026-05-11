export interface RelayServerOptions {
    readonly port?: number;
    readonly host?: string;
    readonly maxBufferEvents?: number;
    readonly maxBufferBytes?: number;
    readonly maxBufferAgeMs?: number;
    readonly maxEventBytes?: number;
    readonly ratePerHour?: number;
    readonly serverVersion?: string;
    readonly now?: () => number;
}
export interface StartedRelayServer {
    readonly port: number;
    readonly host: string;
    readonly close: () => Promise<void>;
}
export declare const startRelayServer: (options?: RelayServerOptions) => Promise<StartedRelayServer>;
//# sourceMappingURL=relayServer.d.ts.map
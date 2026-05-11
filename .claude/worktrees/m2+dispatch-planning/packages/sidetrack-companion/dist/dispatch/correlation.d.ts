import type { DispatchEventRecord } from '../http/schemas.js';
export type CapturedProviderId = 'chatgpt' | 'claude' | 'gemini' | 'codex' | 'unknown';
export declare const normaliseForMatch: (text: string) => string;
export interface DispatchLinkInput {
    readonly threadId: string;
    readonly threadProvider: CapturedProviderId;
    readonly userTurnTexts: readonly string[];
    readonly capturedAtMs: number;
    readonly recentDispatches: readonly DispatchEventRecord[];
    readonly existingLinks: Readonly<Partial<Record<string, string>>>;
    readonly liveThreadIds?: ReadonlySet<string>;
    readonly originalBodiesById?: Readonly<Partial<Record<string, string>>>;
}
export interface DispatchLinkResult {
    readonly matched: true;
    readonly dispatchId: string;
    readonly matchedTurnIndex: number;
    readonly candidatesConsidered: number;
    readonly bestPrefixMatchLen: number;
}
export type DispatchLinkMissReason = 'window-expired' | 'provider-mismatch' | 'no-prefix-match' | 'tiny-prefix' | 'already-linked';
export interface DispatchLinkMiss {
    readonly matched: false;
    readonly reason: DispatchLinkMissReason;
    readonly candidatesConsidered: number;
    readonly bestPrefixMatchLen: number;
}
export type DispatchLinkDiagnosticResult = DispatchLinkResult | DispatchLinkMiss;
export declare const tryLinkCapturedThread: (input: DispatchLinkInput) => DispatchLinkDiagnosticResult;
//# sourceMappingURL=correlation.d.ts.map
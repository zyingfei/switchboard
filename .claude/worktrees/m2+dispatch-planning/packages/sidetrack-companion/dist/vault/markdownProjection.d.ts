export interface WorkstreamProjectionInput {
    readonly bac_id: string;
    readonly revision: string;
    readonly title?: string;
    readonly parentId?: string;
    readonly children?: readonly string[];
    readonly tags?: readonly string[];
    readonly privacy?: 'private' | 'shared' | 'public';
    readonly screenShareSensitive?: boolean;
    readonly checklist?: readonly {
        readonly text: string;
        readonly checked: boolean;
    }[];
    readonly createdAt?: string;
    readonly updatedAt?: string;
}
export declare const renderWorkstreamMarkdown: (input: WorkstreamProjectionInput) => string;
export interface ThreadProjectionInput {
    readonly bac_id: string;
    readonly revision: string;
    readonly provider?: string;
    readonly threadUrl?: string;
    readonly title?: string;
    readonly status?: string;
    readonly trackingMode?: string;
    readonly primaryWorkstreamId?: string;
    readonly tags?: readonly string[];
    readonly lastSeenAt?: string;
    readonly lastTurnRole?: string;
    readonly lastResearchMode?: string;
    readonly parentThreadId?: string;
    readonly updatedAt?: string;
}
export interface ThreadTurnProjectionInput {
    readonly role: 'user' | 'assistant' | 'system' | 'unknown';
    readonly text: string;
    readonly ordinal: number;
    readonly capturedAt: string;
}
export declare const renderThreadMarkdown: (input: ThreadProjectionInput) => string;
export declare const parseMarkdownLockSentinel: (content: string) => boolean;
export declare const renderPromotedThreadMarkdown: (thread: ThreadProjectionInput, turns: readonly ThreadTurnProjectionInput[], workstreamTitle: string, generatedAt?: string) => string;
//# sourceMappingURL=markdownProjection.d.ts.map
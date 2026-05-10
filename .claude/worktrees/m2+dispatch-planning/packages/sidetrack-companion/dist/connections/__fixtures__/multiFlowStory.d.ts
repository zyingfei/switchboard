import type { ConnectionsInput } from '../snapshot.js';
export declare const buildMultiFlowFixture: () => ConnectionsInput;
export declare const FLOW_NODES: {
    readonly A: {
        readonly workstream: string;
        readonly parentWorkstream: string;
        readonly threads: readonly [string, string];
        readonly dispatches: readonly [string];
        readonly codingSessions: readonly [string];
        readonly queueItems: readonly [string];
        readonly reminders: readonly [string];
        readonly annotations: readonly [string, string];
        readonly visits: readonly [string, string, string, string, string, string, string];
    };
    readonly B: {
        readonly workstream: string;
        readonly threads: readonly [string, string];
        readonly dispatches: readonly [string];
        readonly codingSessions: readonly [];
        readonly queueItems: readonly [string];
        readonly annotations: readonly [string];
        readonly visits: readonly [string, string, string, string];
    };
    readonly C: {
        readonly workstream: string;
        readonly threads: readonly [string, string];
        readonly dispatches: readonly [string];
        readonly codingSessions: readonly [string];
        readonly queueItems: readonly [];
        readonly annotations: readonly [string];
        readonly visits: readonly [string, string, string, string];
    };
};
export declare const CROSS_FLOW_NODES: {
    readonly hnPgMergeVisit: string;
};
export declare const flowExclusiveNodes: (flow: "A" | "B" | "C") => readonly string[];
export declare const NODE_IDS: {
    readonly WS_RESEARCH: string;
    readonly WS_SECURITY: string;
    readonly WS_POSTGRES: string;
    readonly WS_SIDETRACK: string;
    readonly T_CVE_CLAUDE: string;
    readonly T_CVE_CHATGPT: string;
    readonly T_PG_CLAUDE: string;
    readonly T_PG_CHATGPT: string;
    readonly T_SB_CLAUDE: string;
    readonly T_SB_CHATGPT: string;
    readonly HN_PGMERGE_VISIT: string;
    readonly HN_COPYFAIL_VISIT: string;
};
//# sourceMappingURL=multiFlowStory.d.ts.map
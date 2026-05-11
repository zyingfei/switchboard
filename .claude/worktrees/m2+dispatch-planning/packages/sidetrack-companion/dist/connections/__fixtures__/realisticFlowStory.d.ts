import type { ConnectionsInput } from '../snapshot.js';
export declare const URL_A_HN = "https://news.ycombinator.com/item?id=47952181";
export declare const URL_A_BLOG = "https://xint.io/blog/copy-fail-linux-distributions";
export declare const URL_A_GOOGLE_SEARCH = "https://www.google.com/search?q=Linux+crypto+subsystem&newwindow=1&sca_esv=9700858d11d87a5f&sxsrf=ANbL-n7otDb8AtUZOxbzZ4JQi1ezOpsbrw";
export declare const URL_A_CHATGPT = "https://chatgpt.com/c/69fb9815-41f8-8329-a790-edfa4b914dfd";
export declare const URL_A_COPY_FAIL = "https://copy.fail/";
export declare const URL_A_GITHUB_POC = "https://github.com/theori-io/copy-fail-CVE-2026-31431/blob/main/copy_fail_exp.py";
export declare const URL_A_CODING_THREAD = "https://claude.ai/chat/coding_agent_cve_repro";
export declare const URL_B_GH_REPO = "https://github.com/zyingfei/switchboard";
export declare const URL_B_GH_PRS = "https://github.com/zyingfei/switchboard/pulls";
export declare const URL_B_CHATGPT_1 = "https://chatgpt.com/g/g-p-69ec077b42948191a1fd309d64a860ae-switchboard/c/69fd259a-83b0-8326-a4d9-c4c1b76a5986";
export declare const URL_B_CHATGPT_2 = "https://chatgpt.com/g/g-p-69ec077b42948191a1fd309d64a860ae/c/69fcb926-3a98-8328-bbe4-baee4da7fbef";
export declare const URL_B_YOUTUBE = "https://www.youtube.com/watch?v=rY44ViY45q8";
export declare const URL_B_GEMINI = "https://gemini.google.com/app/7a97310e824ccad4?hl=en-US";
export declare const WS_A_CVE = "ws_realistic_cve";
export declare const WS_B_SWITCHBOARD = "ws_realistic_switchboard";
export declare const T_A_CHATGPT = "t_realistic_a_chatgpt";
export declare const T_A_CODING = "t_realistic_a_coding";
export declare const T_B_CHATGPT_1 = "t_realistic_b_chatgpt_1";
export declare const T_B_CHATGPT_2 = "t_realistic_b_chatgpt_2";
export declare const T_B_GEMINI = "t_realistic_b_gemini";
export declare const D_A_DISPATCH_TO_CODING = "d_realistic_a_codex";
export declare const CS_A_CODING = "cs_realistic_a_vm";
export declare const A_A_GITHUB = "a_realistic_a_github";
export declare const buildRealisticFlowFixture: () => ConnectionsInput;
export declare const REALISTIC_FLOW_A_NODES: {
    readonly workstream: string;
    readonly threads: readonly [string, string];
    readonly dispatches: readonly [string];
    readonly codingSessions: readonly [string];
    readonly annotations: readonly [string];
    readonly visits: {
        readonly hn: string;
        readonly blog: string;
        readonly googleSearch: string;
        readonly chatgpt: string;
        readonly copyFail: string;
        readonly githubPoC: string;
        readonly codingThread: string;
    };
};
export declare const REALISTIC_FLOW_B_NODES: {
    readonly workstream: string;
    readonly threads: readonly [string, string, string];
    readonly visits: {
        readonly repo: string;
        readonly prs: string;
        readonly chatgpt1: string;
        readonly chatgpt2: string;
        readonly youtube: string;
        readonly gemini: string;
    };
};
//# sourceMappingURL=realisticFlowStory.d.ts.map
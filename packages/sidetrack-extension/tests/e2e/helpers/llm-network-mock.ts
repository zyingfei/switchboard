import type { BrowserContext, Route } from '@playwright/test';

// Stage 1 MVP guarantees: zero local LLM inference; no outbound LLM-shaped
// requests. The browser e2e installs this network-mock at the context level
// to fail any outbound request whose URL hostname looks like a known LLM
// endpoint. If a Stage 1 surface ever adds such a call, the e2e fails
// loudly — that's the regression guard.
//
// What "LLM-shaped" means here: hostnames that match known model hosts, OR
// path components like `/v1/completions`, `/v1/chat/completions`,
// `/v1/messages` (Anthropic), `/api/generate` (Ollama). The list is
// deliberately broad to catch new providers without a code change. Add to
// the BLOCKLIST when a new provider would be a meaningful regression
// signal.
//
// Whitelist exceptions:
//   - chrome-extension://*  — extension origin must pass through unconditionally.
//   - http://127.0.0.1:*    — local companion HTTP API.
//   - http://localhost:*    — same.
//   - ws://127.0.0.1:*      — local relay.
//
// Tests can call `assertNoLlmCalls(context)` after their work to verify the
// recorded count of blocked attempts is zero.

const LLM_BLOCKLIST: readonly RegExp[] = [
  /(?:^|\.)(?:openai|anthropic|cohere|huggingface|together|replicate|groq|fireworks|mistral|perplexity)\.com\/?/iu,
  /(?:^|\.)(?:claude|gemini|bard|copilot)\.(?:ai|com|google\.com)\/?/iu,
  /(?:^|\.)ollama\.(?:ai|com|local)\/?/iu,
  /\/v1\/(?:completions|chat\/completions|messages|embeddings)(?:\/|$)/iu,
  /\/api\/(?:generate|chat|tags)(?:\/|$)/iu,
  /(?:^|\.)googleapis\.com\/(?:v1beta\/)?models\//iu,
];

const LOCAL_PASSTHROUGH: readonly RegExp[] = [
  /^chrome-extension:\/\//iu,
  /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/iu,
  /^wss?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/iu,
];

interface InstalledMock {
  readonly attempts: ReadonlyArray<{ readonly url: string; readonly at: number }>;
}

export interface LlmNetworkMock {
  readonly attempts: () => readonly { readonly url: string; readonly at: number }[];
  readonly assertNoLlmCalls: () => void;
}

const installState = new WeakMap<BrowserContext, InstalledMock>();

export const installLlmNetworkMock = async (context: BrowserContext): Promise<LlmNetworkMock> => {
  const recorded: { readonly url: string; readonly at: number }[] = [];

  await context.route(/.*/u, (route: Route) => {
    const url = route.request().url();
    if (LOCAL_PASSTHROUGH.some((rx) => rx.test(url))) {
      void route.fallback();
      return;
    }
    if (LLM_BLOCKLIST.some((rx) => rx.test(url))) {
      recorded.push({ url, at: Date.now() });
      void route.abort('blockedbyclient');
      return;
    }
    void route.fallback();
  });

  const state: InstalledMock = { attempts: recorded };
  installState.set(context, state);

  return {
    attempts: () => state.attempts,
    assertNoLlmCalls: () => {
      if (state.attempts.length === 0) return;
      const list = state.attempts.map((a) => a.url).join('\n  ');
      throw new Error(
        `LLM-network-mock blocked ${String(state.attempts.length)} outbound LLM-shaped request(s). Stage 1 MVP guarantees zero such calls.\nBlocked URLs:\n  ${list}`,
      );
    },
  };
};

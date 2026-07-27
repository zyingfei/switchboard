// The OPTIONAL remote engine — a direct browser → provider call, no companion.
//
// SCOPE, PRECISELY. This is an OpenAI-compatible `POST {baseUrl}/chat/completions`
// with a single user message, using the SAME tuned decoding options every other
// engine gets (generationOptions.ts) and the SAME output cleanup. No SDK, no new
// dependency — `fetch` is already there. The companion is deliberately NOT in the
// path: routing page text through the local server would make the local server
// an exfiltration relay, which is a much worse shape than an explicit,
// user-configured, clearly-marked direct call.
//
// PRIVACY. The key is read from remoteConfig.ts at request-build time and put in
// exactly one place: the Authorization header. It is never returned, never
// interpolated into an error message, never logged. Every failure below carries
// a TYPED kind and a message built from the status code — not from the response
// body, which a hostile or misconfigured endpoint could use to echo the key back
// into our UI.
//
// SELECTION. `remoteEngineFrom` returns null unless `remoteConfigReady()` — the
// engine literally does not exist for a disabled or keyless config, so "never
// selected when off" is a property of the constructor, not of every call site.

import {
  cleanGeneratedText,
  outputCharCapOf,
  type GenerationEngine,
} from './generationEngine';
import { remoteLimits } from './engineLimits';
import { resolveGenerationOptions, type GenerationOptions } from './generationOptions';
import { remoteIdentity } from './modelRegistry';
import { remoteConfigReady, type RemoteEngineConfig } from './remoteConfig';

/** Every way a remote generation can fail, each with its own honest sentence. */
export type RemoteFailureKind =
  | 'auth-failed'
  | 'rate-limited'
  | 'network'
  | 'bad-response'
  | 'aborted';

export class RemoteEngineError extends Error {
  readonly kind: RemoteFailureKind;
  constructor(kind: RemoteFailureKind, message: string) {
    super(message);
    this.name = 'RemoteEngineError';
    this.kind = kind;
  }
}

/** Narrow an unknown throw back to its typed kind; null when it is not ours. */
export const remoteFailureKindOf = (err: unknown): RemoteFailureKind | null =>
  err instanceof RemoteEngineError ? err.kind : null;

/** Short human copy per typed failure — what the row tells the user, verbatim. */
export const remoteFailureCopy = (kind: RemoteFailureKind): string => {
  switch (kind) {
    case 'auth-failed':
      return 'the provider rejected the API key';
    case 'rate-limited':
      return 'the provider is rate-limiting this key';
    case 'network':
      return 'the provider could not be reached';
    case 'bad-response':
      return 'the provider returned something unusable';
    case 'aborted':
      return 'the request was cancelled';
  }
};

/** '{baseUrl}/chat/completions', tolerant of a trailing slash on the base URL. */
export const remoteChatCompletionsUrl = (baseUrl: string): string =>
  `${baseUrl.trim().replace(/\/+$/u, '')}/chat/completions`;

/**
 * The request body, pure so the exact wire shape is assertable in a unit test
 * rather than trusted. `messages` is a single user turn — the same chat-message
 * shape the WebGPU engine uses, for the same reason (an instruction-tuned model
 * handed a bare string continues it instead of answering).
 */
export const remoteRequestBody = (
  config: RemoteEngineConfig,
  prompt: string,
  opts: GenerationOptions,
): Record<string, unknown> => {
  const resolved = resolveGenerationOptions(opts);
  return {
    model: config.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: resolved.temperature,
    max_tokens: resolved.maxNewTokens,
  };
};

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const isAbortError = (err: unknown): boolean =>
  (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') ||
  (err instanceof Error && err.name === 'AbortError');

/** Pull the assistant text out of an OpenAI-compatible reply. Null when absent. */
export const remoteReplyText = (body: unknown): string | null => {
  if (typeof body !== 'object' || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : null;
};

/**
 * Build the remote engine, or null when the user has NOT explicitly enabled it
 * with a key. Never probes, never validates the key up front (that would be an
 * outbound call the user did not ask for).
 *
 * `fetchImpl` is a test seam; production passes nothing and gets global fetch.
 */
export const remoteEngineFrom = (
  config: RemoteEngineConfig,
  fetchImpl?: FetchLike,
): GenerationEngine | null => {
  if (!remoteConfigReady(config)) return null;
  const url = remoteChatCompletionsUrl(config.baseUrl);
  return {
    kind: 'remote',
    identity: remoteIdentity(config.model),
    limits: remoteLimits,
    generate: async (prompt, opts, signal) => {
      const doFetch: FetchLike =
        fetchImpl ??
        ((input, init) =>
          (globalThis as { fetch: (i: string, o: RequestInit) => Promise<Response> }).fetch(
            input,
            init,
          ));
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // The ONE place the key appears. Not logged, not returned.
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(remoteRequestBody(config, prompt, opts)),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (err) {
        if (isAbortError(err)) throw new RemoteEngineError('aborted', 'request cancelled');
        // Deliberately NOT String(err) — a fetch rejection can carry the request
        // URL and, on some polyfills, the init object. Fixed copy instead.
        throw new RemoteEngineError('network', 'network request failed');
      }
      if (res.status === 401 || res.status === 403) {
        throw new RemoteEngineError('auth-failed', `provider rejected the key (${String(res.status)})`);
      }
      if (res.status === 429) {
        throw new RemoteEngineError('rate-limited', 'provider rate limit (429)');
      }
      if (!res.ok) {
        throw new RemoteEngineError('bad-response', `provider returned ${String(res.status)}`);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new RemoteEngineError('bad-response', 'provider response was not JSON');
      }
      const text = remoteReplyText(body);
      if (text === null) {
        throw new RemoteEngineError('bad-response', 'provider response had no message content');
      }
      return cleanGeneratedText(text, outputCharCapOf(opts));
    },
  };
};

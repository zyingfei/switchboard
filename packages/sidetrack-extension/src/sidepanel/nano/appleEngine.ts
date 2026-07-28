// The Apple Foundation Models engine — on-device, via the local service.
//
// Transport is the same OpenAI-compatible POST the remote engine uses, but the
// two are deliberately NOT shared code, because they differ in exactly the
// places that matter: no Authorization header exists here (there is no key and
// no account), the endpoint is a fixed loopback address, and the failure modes
// are local-service failures rather than provider failures. See appleService.ts
// for why this is not filed under `remote`.
//
// PARAMETERS ARE PROBED, NOT ASSUMED. apfel rejects OpenAI parameters it does
// not implement with a 400 rather than ignoring them, so sending our full
// decoding config would fail every request. Measured 2026-07-28 against apfel
// 1.8.4:
//
//     temperature   200        frequency_penalty   400
//     max_tokens    200        (repetition_penalty / no_repeat_ngram_size are
//     top_p         200         not OpenAI parameters at all)
//
// So the body carries temperature / max_tokens / top_p and nothing else. The
// repetition controls the WebGPU lane relies on have no equivalent here — the
// backstop is validateGeneration(), exactly as it is for Nano, which also has
// no decoding controls.

import {
  cleanGeneratedText,
  outputCharCapOf,
  type GenerationEngine,
} from './generationEngine';
import { appleLimits } from './engineLimits';
import { resolveGenerationOptions, type GenerationOptions } from './generationOptions';
import { appleIdentity } from './modelRegistry';
import { APPLE_SERVICE_BASE_URL, type AppleServiceInfo } from './appleService';

/** Every way an Apple generation can fail, each with its own honest sentence. */
export type AppleFailureKind =
  | 'service-gone'
  | 'unsupported-language'
  | 'bad-response'
  | 'aborted';

export class AppleEngineError extends Error {
  readonly kind: AppleFailureKind;
  constructor(kind: AppleFailureKind, message: string) {
    super(message);
    this.name = 'AppleEngineError';
    this.kind = kind;
  }
}

export const appleFailureKindOf = (err: unknown): AppleFailureKind | null =>
  err instanceof AppleEngineError ? err.kind : null;

export const appleFailureCopy = (kind: AppleFailureKind): string => {
  switch (kind) {
    case 'service-gone':
      return 'the local Apple AI service stopped responding';
    case 'unsupported-language':
      return 'Apple’s on-device model refused this language';
    case 'bad-response':
      return 'the local Apple AI service returned something unusable';
    case 'aborted':
      return 'the request was cancelled';
  }
};

export const appleChatCompletionsUrl = (baseUrl: string): string =>
  `${baseUrl.trim().replace(/\/+$/u, '')}/chat/completions`;

/**
 * The request body. Pure, so the exact wire shape is assertable in a unit test
 * rather than trusted — and it must stay a SUBSET of what apfel accepts, since
 * an unknown field is a 400 and not a no-op.
 */
export const appleRequestBody = (
  modelId: string,
  prompt: string,
  opts: GenerationOptions,
): Record<string, unknown> => {
  const resolved = resolveGenerationOptions(opts);
  return {
    model: modelId,
    // Single user turn — the same chat-message shape every other engine uses,
    // for the same reason: an instruction-tuned model handed a bare string
    // continues it instead of answering it.
    messages: [{ role: 'user', content: prompt }],
    temperature: resolved.temperature,
    max_tokens: resolved.maxNewTokens,
    top_p: resolved.topP,
  };
};

/**
 * Does this 400 mean "Apple will not speak that language"?
 *
 * Measured: a Chinese prompt comes back
 *   {"error":{"message":"Unsupported language: An unsupported language or
 *     locale was used","type":"invalid_request_error"}}
 * even though the service ADVERTISES zh in its model notes. The advertised list
 * and the runtime disagree, so the runtime is what we believe — and a caller
 * that gets this kind can fall back to the WebGPU lane instead of failing the
 * enrichment outright.
 */
export const isUnsupportedLanguageError = (body: unknown): boolean => {
  if (typeof body !== 'object' || body === null) return false;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return false;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /unsupported language/iu.test(message);
};

/** Pull the assistant text out of an OpenAI-compatible reply. Null when absent. */
export const appleReplyText = (body: unknown): string | null => {
  if (typeof body !== 'object' || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : null;
};

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const isAbortError = (err: unknown): boolean =>
  (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') ||
  (err instanceof Error && err.name === 'AbortError');

/**
 * Build the Apple engine, or null when the local service is not available.
 * Mirrors remoteEngineFrom's discipline: "never selected when absent" is a
 * property of the CONSTRUCTOR, not of every call site.
 */
export const appleEngineFrom = (
  info: AppleServiceInfo,
  fetchImpl?: FetchLike,
  baseUrl: string = APPLE_SERVICE_BASE_URL,
): GenerationEngine | null => {
  if (!info.available) return null;
  const url = appleChatCompletionsUrl(baseUrl);
  const limits = appleLimits(info);
  return {
    kind: 'apple',
    identity: appleIdentity(info.modelId),
    limits,
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
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(appleRequestBody(info.modelId, prompt, opts)),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (err) {
        if (isAbortError(err)) throw new AppleEngineError('aborted', 'request cancelled');
        throw new AppleEngineError('service-gone', 'local Apple AI service unreachable');
      }
      if (!res.ok) {
        // A 400 is worth reading, because ONE of its shapes is recoverable by
        // routing elsewhere rather than by giving up.
        if (res.status === 400) {
          const body: unknown = await res.json().catch(() => null);
          if (isUnsupportedLanguageError(body)) {
            throw new AppleEngineError(
              'unsupported-language',
              'Apple’s on-device model refused this language',
            );
          }
        }
        throw new AppleEngineError(
          'bad-response',
          `local Apple AI service returned ${String(res.status)}`,
        );
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new AppleEngineError('bad-response', 'service response was not JSON');
      }
      const text = appleReplyText(body);
      if (text === null) {
        throw new AppleEngineError('bad-response', 'service response had no message content');
      }
      return cleanGeneratedText(text, outputCharCapOf(opts));
    },
  };
};

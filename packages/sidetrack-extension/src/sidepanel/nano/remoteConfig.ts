// The OPTIONAL remote engine's configuration — and the privacy contract around it.
//
// THE HARD CONSTRAINT. This product's premise is zero-outbound: page text never
// leaves the device. A remote engine breaks that premise by construction, so it
// is not a feature that "defaults to sensible" — it is a switch the user has to
// find, read, and deliberately turn on, with a key they supply themselves.
// Everything in this module exists to make that boundary impossible to cross by
// accident:
//
//   1. DEFAULT OFF. `enabled` starts false and there is no code path that flips
//      it. Routing asks `remoteConfigReady()`, which requires BOTH the explicit
//      enable AND a non-empty key — so an enabled-but-keyless config is still
//      never selected, and neither is a key that was pasted without enabling.
//   2. LOCAL STORAGE ONLY. The key is written through deviceStore.ts, which
//      names chrome.storage.LOCAL and nothing else. chrome.storage.sync would
//      replicate the credential through the signed-in Chrome profile — i.e. the
//      key would leave the device merely by being stored.
//   3. NEVER READ BACK INTO THE UI. The config the panel renders carries a
//      MASK ("sk-…abcd"), never the key. The key is loaded only at the moment a
//      request is built.
//   4. NEVER LOGGED, NEVER IN DIAGNOSTICS. `redactRemoteConfig()` is the only
//      shape any diagnostics/telemetry payload may embed, and it has no field
//      that can hold the secret.
//   5. ALWAYS MARKED. When the remote engine is the active engine, the UI shows
//      `remotePrivacyMarker(host)` — naming the host, in the user's face, on
//      every surface that can start a run.
//
// Pure helpers + a two-function accessor. No fetch here; see remoteEngine.ts.

import { readDeviceValue, writeDeviceValue } from './deviceStore';

export const REMOTE_ENGINE_STORAGE_KEY = 'sidetrack.remoteEngine.v1';

export const DEFAULT_REMOTE_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_REMOTE_MODEL = 'gpt-4o-mini';

export interface RemoteEngineConfig {
  /** Explicit user opt-in. Default false; nothing but the checkbox sets it. */
  readonly enabled: boolean;
  /** OpenAI-compatible base URL — '/chat/completions' is appended to it. */
  readonly baseUrl: string;
  readonly model: string;
  /** The user's key. NEVER rendered, NEVER logged, NEVER in a diagnostics dump. */
  readonly apiKey: string;
}

export const EMPTY_REMOTE_CONFIG: RemoteEngineConfig = {
  enabled: false,
  baseUrl: DEFAULT_REMOTE_BASE_URL,
  model: DEFAULT_REMOTE_MODEL,
  apiKey: '',
};

const asString = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback;

/** Read the stored config, defaulting every field. Never throws. */
export const readRemoteConfig = async (): Promise<RemoteEngineConfig> => {
  const raw = await readDeviceValue<Record<string, unknown>>(REMOTE_ENGINE_STORAGE_KEY);
  if (raw === null || typeof raw !== 'object') return EMPTY_REMOTE_CONFIG;
  return {
    enabled: raw['enabled'] === true,
    baseUrl: asString(raw['baseUrl'], DEFAULT_REMOTE_BASE_URL),
    model: asString(raw['model'], DEFAULT_REMOTE_MODEL),
    apiKey: asString(raw['apiKey'], ''),
  };
};

/** Merge a patch into the stored config and return the result. */
export const saveRemoteConfig = async (
  patch: Partial<RemoteEngineConfig>,
): Promise<RemoteEngineConfig> => {
  const next: RemoteEngineConfig = { ...(await readRemoteConfig()), ...patch };
  await writeDeviceValue(REMOTE_ENGINE_STORAGE_KEY, next);
  return next;
};

/**
 * The "Clear key" action. Drops the secret AND disables the engine — leaving it
 * enabled with an empty key would be a config that can only fail, and a user who
 * clears their key is asking to stop sending text out, not to keep trying.
 */
export const clearRemoteApiKey = async (): Promise<RemoteEngineConfig> =>
  await saveRemoteConfig({ apiKey: '', enabled: false });

/**
 * The one predicate routing consults. BOTH conditions, always: an explicit
 * enable and a real key. Anything else and the remote engine does not exist.
 */
export const remoteConfigReady = (config: RemoteEngineConfig): boolean =>
  config.enabled && config.apiKey.trim().length > 0 && config.baseUrl.trim().length > 0;

/**
 * "sk-…abcd" — the ONLY form of the key any surface renders. Short keys collapse
 * to a bare tail so a 6-character string is not effectively displayed in full.
 */
export const maskApiKey = (key: string): string => {
  const trimmed = key.trim();
  if (trimmed.length === 0) return '';
  if (trimmed.length <= 8) return `…${trimmed.slice(-2)}`;
  return `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`;
};

/** 'https://api.openai.com/v1' → 'api.openai.com'. Never throws on junk input. */
export const remoteHostOf = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/^[a-z]+:\/\//iu, '').split('/')[0] ?? baseUrl;
  }
};

/** The exact, unmissable marker. Rendered wherever remote is the active engine. */
export const remotePrivacyMarker = (host: string): string => `⚠ sends page text to ${host}`;

/** Longer form for a tooltip / the config block's standing warning. */
export const remotePrivacyDetail = (host: string): string =>
  `The remote engine sends the full page or thread text to ${host}. Everything else in Sidetrack stays on this device.`;

/**
 * The ONLY projection of the remote config that may appear in a diagnostics
 * bundle, a log line, or any telemetry payload. There is deliberately no
 * `apiKey` field and no way to opt one in: a redaction you can forget to apply
 * is not a redaction. Callers embed THIS, never the config.
 */
export interface RedactedRemoteConfig {
  readonly enabled: boolean;
  readonly host: string;
  readonly model: string;
  readonly hasKey: boolean;
}

export const redactRemoteConfig = (config: RemoteEngineConfig): RedactedRemoteConfig => ({
  enabled: config.enabled,
  host: remoteHostOf(config.baseUrl),
  model: config.model,
  hasKey: config.apiKey.trim().length > 0,
});

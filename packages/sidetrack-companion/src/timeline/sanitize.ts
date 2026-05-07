// Sync Contract v1 / Class B — defense-in-depth URL sanitization on
// the companion side.
//
// The plugin's observer already sanitizes URLs before sending. This
// module is the SECOND line of defense: any caller of
// POST /v1/timeline/events whose payload didn't come from the
// observer (older plugin builds, archive-import path, malicious or
// buggy callers with a stolen bridge key) gets sanitized at the
// boundary BEFORE the event is durably appended to the log.
//
// Privacy is not enforced at one layer when the architecture ships an
// open pipe through the companion; the event log is immutable, so
// sanitizing on import is the right time. Mirrored from
// `packages/sidetrack-extension/src/timeline/sanitize.ts` — kept as
// a parallel copy (small) instead of cross-package import (which
// would couple build configs).

const SENSITIVE_PARAM_NAMES: ReadonlySet<string> = new Set<string>([
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'code',
  'state',
  'session',
  'session_id',
  'sessionid',
  'sid',
  'key',
  'api_key',
  'apikey',
  'secret',
  'client_secret',
  'password',
  'pwd',
  'passwd',
  'auth',
  'authorization',
  'sig',
  'signature',
  'hash',
  'nonce',
  'csrf',
  'oauth_token',
  'oauth_verifier',
  'magic',
  'reset_token',
  'verify_token',
  'invite_token',
  'saml',
  'samlresponse',
  'samlrequest',
  'oauth2_token',
]);

const SENSITIVE_SUFFIXES: readonly string[] = [
  '_token',
  '_key',
  '_secret',
  '_password',
  '_auth',
  '_session',
  '_code',
];

const isSensitiveParam = (name: string): boolean => {
  const lower = name.toLowerCase();
  if (SENSITIVE_PARAM_NAMES.has(lower)) return true;
  for (const suffix of SENSITIVE_SUFFIXES) {
    if (lower.endsWith(suffix)) return true;
  }
  return false;
};

export const sanitizeTimelineUrl = (input: string): string => {
  if (input.length === 0) return input;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    const hashAt = input.indexOf('#');
    return hashAt >= 0 ? input.slice(0, hashAt) : input;
  }
  parsed.hash = '';
  const namesToDelete: string[] = [];
  parsed.searchParams.forEach((_value, name) => {
    if (isSensitiveParam(name)) namesToDelete.push(name);
  });
  for (const name of namesToDelete) parsed.searchParams.delete(name);
  return parsed.toString();
};

// Sanitize a timeline payload in-place semantics (returns a new
// object). Both `url` and `canonicalUrl` go through the sanitizer.
// Used by the POST /v1/timeline/events handler before the event
// reaches importEdgeEvent.
export const sanitizeTimelinePayload = <
  T extends { readonly url: string; readonly canonicalUrl?: string },
>(
  payload: T,
): T => {
  const sanitizedUrl = sanitizeTimelineUrl(payload.url);
  const sanitizedCanonical =
    payload.canonicalUrl === undefined
      ? undefined
      : sanitizeTimelineUrl(payload.canonicalUrl);
  if (
    sanitizedUrl === payload.url &&
    sanitizedCanonical === payload.canonicalUrl
  ) {
    return payload;
  }
  return {
    ...payload,
    url: sanitizedUrl,
    ...(sanitizedCanonical === undefined ? {} : { canonicalUrl: sanitizedCanonical }),
  };
};

// Sync Contract v1 / Class F — privacy-aware URL sanitization for
// timeline payloads.
//
// Reviewer-flagged: the docs say sensitive query params are not
// captured, but the observer was forwarding raw `input.url` into the
// payload. canonicalThreadUrl strips query for known providers but
// is a no-op for everything else. This module sanitizes EVERY URL
// before it leaves the observer.
//
// Rules:
//   1. Drop fragment (#...).
//   2. Drop sensitive query params (token, code, state, session,
//      key, secret, password, auth, sig, …).
//   3. Drop fields that look auth-shaped by suffix (e.g. anything
//      ending in _token / _key / _secret).
//   4. Bad URLs are returned unchanged (better than crashing the
//      observer; downstream still treats the value as a string).

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
  // Common SSO providers
  'saml',
  'samlresponse',
  'samlrequest',
  'oauth2_token',
]);

const SENSITIVE_SUFFIXES: readonly string[] = ['_token', '_key', '_secret', '_password', '_auth', '_session', '_code'];

const isSensitiveParam = (name: string): boolean => {
  const lower = name.toLowerCase();
  if (SENSITIVE_PARAM_NAMES.has(lower)) return true;
  for (const suffix of SENSITIVE_SUFFIXES) {
    if (lower.endsWith(suffix)) return true;
  }
  return false;
};

// Sanitize a URL string for inclusion in a timeline payload.
//   - Strip fragment.
//   - Remove sensitive query params (full match or auth-shaped suffix).
//   - Preserve everything else (scheme + host + path + non-sensitive query).
//   - On parse failure, return the input with the fragment stripped
//     so we never accidentally retain a #... section.
export const sanitizeTimelineUrl = (input: string): string => {
  if (input.length === 0) return input;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    // Best-effort fragment strip on parse failure.
    const hashAt = input.indexOf('#');
    return hashAt >= 0 ? input.slice(0, hashAt) : input;
  }
  parsed.hash = '';
  // Walk a copy of the keys so we can delete safely while iterating.
  const namesToDelete: string[] = [];
  parsed.searchParams.forEach((_value, name) => {
    if (isSensitiveParam(name)) namesToDelete.push(name);
  });
  for (const name of namesToDelete) parsed.searchParams.delete(name);
  return parsed.toString();
};

// Whether a URL contains anything that would be stripped. Used by
// tests to assert the sanitizer fires on a fixture; not by the
// observer (which always sanitizes).
export const urlHasSensitiveData = (input: string): boolean => {
  try {
    const parsed = new URL(input);
    if (parsed.hash.length > 0) return true;
    let found = false;
    parsed.searchParams.forEach((_value, name) => {
      if (isSensitiveParam(name)) found = true;
    });
    return found;
  } catch {
    return input.includes('#');
  }
};

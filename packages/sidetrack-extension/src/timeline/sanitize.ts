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

// Stage 5 follow-up — marketing / ad-tracking parameters. Stripping
// these collapses "same content, different campaign" URLs into a
// single canonical record so the Inbox doesn't fragment by ad source.
// Different from SENSITIVE_PARAM_NAMES: these aren't secrets, they're
// noise. Per-site rule overrides are a separate Stage 5.1 follow-up
// — when that ships, a per-host config will be able to override this
// default (e.g. keep utm_source on a marketing-analytics dashboard).
const MARKETING_PARAM_NAMES: ReadonlySet<string> = new Set<string>([
  // Standard UTM
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  // Google Ads
  'gclid',
  'gbraid',
  'wbraid',
  'gad_source',
  'gad_campaignid',
  'dclid',
  // Microsoft / Bing Ads
  'msclkid',
  // Facebook / Meta
  'fbclid',
  // X / Twitter
  'twclid',
  // LinkedIn
  'li_fat_id',
  // Snapchat
  'sccid',
  // TikTok
  'ttclid',
  // Instagram share
  'igshid',
  // Yandex
  'yclid',
  // Mailchimp
  'mc_cid',
  'mc_eid',
  // Klaviyo
  '_kx',
  // Adobe Site Catalyst
  's_cid',
  // Vero
  'vero_conv',
  'vero_id',
  // Generic referral hints
  'ref',
  'ref_',
  'referrer',
  // Google Analytics cross-domain linker
  '_ga',
  '_gl',
]);

// Prefix-matched marketing param families. `hsa_*` is HubSpot ad
// tracking — every campaign produces hsa_acc/hsa_cam/hsa_grp/hsa_ad
// (etc). Prefix-strip is safer than enumerating each leaf since the
// network can introduce new sub-params at any time.
const MARKETING_PARAM_PREFIXES: readonly string[] = [
  'utm_',
  'hsa_',
  'gad_',
  'mc_',
];

const STRIP_MARKETING_PARAMS_ENV = 'SIDETRACK_TIMELINE_STRIP_MARKETING_PARAMS';

const stripMarketingParamsEnabled = (): boolean => {
  // process.env is available in the SW build via the WXT/vite shim.
  const raw =
    typeof process !== 'undefined' && process.env !== undefined
      ? process.env[STRIP_MARKETING_PARAMS_ENV]
      : undefined;
  if (raw === undefined || raw === '') return true;
  return raw !== '0' && raw.toLowerCase() !== 'false';
};

const isMarketingParam = (name: string): boolean => {
  const lower = name.toLowerCase();
  if (MARKETING_PARAM_NAMES.has(lower)) return true;
  for (const prefix of MARKETING_PARAM_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
};

// Sanitize a URL string for inclusion in a timeline payload.
//   - Strip fragment.
//   - Remove sensitive query params (full match or auth-shaped suffix).
//   - Remove marketing / ad-tracking params (utm_*, gclid, hsa_*,
//     gad_*, fbclid, …) unless SIDETRACK_TIMELINE_STRIP_MARKETING_PARAMS=0.
//   - Preserve everything else (scheme + host + path + non-noise query).
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
  const stripMarketing = stripMarketingParamsEnabled();
  // Walk a copy of the keys so we can delete safely while iterating.
  const namesToDelete: string[] = [];
  parsed.searchParams.forEach((_value, name) => {
    if (isSensitiveParam(name)) {
      namesToDelete.push(name);
      return;
    }
    if (stripMarketing && isMarketingParam(name)) {
      namesToDelete.push(name);
    }
  });
  for (const name of namesToDelete) parsed.searchParams.delete(name);
  return parsed.toString();
};

// Schemes that the timeline observer ignores. Internal browser surfaces
// (new-tab page, settings, devtools), extension pages, and `about:` /
// blank-document placeholders never represent meaningful user content.
// The boundary state machine + observer skip these so they never produce
// tab sessions, never appear in the Inbox, and never reach Connections.
const NON_TRACKABLE_SCHEMES = new Set([
  'about:',
  'chrome:',
  'chrome-extension:',
  'chrome-search:',
  'chrome-devtools:',
  'devtools:',
  'edge:',
  'view-source:',
  'data:',
  'javascript:',
]);

// Returns true when the URL has a scheme + host worth observing in the
// timeline. False for non-content browser surfaces (about:blank, the
// new-tab page, chrome-extension://, devtools://, etc.). `file://` IS
// trackable: local scaffolds (e.g. the test launchpad.html) act as
// openers for the real-page tabs the user clicks into, and the Flow
// Path view anchors on the launchpad to surface that lineage. The
// extension's Inbox UI filters file:// records from the visible list
// (src/sidepanel/tabsession/inboxPriority.ts) so they don't pollute
// the triage queue — the data itself stays in the projection.
//
// The check is scheme-based rather than domain-based, so it does not
// need a host allowlist and stays correct for any provider.
export const isTrackableUrl = (input: string): boolean => {
  if (typeof input !== 'string' || input.length === 0) return false;
  // Bare 'about:blank' (and friends) — handled before URL parsing because
  // some platforms accept it without a slash.
  if (input === 'about:blank' || input.startsWith('about:')) return false;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return false;
  }
  if (NON_TRACKABLE_SCHEMES.has(parsed.protocol)) return false;
  // Reject URLs whose protocol resolves to chrome-extension:// without
  // the trailing colon being included in NON_TRACKABLE_SCHEMES (some
  // platform variants strip it).
  if (parsed.protocol.startsWith('chrome')) return false;
  // Bare-host or empty-path file:// URLs carry no content.
  if (parsed.protocol === 'file:' && parsed.pathname.length <= 1) return false;
  return true;
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

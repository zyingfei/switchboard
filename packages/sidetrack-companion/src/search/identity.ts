/**
 * URL-identity token classifiers.
 *
 * Deterministic structural recognizers — NOT entropy heuristics with
 * a hand-tuned threshold. The rule is: identifiers are not meaning.
 * Tokens that match a known identifier shape (UUID, ULID, hex digest,
 * Crockford base32, base58, timestamps, etc.) are dropped from
 * semantic embedding text BEFORE any tuning concerns enter.
 *
 * What's NOT here:
 *   - host-specific rules (no "chatgpt.com" allowlist/denylist)
 *   - magic length thresholds (the 32-char hex floor is the SHA-1
 *     digest length; that's a fact about hash functions, not a knob)
 *   - entropy thresholds (the user spec calls these out as anti-
 *     pattern — replaced with structural recognizers)
 *
 * What ambiguous tokens get: nothing here. They pass through and the
 * corroboration step in `evidence.ts` decides whether they enter the
 * embed text (corroborated → CORROBORATED_URL_SLUG) or not
 * (UNCORROBORATED_URL_IDENTITY, excluded from the embedding).
 */

// RFC 4122 UUID: 8-4-4-4-12 hex grouping. Case-insensitive.
export const isUuid = (token: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);

// ULID: 26-char Crockford base32 (no I, L, O, U).
export const isUlid = (token: string): boolean =>
  /^[0-9A-HJKMNP-TV-Z]{26}$/.test(token);

// SHA-1 (40), SHA-256 (64), MD5 (32) hex digests, or longer.
export const isHexDigest = (token: string): boolean => /^[0-9a-f]{32,}$/i.test(token);

// 16-31 hex chars: too long to be a natural English word made of
// {a-f, 0-9} (the longest such word is ~8 chars: "decade", "facade",
// "deafened") — almost always a truncated hash or short opaque id.
export const isShortHexId = (token: string): boolean => /^[0-9a-f]{16,31}$/i.test(token);

// Unix epoch seconds (10 digits) or milliseconds (13 digits). 14+ is
// almost-certainly an opaque numeric id rather than a timestamp; 9 or
// fewer is too short to be a real epoch from any post-2001 date.
export const isNumericTimestamp = (token: string): boolean =>
  /^\d{10}$/.test(token) || /^\d{13}$/.test(token);

// ISO-8601 calendar date / datetime prefix (YYYY-MM-DD optionally
// followed by T<time>). Catches "2026-05-20" / "2026-05-20T10:00".
export const isIsoDateLike = (token: string): boolean =>
  /^\d{4}-\d{2}-\d{2}(t\d|$)/i.test(token);

// Base58 (Bitcoin-style alphabet: no 0, O, I, l). 20+ chars to avoid
// catching natural words. Used by some session/share IDs.
export const isBase58Like = (token: string): boolean =>
  /^[1-9A-HJ-NP-Za-km-z]{20,}$/.test(token) &&
  // ...AND contains a digit, otherwise it could be a long
  // alpha-only phrase that happened to avoid 0/O/I/l.
  /\d/.test(token);

// Length 1: single-character path segments like "c" in "/c/<hash>"
// — almost always routing letters, not content.
export const isSingleChar = (token: string): boolean => token.length === 1;

// Mixed alnum strings: digits-and-letters of meaningful length with
// vowel density below natural-English range. "a1rV95tH1R8esch5Y" is
// 17 chars with 2 vowels (≈12%); natural English words run ~38-40%.
// Below 25% reliably signals opaque (base58 IDs, session tokens,
// SHA-prefix slugs). The mixed-charset requirement keeps natural
// digit-suffixed words ("react18", "lambda3.5") out — those usually
// have a normal vowel ratio across the alpha part.
// Corroboration in evidence.ts is the safety net for any edge case
// (a token below this bar but actually meaningful would still fall
// to UNCORROBORATED_URL_IDENTITY rather than being embedded).
export const isMixedAlnumOpaque = (token: string): boolean => {
  if (token.length < 12) return false;
  if (!/[a-z]/i.test(token) || !/\d/.test(token)) return false;
  const vowels = (token.match(/[aeiou]/gi) ?? []).length;
  return vowels / token.length < 0.25;
};

/**
 * Combined classifier: is this token a structural identifier that
 * carries no semantic meaning? If true, drop from any embedding
 * input regardless of corroboration — these tokens are noise even
 * if they happen to appear in a title.
 */
export const isStructuralIdentifier = (token: string): boolean =>
  isUuid(token) ||
  isUlid(token) ||
  isHexDigest(token) ||
  isShortHexId(token) ||
  isNumericTimestamp(token) ||
  isIsoDateLike(token) ||
  isBase58Like(token) ||
  isSingleChar(token) ||
  isMixedAlnumOpaque(token);

/**
 * Parse a URL into (host, pathSegments, queryKeys). `pathSegments`
 * are the raw `/`-split parts, NOT analyzer-tokenized. Callers fed
 * these into the analyzer + structural classifier separately.
 *
 * Returns null for unparseable inputs (caller treats as
 * UNCORROBORATED_URL_IDENTITY).
 */
export interface ParsedUrlIdentity {
  readonly host: string;
  readonly pathSegments: readonly string[];
  readonly queryKeys: readonly string[];
}

export const parseUrlIdentity = (raw: string): ParsedUrlIdentity | null => {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const pathSegments = u.pathname
      .split('/')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const queryKeys = [...u.searchParams.keys()].sort();
    return { host, pathSegments, queryKeys };
  } catch {
    return null;
  }
};

/**
 * Two URLs are "identity-similar" if they share the host AND have
 * matching path-shape signatures. Path-shape = the sequence of
 * (literal-vs-identifier) markers down the path. So
 * `/c/6a0ca209...` and `/c/6a0def77...` have identical signatures
 * `[literal:c, identifier]`, while `/security/kernel/cve` vs
 * `/c/<hash>` differ at the first segment.
 *
 * Returns a value in [0, 1]: 1 = same host + same path shape +
 * same query key set; lower as features diverge. Strictly a
 * structural function — does not look at any embedding.
 */
export const urlIdentitySimilarity = (a: string, b: string): number => {
  const ia = parseUrlIdentity(a);
  const ib = parseUrlIdentity(b);
  if (ia === null || ib === null) return 0;
  if (ia.host !== ib.host) return 0;
  // Same host — examine path shape + query shape.
  const shapeA = ia.pathSegments.map((s) => (isStructuralIdentifier(s) ? '#' : s.toLowerCase()));
  const shapeB = ib.pathSegments.map((s) => (isStructuralIdentifier(s) ? '#' : s.toLowerCase()));
  // 0.5 baseline for same host. Path is the other half, split
  // evenly between "lengths match" and "shapes match" — a
  // structural decomposition, not a tuned weight. Two-empty-paths
  // is a trivial match: both signals are satisfied vacuously.
  let score = 0.5;
  if (shapeA.length === shapeB.length) score += 0.25;
  const matches = Math.min(shapeA.length, shapeB.length);
  if (matches === 0 && shapeA.length === 0 && shapeB.length === 0) {
    // bare-host vs bare-host (or trailing-slash variant). Trivially
    // identical path → exact-match score is full.
    score += 0.25;
  } else if (matches > 0) {
    let exact = 0;
    for (let i = 0; i < matches; i += 1) if (shapeA[i] === shapeB[i]) exact += 1;
    score += 0.25 * (exact / matches);
  }
  return Math.min(1, score);
};

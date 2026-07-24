// No-capture rules — the domain / "similar sites" blocklist that the
// master capture gate consults on EVERY capture ingress path.
//
// The rules are persisted alongside `captureEnabled` in UiSettings
// (see src/background/state.ts) so a single settings read yields both
// the pause switch and the blocklist. Matching is pure + synchronous
// over the already-loaded rules so it is cheap to call per navigation.
//
// Rule kinds are intentionally EXTENSIBLE (`kind` is a discriminated
// union). Today we ship:
//   - 'domain'  — a single site. When the rule carries a `host` (the
//                 default for the "Don't capture this site" action) it
//                 is HOST-SCOPED: it matches that exact host and its OWN
//                 subdomains only (a rule from meet.google.com blocks
//                 meet.google.com and *.meet.google.com, NOT google.com
//                 or mail.google.com). When `host` is absent (legacy
//                 persisted rules, or a rule explicitly created without a
//                 host) it falls back to the eTLD+1 FAMILY (registrable
//                 domain + all subdomains) for back-compat.
//   - 'similar' — the source SITE (host-scoped when `host` is present,
//                 else the eTLD+1 family) OR a small set of category
//                 tokens (account|billing|login|…) detected on the
//                 source page. A page matches cross-domain when its URL
//                 PATH or TITLE hits one of the rule's tokens.
//
// SCOPE INTENT (2026-07-24 fix): the user's "Don't capture <site>" action
// is HOST-level, not registrable-domain-level. Storing/matching a rule at
// eTLD+1 made a click on meet.google.com silently suppress ALL of
// google.com. The `host` field preserves the user's actual intent; the
// `domain` field is retained for family-wide rules and for legacy data.
//
// MIGRATION DECISION (no migration): rules persisted BEFORE this fix carry
// only `domain` (the eTLD+1) — the originating host is NOT recoverable from
// stored data. A `google.com` rule could have come from google.com,
// meet.google.com, mail.google.com, or been an intentional family-wide
// block; we cannot tell which. Silently narrowing it to a guessed host
// would risk re-enabling capture on a site the user meant to block (the
// LEAK direction — the unsafe one). Since over-broadness cannot be proven
// per-rule, legacy host-less rules KEEP their eTLD+1-family semantics
// (handled by the `host`-absent fallback in ruleCoversSite); only NEW
// rules are host-scoped. A user who wants to narrow an old rule deletes it
// and re-adds from the specific host. This keeps stored data untouched on
// load (no risky in-place rewrite) while making every new rule correct.
//
// A future 'semantic-exemplar' kind is planned (match by embedding
// similarity to a stored exemplar page). It slots in as another member
// of the union; the gate helper's `matchesNoCaptureRules` switch is the
// single place that needs a new arm. Do NOT special-case it elsewhere.

// The fixed category vocabulary for 'similar' rules (heuristics v1).
// Deliberately small + sensitivity-biased so cross-domain matching is
// conservative — these are the tokens that mark a page as an account /
// financial / medical surface worth suppressing family-wide.
export const NO_CAPTURE_CATEGORY_TOKENS = [
  'account',
  'billing',
  'login',
  'payment',
  'statement',
  'banking',
  'insurance',
  'medical',
  'tax',
] as const;

export type NoCaptureCategoryToken = (typeof NO_CAPTURE_CATEGORY_TOKENS)[number];

interface NoCaptureRuleBase {
  readonly id: string;
  // eTLD+1 the rule was created from (source page's registrable domain).
  // Retained for the FAMILY-wide fallback and for legacy rules that were
  // persisted before host-scoping existed.
  readonly domain: string;
  // The exact host the rule was created from (e.g. "meet.google.com").
  // When present, matching is HOST-SCOPED (host + its own subdomains).
  // Optional so rules persisted before this field (and explicitly
  // family-wide rules) keep the eTLD+1 fallback behavior.
  readonly host?: string;
  // Human label shown in Settings (usually the source host/domain).
  readonly label: string;
  readonly createdAt: string;
}

export interface DomainNoCaptureRule extends NoCaptureRuleBase {
  readonly kind: 'domain';
}

export interface SimilarNoCaptureRule extends NoCaptureRuleBase {
  readonly kind: 'similar';
  // Category tokens detected on the source page at rule-creation time.
  // A cross-domain page matches when its PATH or TITLE hits one of
  // these. Empty tokens ⇒ the rule degenerates to a same-family match.
  readonly categoryTokens: readonly NoCaptureCategoryToken[];
}

// Extensible union — future 'semantic-exemplar' rules add a member here.
export type NoCaptureRule = DomainNoCaptureRule | SimilarNoCaptureRule;

const MULTI_PART_TLDS: ReadonlySet<string> = new Set([
  'co.uk',
  'org.uk',
  'gov.uk',
  'ac.uk',
  'co.jp',
  'com.au',
  'net.au',
  'org.au',
  'com.br',
  'co.in',
  'co.nz',
  'com.mx',
  'co.za',
]);

// Best-effort registrable-domain (eTLD+1) extraction WITHOUT a full
// public-suffix list. Handles a small set of common multi-part TLDs
// (co.uk, com.au, …); everything else falls back to the last two
// labels. Conservative by design — over-broadening a no-capture rule
// (suppressing MORE) is safer than under-broadening (leaking).
export const registrableDomain = (rawHost: string): string => {
  const host = rawHost.trim().toLowerCase().replace(/\.$/u, '');
  if (host.length === 0) return '';
  // IP literals have no registrable domain — return as-is.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host) || host.includes(':')) return host;
  const labels = host.split('.').filter((label) => label.length > 0);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(lastTwo)) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
};

// Extract the eTLD+1 from a full URL. Returns '' for non-http(s) or
// unparseable input (those are never capture ingress targets anyway).
export const registrableDomainFromUrl = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return registrableDomain(url.hostname);
  } catch {
    return '';
  }
};

// Extract the bare host (no port) from a full URL, normalized lowercase
// with any trailing dot stripped so it compares cleanly against a stored
// rule host. Returns '' for non-http(s) or unparseable input.
export const hostFromUrl = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.hostname.toLowerCase().replace(/\.$/u, '');
  } catch {
    return '';
  }
};

// Label-boundary-safe host containment: does `pageHost` equal `ruleHost`
// or sit UNDER it as a subdomain? Matching on a leading-dot boundary is
// what makes this safe — "evilgoogle.com" does NOT end with ".google.com"
// so it never matches a google.com host rule, and "meetxgoogle.com" never
// matches a "meet.google.com" rule. Both inputs are assumed already
// lowercased + trailing-dot-stripped (see hostFromUrl / registrableDomain).
export const hostMatchesRuleHost = (pageHost: string, ruleHost: string): boolean => {
  if (ruleHost.length === 0 || pageHost.length === 0) return false;
  return pageHost === ruleHost || pageHost.endsWith(`.${ruleHost}`);
};

// Detect which category tokens a page hits. Conservative: a token
// counts only when it appears in the URL PATH (+ query/hash) or the
// page TITLE, never in the bare host — so "myaccount.example.com"'s
// host alone does not trip 'account', but "/account/billing" or a
// title of "Account statement" does. Word-boundary matched to avoid
// substring false-friends (e.g. "taxonomy" must not hit 'tax').
export const detectCategoryTokens = (input: {
  readonly url: string;
  readonly title?: string;
}): NoCaptureCategoryToken[] => {
  let path = '';
  try {
    const url = new URL(input.url.trim());
    path = `${url.pathname} ${url.search} ${url.hash}`.toLowerCase();
  } catch {
    path = '';
  }
  const title = (input.title ?? '').toLowerCase();
  const haystack = `${path} ${title}`;
  const hits: NoCaptureCategoryToken[] = [];
  for (const token of NO_CAPTURE_CATEGORY_TOKENS) {
    // \b word boundaries around the token; token chars are all [a-z]
    // so a simple boundary regex is safe.
    const re = new RegExp(`\\b${token}\\b`, 'u');
    if (re.test(haystack)) hits.push(token);
  }
  return hits;
};

// The scope a rule blocks, as a stable de-dup key: the host for a
// host-scoped rule, else the eTLD+1 domain for a legacy / family-wide
// rule. Two rules of the same kind with the same scope key are
// equivalent, so the producer can de-dup on (kind, scopeKey) without
// collapsing distinct sibling hosts (meet.google.com vs mail.google.com)
// that happen to share an eTLD+1.
export const noCaptureRuleScopeKey = (rule: {
  readonly host?: string;
  readonly domain: string;
}): string => (typeof rule.host === 'string' && rule.host.length > 0 ? rule.host : rule.domain);

// Return the FIRST no-capture rule the page matches, or null if none.
// Pure + synchronous — callers pass the already-loaded rule list. This
// is the single matching primitive; `matchesNoCaptureRules` is a thin
// boolean wrapper so the gate and the UI share ONE code path (the UI
// needs the matched rule to name it; the gate only needs the boolean).
export const firstMatchingNoCaptureRule = (
  page: { readonly url: string; readonly title?: string },
  rules: readonly NoCaptureRule[],
): NoCaptureRule | null => {
  if (rules.length === 0) return null;
  const pageDomain = registrableDomainFromUrl(page.url);
  if (pageDomain.length === 0) return null;
  // Host for host-scoped rule matching (may be '' for odd inputs, in
  // which case host-scoped rules simply won't match — the eTLD+1 family
  // path still works via pageDomain).
  const pageHost = hostFromUrl(page.url);
  // Does `rule` cover this page's SITE? Host-scoped when the rule carries
  // a `host` (host + own subdomains, label-boundary-safe); otherwise the
  // eTLD+1 family (back-compat for legacy / explicitly family-wide rules).
  const ruleCoversSite = (rule: NoCaptureRule): boolean =>
    typeof rule.host === 'string' && rule.host.length > 0
      ? hostMatchesRuleHost(pageHost, rule.host)
      : rule.domain.length > 0 && rule.domain === pageDomain;
  // Lazily computed — only when a 'similar' cross-domain rule needs it.
  let pageTokens: readonly NoCaptureCategoryToken[] | null = null;
  const tokensForPage = (): readonly NoCaptureCategoryToken[] => {
    if (pageTokens === null) {
      pageTokens = detectCategoryTokens({
        url: page.url,
        ...(page.title === undefined ? {} : { title: page.title }),
      });
    }
    return pageTokens;
  };

  for (const rule of rules) {
    switch (rule.kind) {
      case 'domain': {
        // Host-scoped (host + own subdomains) when the rule carries a
        // host; eTLD+1 family otherwise (legacy / family-wide rules).
        if (ruleCoversSite(rule)) return rule;
        break;
      }
      case 'similar': {
        // The source SITE always matches (host-scoped when the rule has a
        // host, else the eTLD+1 family).
        if (ruleCoversSite(rule)) return rule;
        // Cross-domain: require at least one category-token overlap AND
        // the token must be present in the PAGE's path/title (enforced
        // by detectCategoryTokens — bare-domain hits don't count).
        if (rule.categoryTokens.length > 0) {
          const hits = tokensForPage();
          if (hits.some((token) => rule.categoryTokens.includes(token))) return rule;
        }
        break;
      }
      // No default — the union is exhaustive today. A future
      // 'semantic-exemplar' arm lands here.
    }
  }
  return null;
};

// Does the given page match ANY of the supplied no-capture rules?
// Pure + synchronous — callers pass the already-loaded rule list.
export const matchesNoCaptureRules = (
  page: { readonly url: string; readonly title?: string },
  rules: readonly NoCaptureRule[],
): boolean => firstMatchingNoCaptureRule(page, rules) !== null;

// Short human label for a matched rule, for UI ("Not captured — rule: …").
// Domain rules read as the eTLD+1; 'similar' rules read as
// "similar:<domain>" to signal the cross-domain category match.
export const noCaptureRuleDisplayLabel = (rule: NoCaptureRule): string => {
  // Prefer the explicit label; else the host (host-scoped rules) so the UI
  // names the site the user acted on; else the eTLD+1 family.
  const fallback = typeof rule.host === 'string' && rule.host.length > 0 ? rule.host : rule.domain;
  const base = rule.label.length > 0 ? rule.label : fallback;
  return rule.kind === 'similar' ? `similar:${base}` : base;
};

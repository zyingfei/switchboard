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
//   - 'domain'  — exact eTLD+1 family (the registrable domain plus all
//                 subdomains).
//   - 'similar' — the source eTLD+1 family OR a small set of category
//                 tokens (account|billing|login|…) detected on the
//                 source page. A page matches cross-domain when its URL
//                 PATH or TITLE hits one of the rule's tokens.
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
  readonly domain: string;
  // Human label shown in Settings (usually the source domain).
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

// Does the given page match ANY of the supplied no-capture rules?
// Pure + synchronous — callers pass the already-loaded rule list.
export const matchesNoCaptureRules = (
  page: { readonly url: string; readonly title?: string },
  rules: readonly NoCaptureRule[],
): boolean => {
  if (rules.length === 0) return false;
  const pageDomain = registrableDomainFromUrl(page.url);
  if (pageDomain.length === 0) return false;
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
        // Exact eTLD+1 family (registrableDomain collapses subdomains).
        if (rule.domain.length > 0 && rule.domain === pageDomain) return true;
        break;
      }
      case 'similar': {
        // Same family always matches (the source domain itself).
        if (rule.domain.length > 0 && rule.domain === pageDomain) return true;
        // Cross-domain: require at least one category-token overlap AND
        // the token must be present in the PAGE's path/title (enforced
        // by detectCategoryTokens — bare-domain hits don't count).
        if (rule.categoryTokens.length > 0) {
          const hits = tokensForPage();
          if (hits.some((token) => rule.categoryTokens.includes(token))) return true;
        }
        break;
      }
      // No default — the union is exhaustive today. A future
      // 'semantic-exemplar' arm lands here.
    }
  }
  return false;
};

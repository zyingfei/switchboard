// Domain tombstone — the companion-side privacy gate for the
// extension's domain no-capture blocklist "Purge captured data"
// action. A tombstone records a match spec (a domain family, optionally
// with 'similar' category tokens); every READ/SERVE boundary excludes
// records whose URL matches an active tombstone, and derived stores
// (recall vectors) drop matching entities.
//
// Semantics = TOMBSTONE + HIDE. The raw append-only JSONL event log is
// NOT rewritten (append indexes reject in-process shard rewrites) — a
// full offline scrub is a separate future tool. Tombstone filtering is
// therefore a PRIVACY GATE at read boundaries, NOT serving math: it
// only decides visibility, never scoring.
//
// This mirrors the extension's src/capture/noCaptureRules.ts matcher so
// a rule created in the extension purges exactly the pages that rule
// would have blocked. Keep the two in sync.

export const DOMAIN_TOMBSTONE = 'privacy.domain.tombstone' as const;

export const DOMAIN_TOMBSTONE_CATEGORY_TOKENS = [
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

export type DomainTombstoneCategoryToken = (typeof DOMAIN_TOMBSTONE_CATEGORY_TOKENS)[number];

export interface DomainTombstonePayload {
  readonly payloadVersion: 1;
  // 'domain'  — the eTLD+1 family only.
  // 'similar' — the eTLD+1 family OR cross-domain pages hitting a token.
  readonly kind: 'domain' | 'similar';
  readonly domain: string;
  readonly categoryTokens?: readonly DomainTombstoneCategoryToken[];
  readonly tombstonedAt: string;
  readonly dimensions?: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCategoryToken = (value: unknown): value is DomainTombstoneCategoryToken =>
  typeof value === 'string' &&
  (DOMAIN_TOMBSTONE_CATEGORY_TOKENS as readonly string[]).includes(value);

export const isDomainTombstonePayload = (value: unknown): value is DomainTombstonePayload => {
  if (!isRecord(value)) return false;
  if (value['payloadVersion'] !== 1) return false;
  if (value['kind'] !== 'domain' && value['kind'] !== 'similar') return false;
  if (typeof value['domain'] !== 'string' || value['domain'].length === 0) return false;
  if (
    value['categoryTokens'] !== undefined &&
    (!Array.isArray(value['categoryTokens']) || !value['categoryTokens'].every(isCategoryToken))
  ) {
    return false;
  }
  if (typeof value['tombstonedAt'] !== 'string') return false;
  return true;
};

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

// Best-effort registrable domain (eTLD+1). Mirrors the extension.
export const registrableDomain = (rawHost: string): string => {
  const host = rawHost.trim().toLowerCase().replace(/\.$/u, '');
  if (host.length === 0) return '';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host) || host.includes(':')) return host;
  const labels = host.split('.').filter((label) => label.length > 0);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(lastTwo)) return labels.slice(-3).join('.');
  return lastTwo;
};

export const registrableDomainFromUrl = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return registrableDomain(url.hostname);
  } catch {
    return '';
  }
};

const detectCategoryTokens = (input: {
  readonly url: string;
  readonly title?: string;
}): DomainTombstoneCategoryToken[] => {
  let path = '';
  try {
    const url = new URL(input.url.trim());
    path = `${url.pathname} ${url.search} ${url.hash}`.toLowerCase();
  } catch {
    path = '';
  }
  const title = (input.title ?? '').toLowerCase();
  const haystack = `${path} ${title}`;
  const hits: DomainTombstoneCategoryToken[] = [];
  for (const token of DOMAIN_TOMBSTONE_CATEGORY_TOKENS) {
    if (new RegExp(`\\b${token}\\b`, 'u').test(haystack)) hits.push(token);
  }
  return hits;
};

// A compiled set of tombstones, ready for cheap repeated matching at a
// read boundary. Build once per read pass.
export interface DomainTombstoneSet {
  readonly isEmpty: boolean;
  // Does a page (url + optional title) match any active tombstone?
  readonly matchesPage: (page: { url?: string; title?: string }) => boolean;
  // Convenience for boundaries that only have a bare domain / node id.
  readonly matchesDomain: (domain: string) => boolean;
}

export const buildDomainTombstoneSet = (
  payloads: readonly DomainTombstonePayload[],
): DomainTombstoneSet => {
  const domainRules: string[] = [];
  const similarRules: { domain: string; tokens: readonly DomainTombstoneCategoryToken[] }[] = [];
  for (const payload of payloads) {
    if (payload.kind === 'domain') {
      domainRules.push(payload.domain);
    } else {
      similarRules.push({ domain: payload.domain, tokens: payload.categoryTokens ?? [] });
    }
  }
  const blockedDomains = new Set(domainRules.concat(similarRules.map((rule) => rule.domain)));
  const isEmpty = domainRules.length === 0 && similarRules.length === 0;

  const matchesDomain = (domain: string): boolean => {
    if (domain.length === 0) return false;
    return blockedDomains.has(domain);
  };

  const matchesPage = (page: { url?: string; title?: string }): boolean => {
    if (isEmpty) return false;
    if (typeof page.url !== 'string' || page.url.length === 0) return false;
    const pageDomain = registrableDomainFromUrl(page.url);
    if (pageDomain.length === 0) return false;
    // Same-family match (covers both 'domain' and 'similar' sources).
    if (blockedDomains.has(pageDomain)) return true;
    // Cross-domain 'similar' — require a category-token overlap present
    // in the page's PATH or TITLE (never the bare host).
    const similarWithTokens = similarRules.filter((rule) => rule.tokens.length > 0);
    if (similarWithTokens.length === 0) return false;
    const pageTokens = detectCategoryTokens({
      url: page.url,
      ...(page.title === undefined ? {} : { title: page.title }),
    });
    if (pageTokens.length === 0) return false;
    return similarWithTokens.some((rule) =>
      rule.tokens.some((token) => pageTokens.includes(token)),
    );
  };

  return { isEmpty, matchesPage, matchesDomain };
};

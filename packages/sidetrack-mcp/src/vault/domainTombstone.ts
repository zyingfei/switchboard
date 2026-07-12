// Domain-tombstone read gate for the MCP live-vault reader.
//
// The companion persists a domain-tombstone list at
// `_BAC/privacy/domain-tombstones.json` (see
// sidetrack-companion/src/privacy/domainTombstoneStore.ts). The MCP
// server reads the SAME vault directly (context packs + snapshot
// resource), so it must apply the same privacy gate — otherwise an
// agent could read a purged domain the timeline/recall boundaries hide.
//
// This is a self-contained mirror of the companion matcher (the MCP
// package doesn't depend on the companion package). Keep in sync with
// sidetrack-companion/src/privacy/domainTombstone.ts.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const CATEGORY_TOKENS = [
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

type CategoryToken = (typeof CATEGORY_TOKENS)[number];

interface Tombstone {
  readonly kind: 'domain' | 'similar';
  readonly domain: string;
  readonly categoryTokens?: readonly CategoryToken[];
}

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

const registrableDomain = (rawHost: string): string => {
  const host = rawHost.trim().toLowerCase().replace(/\.$/u, '');
  if (host.length === 0) return '';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host) || host.includes(':')) return host;
  const labels = host.split('.').filter((label) => label.length > 0);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(lastTwo)) return labels.slice(-3).join('.');
  return lastTwo;
};

const registrableDomainFromUrl = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return registrableDomain(url.hostname);
  } catch {
    return '';
  }
};

const detectTokens = (input: { url: string; title?: string }): CategoryToken[] => {
  let path = '';
  try {
    const url = new URL(input.url.trim());
    path = `${url.pathname} ${url.search} ${url.hash}`.toLowerCase();
  } catch {
    path = '';
  }
  const haystack = `${path} ${(input.title ?? '').toLowerCase()}`;
  return CATEGORY_TOKENS.filter((token) => new RegExp(`\\b${token}\\b`, 'u').test(haystack));
};

export interface DomainTombstoneGate {
  readonly isEmpty: boolean;
  readonly matchesPage: (page: { url?: string; title?: string }) => boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseTombstones = (parsed: unknown): Tombstone[] => {
  if (!isRecord(parsed) || !Array.isArray(parsed['tombstones'])) return [];
  const out: Tombstone[] = [];
  for (const raw of parsed['tombstones']) {
    if (!isRecord(raw)) continue;
    if (raw['kind'] !== 'domain' && raw['kind'] !== 'similar') continue;
    if (typeof raw['domain'] !== 'string' || raw['domain'].length === 0) continue;
    const tokens = Array.isArray(raw['categoryTokens'])
      ? (raw['categoryTokens'].filter((token): token is CategoryToken =>
          (CATEGORY_TOKENS as readonly string[]).includes(token as string),
        ))
      : undefined;
    out.push({
      kind: raw['kind'],
      domain: raw['domain'],
      ...(tokens === undefined ? {} : { categoryTokens: tokens }),
    });
  }
  return out;
};

export const buildGate = (tombstones: readonly Tombstone[]): DomainTombstoneGate => {
  const blockedDomains = new Set(tombstones.map((t) => t.domain));
  const similarWithTokens = tombstones.filter(
    (t) => t.kind === 'similar' && (t.categoryTokens?.length ?? 0) > 0,
  );
  const isEmpty = tombstones.length === 0;
  const matchesPage = (page: { url?: string; title?: string }): boolean => {
    if (isEmpty) return false;
    if (typeof page.url !== 'string' || page.url.length === 0) return false;
    const domain = registrableDomainFromUrl(page.url);
    if (domain.length === 0) return false;
    if (blockedDomains.has(domain)) return true;
    if (similarWithTokens.length === 0) return false;
    const pageTokens = detectTokens({
      url: page.url,
      ...(page.title === undefined ? {} : { title: page.title }),
    });
    if (pageTokens.length === 0) return false;
    return similarWithTokens.some((rule) =>
      (rule.categoryTokens ?? []).some((token) => pageTokens.includes(token)),
    );
  };
  return { isEmpty, matchesPage };
};

// Load the tombstone gate from a vault root. Missing / corrupt file ⇒
// an empty gate (nothing hidden) — the same fail-open-toward-empty as
// the companion reader (the durable source is the event log).
export const loadDomainTombstoneGate = async (
  vaultRoot: string,
): Promise<DomainTombstoneGate> => {
  try {
    const raw = await readFile(
      join(vaultRoot, '_BAC', 'privacy', 'domain-tombstones.json'),
      'utf8',
    );
    return buildGate(parseTombstones(JSON.parse(raw)));
  } catch {
    return buildGate([]);
  }
};

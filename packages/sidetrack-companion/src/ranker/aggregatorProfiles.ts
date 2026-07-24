// Aggregator (multi-topic platform) profiles — the single source of truth for
// how a large multi-author/multi-topic site's URLs are classified.
//
// WHY THIS EXISTS (first-principles). An aggregator domain hosts at least two
// fundamentally different page types:
//
//   1. FEED / listing pages (news, news?p=2, /newest, /front, user pages):
//      ephemeral, multi-topic, weak content identity. Domain-level and shared
//      site-chrome title/path tokens from these pages are pure NOISE — grouping
//      by them linked an AI-generated-video Hacker News post to unrelated
//      linux-security items and filed it at 82% confidence (2026-07-10
//      false-friend). The guard is RIGHT to suppress these.
//
//   2. ITEM / content pages (item?id=X, /r/x/comments/…, /watch?v=…): each is a
//      distinct content object about ONE story with a stable per-page identity
//      (the ?id= / comments path IS the identity). Two items about LLM tooling
//      ARE related; an item and the article it opened ARE structurally related.
//      The old blanket guard suppressed ALL of this wholesale — which is why HN
//      item pages resolved to "No signal yet" for weeks even when the user
//      dwelled. The guard is WRONG for these.
//
// This registry lets the guard distinguish the two so it can quarantine FEED
// pages while letting ITEM pages participate in content-level similarity. It is
// consumed by BOTH the ranker guard (candidates.ts) and the resolver guard
// (tabsession/similarity.ts) so there is exactly ONE classifier.
//
// EXTENSIBILITY (CODING_STANDARDS "open for extension"). A new aggregator is a
// new entry in AGGREGATOR_PROFILES — no edits to any central conditional. Each
// profile is keyed by REGISTRABLE domain so every subdomain is covered
// (news.ycombinator.com, old.reddit.com, m.youtube.com, …).

export type AggregatorPageType = 'feed' | 'item' | 'not-aggregator';

export interface AggregatorProfile {
  // Registrable domain (e.g. `ycombinator.com`). Matched as a suffix so any
  // subdomain qualifies.
  readonly registrableDomain: string;
  // True when the URL is a distinct content object (an item/comments/watch
  // page). When neither isItemUrl nor an explicit isFeedUrl matches, the URL is
  // treated as a FEED page (the conservative default — feeds are the noisy
  // class, so unknown shapes stay quarantined).
  readonly isItemUrl: (parsed: URL) => boolean;
  // Site-chrome title suffixes to strip from the embedded corpus (boilerplate
  // hygiene). Small, exact, case-insensitive tail match.
  readonly siteTitleSuffixes: readonly string[];
  // Optional pattern for site chrome that is NOT a fixed literal — e.g. reddit
  // titles end `… : r/<subreddit>`, where the subreddit varies per page, so a
  // literal suffix can never match. The pattern MUST be tail-anchored (end with
  // `$`) and is applied case-insensitively; the matched tail is stripped. Use
  // this instead of siteTitleSuffixes when the shared chrome carries a variable
  // token (subreddit, author, …).
  readonly siteTitleSuffixPattern?: RegExp;
  // Optional: recover a coherent sub-community grouping key the same way GitHub
  // groups by `repo:owner/repo` rather than `domain:github.com`.
  readonly communityKey?: (
    hostname: string,
    segments: readonly string[],
  ) => string | null;
}

const hnProfile: AggregatorProfile = {
  registrableDomain: 'ycombinator.com',
  // HN item pages are `item?id=X`. Everything else on the domain (`/`, `/?p=2`,
  // `/newest`, `/front`, `/from?site=…`, `/active`, user pages) is a feed.
  isItemUrl: (parsed) =>
    parsed.pathname.replace(/\/+$/u, '') === '/item' && parsed.searchParams.has('id'),
  siteTitleSuffixes: [' | Hacker News'],
};

const redditProfile: AggregatorProfile = {
  registrableDomain: 'reddit.com',
  // A reddit content object is a comments thread: /r/<sub>/comments/<id>/…
  isItemUrl: (parsed) => {
    const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
    return segments[0] === 'r' && segments[2] === 'comments' && typeof segments[3] === 'string';
  },
  // Real reddit titles end `… : r/<subreddit>` (verified against the live vault:
  // 0/32 titles matched a literal ' : reddit'; the shared chrome is the ' : r/'
  // prefix + the per-page subreddit). A fixed suffix cannot match a variable
  // subreddit, so strip by tail-anchored pattern instead.
  siteTitleSuffixes: [],
  siteTitleSuffixPattern: / : r\/[A-Za-z0-9_]+$/u,
  communityKey: (hostname, segments) =>
    segments[0] === 'r' && segments[1] !== undefined && segments[1].length > 0
      ? `forum:reddit.com/r/${segments[1]}`
      : null,
};

const youtubeProfile: AggregatorProfile = {
  registrableDomain: 'youtube.com',
  // A YouTube content object is /watch?v=… (also live/shorts).
  isItemUrl: (parsed) => {
    const path = parsed.pathname.replace(/\/+$/u, '');
    if (path === '/watch' && parsed.searchParams.has('v')) return true;
    return path.startsWith('/shorts/') || path.startsWith('/live/');
  },
  siteTitleSuffixes: [' - YouTube'],
};

const mediumProfile: AggregatorProfile = {
  registrableDomain: 'medium.com',
  // A Medium article is /@author/slug-hash. Treat the author profile alone as a
  // feed; a slug under it is an item.
  isItemUrl: (parsed) => {
    const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
    return (
      segments[0] !== undefined &&
      segments[0].startsWith('@') &&
      segments[1] !== undefined &&
      segments[1].length > 0
    );
  },
  siteTitleSuffixes: [' | Medium'],
  communityKey: (_hostname, segments) => {
    const author = segments[0];
    return author !== undefined && author.startsWith('@') && author.length > 1
      ? `author:medium.com/${author}`
      : null;
  },
};

// Domains with no per-page item shape (pure feeds / search / chat surfaces).
// Every page is a FEED — the domain-wide guard applies wholesale, which is
// correct for these (a search results page or a chat home is never a stable
// content object we want to group by URL). Listed WITHOUT an item classifier so
// isItemUrl is always false.
const FEED_ONLY_DOMAINS: readonly string[] = [
  'lobste.rs',
  'twitter.com',
  'x.com',
  't.co',
  'youtu.be',
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'substack.com',
  'quora.com',
  'pinterest.com',
  'tumblr.com',
  'stackoverflow.com',
  'stackexchange.com',
  'google.com',
  'bing.com',
  'duckduckgo.com',
  'chatgpt.com',
  'openai.com',
  'claude.ai',
];

const feedOnlyProfile = (registrableDomain: string): AggregatorProfile => ({
  registrableDomain,
  isItemUrl: () => false,
  siteTitleSuffixes: [],
});

// Registry keyed by registrable domain. Richly-classified aggregators first,
// then the feed-only tail. This is the ONLY list of coarse multi-topic domains
// (candidates.ts and similarity.ts both consume it).
const AGGREGATOR_PROFILES: readonly AggregatorProfile[] = [
  hnProfile,
  redditProfile,
  youtubeProfile,
  mediumProfile,
  ...FEED_ONLY_DOMAINS.map(feedOnlyProfile),
];

const profilesByDomain: ReadonlyMap<string, AggregatorProfile> = new Map(
  AGGREGATOR_PROFILES.map((profile) => [profile.registrableDomain, profile]),
);

// Normalize a hostname for suffix matching: lowercase, strip a leading `www.`
// and a trailing dot (FQDN form, e.g. `news.ycombinator.com.`).
const normalizeHost = (hostname: string): string =>
  hostname.toLowerCase().replace(/^www\./u, '').replace(/\.$/u, '');

// Return the matching aggregator profile for a hostname (by registrable-domain
// suffix), or undefined for a non-aggregator host.
export const aggregatorProfileForHost = (hostname: string): AggregatorProfile | undefined => {
  const host = normalizeHost(hostname);
  if (host.length === 0) return undefined;
  const labels = host.split('.');
  // Test the full host and each registrable suffix, never the bare TLD.
  for (let index = 0; index < labels.length - 1; index += 1) {
    const profile = profilesByDomain.get(labels.slice(index).join('.'));
    if (profile !== undefined) return profile;
  }
  return undefined;
};

// True when the hostname belongs to a coarse multi-topic aggregator platform.
// Preserves the exact semantics of the old registrable-domain classifier.
export const isAggregatorHost = (hostname: string): boolean =>
  aggregatorProfileForHost(hostname) !== undefined;

// Classify an already-parsed URL into feed vs item vs not-aggregator. Exposed
// so hot-path callers that already hold a parsed URL avoid re-parsing (the
// per-candidate ranker path). See classifyAggregatorPage for the string form.
export const classifyAggregatorPageForUrl = (parsed: URL): AggregatorPageType => {
  const profile = aggregatorProfileForHost(parsed.hostname);
  if (profile === undefined) return 'not-aggregator';
  return profile.isItemUrl(parsed) ? 'item' : 'feed';
};

// Classify a URL into feed vs item vs not-aggregator. The CORE new capability:
// item pages are content objects that should participate fully in content-level
// similarity; feed pages stay quarantined by the guard.
export const classifyAggregatorPage = (url: string): AggregatorPageType => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'not-aggregator';
  }
  return classifyAggregatorPageForUrl(parsed);
};

// Strip a known site-title suffix (boilerplate chrome) from a title, if the
// host has a profile that declares one. Case-insensitive tail match; returns the
// title unchanged for non-aggregator hosts or when no suffix matches. Used by
// the corpus cleaner so the shared "| Hacker News" tail stops inflating
// same-site cosine.
export const stripSiteTitleSuffix = (title: string, hostname: string): string => {
  const profile = aggregatorProfileForHost(hostname);
  if (profile === undefined) return title;
  const lower = title.toLowerCase();
  for (const suffix of profile.siteTitleSuffixes) {
    if (lower.endsWith(suffix.toLowerCase())) {
      return title.slice(0, title.length - suffix.length).trimEnd();
    }
  }
  // Variable-tail chrome (e.g. reddit's ` : r/<subreddit>`). The pattern is
  // tail-anchored + case-insensitive; strip the matched tail if present.
  if (profile.siteTitleSuffixPattern !== undefined) {
    const pattern = new RegExp(
      profile.siteTitleSuffixPattern.source,
      profile.siteTitleSuffixPattern.flags.includes('i')
        ? profile.siteTitleSuffixPattern.flags
        : `${profile.siteTitleSuffixPattern.flags}i`,
    );
    const stripped = title.replace(pattern, '');
    if (stripped !== title) return stripped.trimEnd();
  }
  return title;
};

// Recover a sub-community grouping key when the profile declares one (subreddit,
// Medium author). Null when the profile has no community keying or the URL does
// not encode a community.
export const aggregatorCommunityKey = (
  hostname: string,
  segments: readonly string[],
): string | null => {
  const profile = aggregatorProfileForHost(hostname);
  if (profile === undefined || profile.communityKey === undefined) return null;
  return profile.communityKey(normalizeHost(hostname), segments);
};

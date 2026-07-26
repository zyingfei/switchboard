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

// GitHub reserved first-path segments — routes that are NOT a user/org and so
// never begin an `/owner/repo` item. Derived from the live vault (doctrine
// rule 1): `search`, `sessions` (OAuth/2FA), `login`, `orgs` all appeared as
// github.com first segments alongside the owner/repo pages. The rest of the
// list is GitHub's well-known reserved-route set so a future capture of e.g.
// /settings or /notifications also classifies as a feed rather than a phantom
// `owner=settings` repo. Lowercased for case-insensitive comparison.
const GITHUB_RESERVED_ROUTES: ReadonlySet<string> = new Set<string>([
  'search',
  'sessions',
  'login',
  'logout',
  'join',
  'orgs',
  'users',
  'settings',
  'notifications',
  'dashboard',
  'marketplace',
  'explore',
  'topics',
  'trending',
  'collections',
  'sponsors',
  'about',
  'pricing',
  'features',
  'new',
  'codespaces',
  'apps',
  'issues',
  'pulls',
  'watching',
  'stars',
  'account',
]);

// Shared code-forge item predicate: `/owner/repo…` where the first segment is a
// user/org (not a reserved route) and a non-empty repo segment follows.
const codeForgeIsItemUrl = (parsed: URL, reserved: ReadonlySet<string>): boolean => {
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  const owner = segments[0];
  const repo = segments[1];
  if (owner === undefined || repo === undefined) return false;
  return !reserved.has(owner.toLowerCase());
};

// Shared code-forge community key: `repo:<host>/<owner>/<repo>` (the repo IS the
// sub-community). Null for reserved-route or shape-less paths.
const codeForgeCommunityKey = (
  hostname: string,
  segments: readonly string[],
  reserved: ReadonlySet<string>,
): string | null => {
  const owner = segments[0];
  const repo = segments[1];
  if (owner === undefined || repo === undefined) return null;
  if (reserved.has(owner.toLowerCase())) return null;
  const normRepo = repo.replace(/\.git$/iu, '');
  return `repo:${hostname}/${owner.toLowerCase()}/${normRepo.toLowerCase()}`;
};

// github.com — a multi-topic HUB in the same sense HN is: the domain hosts one
// FEED surface (root, /search, user/org profiles, /trending, auth) plus many
// distinct ITEM pages, each a stable content object keyed by `/owner/repo`
// (and every sub-page under it: /pull/N, /issues, /blob/…, /tree/…,
// /releases/…). WHY THIS EXISTS: github.com was DROPPED from this registry in
// the COARSE_MULTI_TOPIC_DOMAINS→registry migration (PR #274) — only the
// `repo:owner/repo` comment survived — so the hub-domain discriminativeness
// gate never muted the `domain:github.com` vote. On the lightly-filed live
// vault that let github's domain vote (one global argmax over a handful of
// filed repos) mis-file unrelated repos (2026-07-26 vote-arm failure). Adding
// the profile restores isAggregatorHost(github.com)=true (candidates.ts /
// similarity.ts guard); the parallel COARSE_MULTI_TOPIC_DOMAIN_PRIOR entry in
// attribution-v1/state.ts is what actually gates the vote arm's domain signal
// (the two lists are kept in sync BY INTENT — see that file's note).
//
// URL shapes DERIVED FROM THE LIVE TEST VAULT (247 github.com timeline visits,
// read-only 2026-07-26): item `/owner/repo` (120 obs, the dominant shape) plus
// its sub-pages (/pull/N ×many, /blob, /tree, /issues, /releases, /graphs,
// /pulls); feed `/` (root), `/search?q=…` (5), single-segment user/org
// profiles (/zyingfei, /statewright, 17 obs), `/sessions/…` auth (3),
// `/login`, `/orgs`.
const githubProfile: AggregatorProfile = {
  registrableDomain: 'github.com',
  // An item is `/owner/repo…`: a first segment that is a user/org (NOT a
  // reserved route) followed by a non-empty repo segment. Single-segment paths
  // (user/org profiles), `/search`, auth, and root are feeds. Keys on the
  // STRUCTURAL POSITION of owner+repo, not on any charset — same choice as the
  // HN `item?id=` and reddit `/comments/<id>` predicates.
  isItemUrl: (parsed) => codeForgeIsItemUrl(parsed, GITHUB_RESERVED_ROUTES),
  siteTitleSuffixes: [' · GitHub', ' - GitHub'],
  // A repo IS the sub-community grouping key — mirrors candidates.ts's
  // `repo:github.com/owner/repo` (the ad-hoc key that survived the migration).
  communityKey: (hostname, segments) => codeForgeCommunityKey(hostname, segments, GITHUB_RESERVED_ROUTES),
};

// GitLab is the same code-forge shape as GitHub (`/owner/repo…`, every sub-page
// under it) with its own reserved-route set. candidates.ts / features.ts already
// treat gitlab.com as a repo host; the profile makes it a hub-gated aggregator
// too (kept in sync with COARSE_MULTI_TOPIC_DOMAIN_PRIOR).
const GITLAB_RESERVED_ROUTES: ReadonlySet<string> = new Set<string>([
  'search',
  'users',
  'dashboard',
  'explore',
  'help',
  'admin',
  'groups',
  'projects',
  'sign_in',
  'sign_up',
  'oauth',
  '-',
]);

const gitlabProfile: AggregatorProfile = {
  registrableDomain: 'gitlab.com',
  isItemUrl: (parsed) => codeForgeIsItemUrl(parsed, GITLAB_RESERVED_ROUTES),
  siteTitleSuffixes: [' · GitLab', ' - GitLab'],
  communityKey: (hostname, segments) => codeForgeCommunityKey(hostname, segments, GITLAB_RESERVED_ROUTES),
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

// Chat-provider profiles. A chat provider is an aggregator in the same sense HN
// is: the domain hosts one FEED surface (the new-chat composer, login, history
// index, marketing) plus many distinct ITEM pages — one per conversation thread,
// each a stable content object keyed by its thread id in the URL. Filing thread
// pages as FEED quarantined them exactly like a listing (user-reported via the
// "Phantom与Shadow v2架构" thread), which is wrong: a thread IS the content
// object we want to group by. So thread URLs are `item`; every other shape on
// the domain stays `feed`.
//
// URL shapes below are DERIVED FROM THE LIVE TEST VAULT (doctrine rule 1 —
// evidence, not assumption), read read-only from
// ~/.sidetrack-vault-test/_BAC/connections/current.db node ids on 2026-07-24:
//
//   chatgpt.com  threads: /c/<id>                     (360 obs; id = uuid or
//                          /g/<gpt>/c/<id>            (61 obs; project/custom-GPT
//                          /branch/<id>/<id>          (3 obs; thread-branch view)
//                                                     `WEB:<uuid>` also seen as id)
//                feeds:   /  /library  /g/<gpt>  /g/<gpt>/project  /business/*
//                          /checkout  /share/*  /new
//   claude.ai    threads: /chat/<id>                  (21 obs)
//                feeds:   /  /new  /login  /logout  /recents
//   gemini.google.com
//                threads: /app/<id>                   (129 obs; id = 16-hex)
//                feeds:   /app (no id, 69 obs)  /  /search  /images
//
// The item predicate keys on the STRUCTURAL POSITION of a non-empty thread-id
// segment, not on the id's character shape — the same choice as the HN
// `item?id=` and reddit `/comments/<id>` predicates. Three distinct id formats
// (uuid, `WEB:<uuid>`, 16-hex) already coexist in the vault, so a charset regex
// would be over-fit and brittle to the next provider id format.

// `chat.openai.com` (legacy ChatGPT) and `chatgpt.com` share the /c/<id> shape.
// The `openai.com` profile covers both (registrable-domain suffix match) while a
// bare `openai.com/*` marketing page has no /c/ or /branch/ segment → feed.
const isChatgptThreadUrl = (parsed: URL): boolean => {
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) return false;
  // /c/<id> and /g/<gpt>/c/<id>: a `c` segment followed by a non-empty id.
  const cIndex = segments.indexOf('c');
  if (cIndex !== -1 && segments[cIndex + 1] !== undefined) return true;
  // /branch/<threadId>/<messageId>: the branch view of an existing thread.
  if (segments[0] === 'branch' && segments[1] !== undefined) return true;
  return false;
};

const chatgptDotComProfile: AggregatorProfile = {
  registrableDomain: 'chatgpt.com',
  isItemUrl: isChatgptThreadUrl,
  siteTitleSuffixes: [],
};

const openaiProfile: AggregatorProfile = {
  registrableDomain: 'openai.com',
  // Only the `chat.` subdomain carries thread shapes; the predicate returns
  // false for every marketing/root openai.com path, so those stay feed.
  isItemUrl: isChatgptThreadUrl,
  siteTitleSuffixes: [],
};

const claudeAiProfile: AggregatorProfile = {
  registrableDomain: 'claude.ai',
  // A Claude conversation is /chat/<id>. /new, /login, /recents, root → feed.
  isItemUrl: (parsed) => {
    const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
    return segments[0] === 'chat' && segments[1] !== undefined;
  },
  siteTitleSuffixes: [],
};

const geminiProfile: AggregatorProfile = {
  registrableDomain: 'google.com',
  // A Gemini conversation is gemini.google.com/app/<id>. Bare /app (no id),
  // root, /search, /images → feed. Scoped to the gemini subdomain so no other
  // google.com surface (search, docs, drive) is ever treated as an item.
  isItemUrl: (parsed) => {
    if (normalizeHost(parsed.hostname) !== 'gemini.google.com') return false;
    const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
    return segments[0] === 'app' && segments[1] !== undefined;
  },
  siteTitleSuffixes: [],
};

// Domains with no per-page item shape (pure feeds / search surfaces). Every page
// is a FEED — the domain-wide guard applies wholesale, which is correct for
// these (a search results page is never a stable content object we want to group
// by URL). Listed WITHOUT an item classifier so isItemUrl is always false.
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
  'bing.com',
  'duckduckgo.com',
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
  githubProfile,
  gitlabProfile,
  redditProfile,
  youtubeProfile,
  mediumProfile,
  chatgptDotComProfile,
  openaiProfile,
  claudeAiProfile,
  geminiProfile,
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

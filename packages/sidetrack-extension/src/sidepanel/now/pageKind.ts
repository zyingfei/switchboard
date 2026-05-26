// Now-tab page classifier.
//
// Given the currently-focused URL + tab-session record + the user's
// workstream attribution data, classify the page into one of four
// kinds the Now card surfaces with different chrome:
//
//   - 'chat' — a conversation surface (chatgpt/claude/gemini/etc.).
//     The card emphasises the thread, recent captures, and a link
//     to Threads.
//   - 'workstream' — the URL has a workstream attribution. The card
//     leads with the workstream context + related threads/pages.
//   - 'page' — a regular web page that we can index / recall against.
//     Déjà-vu + Focus results render inline.
//   - 'unknown' — chrome://, about:blank, file://, ephemeral
//     surfaces. The card stays lightweight: just the title + URL
//     + capture/index actions when eligible.
//
// The classifier is pure — pass in everything it needs as args so
// tests stay simple and App.tsx can call it without a hook.

export type PageKind = 'chat' | 'workstream' | 'page' | 'unknown';

// Provider hosts we recognise as chat surfaces. Same set the
// content-script provider sniffer uses; kept local here to avoid a
// circular import from entrypoints/content.ts.
const CHAT_HOSTS: readonly RegExp[] = [
  /^chatgpt\.com$/i,
  /(^|\.)claude\.ai$/i,
  /(^|\.)gemini\.google\.com$/i,
  /(^|\.)aistudio\.google\.com$/i,
  /^chat\.openai\.com$/i,
  /^perplexity\.ai$/i,
  /^(www\.)?phind\.com$/i,
  /^you\.com$/i,
];

// "Unknown" — anything where we can't usefully recall against the
// page (no title, no URL, or the URL is a non-http scheme).
const UNKNOWN_SCHEME_PREFIXES: readonly string[] = [
  'chrome://',
  'chrome-extension://',
  'about:',
  'file://',
  'devtools://',
  'edge://',
  'view-source:',
];

const hostOf = (url: string | undefined | null): string | undefined => {
  if (typeof url !== 'string' || url.length === 0) return undefined;
  try {
    const host = new URL(url).host;
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
};

const isUnknownScheme = (url: string | undefined): boolean => {
  if (typeof url !== 'string' || url.length === 0) return true;
  return UNKNOWN_SCHEME_PREFIXES.some((p) => url.startsWith(p));
};

const isChatHost = (url: string | undefined): boolean => {
  const host = hostOf(url);
  if (host === undefined) return false;
  return CHAT_HOSTS.some((re) => re.test(host));
};

// Input shape — only the fields the classifier needs. Matches the
// existing focusedTabSession + state.threads + workstream-attribution
// shape in App.tsx so the call site is essentially `classifyPageKind({
// url, tabSession, attributedWorkstreamId })`.
export interface PageKindInput {
  /** The currently-focused tab URL. `undefined` → unknown. */
  readonly url: string | undefined;
  /** Whether the URL is mapped to a known thread (any provider). */
  readonly isKnownThread?: boolean;
  /** Resolved workstream id when the URL has an attribution.
   *  `null` / `undefined` → no workstream context. */
  readonly attributedWorkstreamId?: string | null;
}

export const classifyPageKind = (input: PageKindInput): PageKind => {
  if (input.url === undefined || isUnknownScheme(input.url)) return 'unknown';
  if (isChatHost(input.url) || input.isKnownThread === true) return 'chat';
  if (
    typeof input.attributedWorkstreamId === 'string' &&
    input.attributedWorkstreamId.length > 0
  ) {
    return 'workstream';
  }
  return 'page';
};

// Human label for the eyebrow row. Keep short — fits inline next to
// the page title. Spec says these aren't part of the formal display
// language; they're page-kind affordances.
export const pageKindLabel: Readonly<Record<PageKind, string>> = {
  chat: 'Chat',
  workstream: 'Workstream',
  page: 'Page',
  unknown: 'Unknown',
};

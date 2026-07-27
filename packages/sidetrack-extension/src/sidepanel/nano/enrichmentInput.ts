// What the on-device gist is generated FROM — the input chain, and the honest
// label that goes with each link of it.
//
// THE BUG THIS FIXES (user report, 2026-07-27): "for a visited page, I already
// have 'features only' extraction, why can't AI generation use a similar input
// approach instead of asking me to index first?"
//
// The old chain was two links: the companion's stored full text, else a LIVE
// browser extract (which needs deeper page access). A page whose evidence tier
// is `content_features_only` — extraction ALREADY ran, the companion kept the
// features and dropped the raw text — fell through both and told the user to
// "index this page first". The page had been through extraction. Asking the
// user to redo it is the product forgetting what it already knows.
//
// The chain is now, in order, and it never asks the user to act before it has
// exhausted what already exists:
//
//   1. `indexed` — GET /v1/page-content/text. The full extracted text the
//      companion stored at index time. Best input; no label needed.
//   2. `features` — GET /v1/page-evidence/summary says the page has extracted
//      features on file. NOTE WHAT THAT PAYLOAD ACTUALLY CARRIES: tier +
//      termCount/keyphraseCount/entityCount + quality — the COUNTS, not the
//      feature strings themselves (see pageEvidenceSummaryPayload in the
//      companion's http/server.ts). So the brief we build from it is the
//      textual evidence the panel genuinely holds — title, host, URL keywords —
//      plus a factual statement of what was extracted. Thinner input, and the
//      result is LABELLED thin (FEATURES_SOURCE_NOTE) so nobody mistakes it for
//      a read of the page.
//   3. `live` — the browser extract, unchanged. Last, not first.
//   4. `none` — only here does the UI ask the user to index, with the action
//      offered inline.
//
// Pure: no fetch, no chrome.*, no React. The transport is injected, which is
// also how the ordering ("the live extract is NOT attempted when indexed text
// or features suffice") is asserted in tests.

/** Which link of the chain produced the text handed to the model. */
export type EnrichmentInputSource = 'indexed' | 'features' | 'live' | 'none';

/** The fetcher's answer: the text, plus which link produced it. */
export interface EnrichmentText {
  readonly text: string | null;
  readonly source: EnrichmentInputSource;
}

/**
 * The subset of GET /v1/page-evidence/summary's `pageEvidence` this module
 * reads. Field names are the wire's own (see pageEvidenceSummaryPayload):
 * `tier` is the evidence tier, and the three *Count fields are counts — the
 * feature TEXT is not on this wire, which is exactly why the brief below is
 * built from title/host/URL rather than from keyphrase strings.
 */
export interface PageEvidenceFeatureSummary {
  readonly tier?: string;
  readonly termCount?: number;
  readonly keyphraseCount?: number;
  readonly entityCount?: number;
  readonly quality?: string;
}

/** Evidence tiers that mean "extraction ran and produced content features". */
const FEATURE_TIERS: ReadonlySet<string> = new Set(['content_features_only', 'indexed_chunks']);

/** Total extracted features on file — the "is there anything here" number. */
export const featureCountOf = (summary: PageEvidenceFeatureSummary): number =>
  (summary.termCount ?? 0) + (summary.keyphraseCount ?? 0) + (summary.entityCount ?? 0);

/**
 * True when the companion already extracted this page into features. This is
 * the "features only" detection: tier is a CONTENT tier and at least one
 * term/keyphrase/entity was stored. `metadata_only` (title + URL, nothing
 * extracted) is deliberately NOT enough — there is no extraction to reuse.
 */
export const hasExtractedFeatures = (summary: PageEvidenceFeatureSummary | null): boolean =>
  summary !== null && FEATURE_TIERS.has(summary.tier ?? '') && featureCountOf(summary) > 0;

/** The host, or '' when the URL will not parse. */
export const hostOf = (canonicalUrl: string): string => {
  try {
    return new URL(canonicalUrl).hostname;
  } catch {
    return '';
  }
};

/**
 * The URL's own words: path + query segments split on non-letters, with the
 * structural noise (numeric ids, hashes, single letters, file extensions)
 * dropped. The same "URL keywords" idea the resolver's content lane uses when
 * it has no gist — reproduced here because it is textual evidence the panel
 * holds without asking anyone for anything.
 */
export const urlKeywordsOf = (canonicalUrl: string): string => {
  let path = '';
  try {
    const parsed = new URL(canonicalUrl);
    path = `${parsed.pathname} ${parsed.search}`;
  } catch {
    path = canonicalUrl;
  }
  const seen = new Set<string>();
  const words: string[] = [];
  for (const raw of path.split(/[^\p{L}\p{N}]+/u)) {
    const token = raw.toLowerCase();
    if (token.length < 3) continue;
    // Pure digits, hex-looking ids and long opaque slugs are identity, not
    // topic — they would only teach the model to repeat a hash.
    if (/^\p{N}+$/u.test(token)) continue;
    if (/^[0-9a-f]{8,}$/u.test(token)) continue;
    if (token.length > 24) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    words.push(token);
    if (words.length >= 12) break;
  }
  return words.join(' ');
};

/**
 * The features-only brief: everything textual the panel can state about a page
 * whose raw text was never stored. Returns null when even this is empty (no
 * title, unparseable URL) — the caller then falls through to the live extract.
 */
export const featureBriefFrom = (input: {
  readonly canonicalUrl: string;
  readonly title?: string | null;
  readonly summary: PageEvidenceFeatureSummary;
}): string | null => {
  const lines: string[] = [];
  const title = (input.title ?? '').trim();
  if (title.length > 0) lines.push(`Page title: ${title}`);
  const host = hostOf(input.canonicalUrl);
  if (host.length > 0) lines.push(`Site: ${host}`);
  const keywords = urlKeywordsOf(input.canonicalUrl);
  if (keywords.length > 0) lines.push(`Words in the page address: ${keywords}`);
  if (lines.length === 0) return null;
  // State the evidence, in the extractor's own counts. This is the honest
  // account of the input: the page WAS extracted, the raw text was not kept.
  lines.push(
    `Extracted page features on file: ${String(input.summary.termCount ?? 0)} terms, ` +
      `${String(input.summary.keyphraseCount ?? 0)} key phrases, ` +
      `${String(input.summary.entityCount ?? 0)} entities. The page's raw text was not stored.`,
  );
  return lines.join('\n');
};

/** The label a features-derived gist carries, everywhere it is shown. */
export const FEATURES_SOURCE_NOTE = 'gist from page features (no full text indexed)';

/** The origin note for a source, or null when the input needs no caveat. */
export const sourceNoteOf = (source: EnrichmentInputSource | null): string | null =>
  source === 'features' ? FEATURES_SOURCE_NOTE : null;

/**
 * Accept the legacy `string | null` fetcher contract alongside the typed one,
 * so a caller (or a test) that just returns text still works. A bare string is
 * treated as full text: no caveat is invented for a caller that didn't declare
 * one.
 */
export const normalizeEnrichmentText = (
  value: string | null | EnrichmentText,
): EnrichmentText => {
  if (value === null) return { text: null, source: 'none' };
  if (typeof value === 'string') {
    return value.trim().length === 0 ? { text: null, source: 'none' } : { text: value, source: 'indexed' };
  }
  const text = typeof value.text === 'string' && value.text.trim().length > 0 ? value.text : null;
  return { text, source: text === null ? 'none' : value.source };
};

/** Injected transport for the URL chain — one function per link. */
export interface UrlEnrichmentTextDeps {
  /** GET /v1/page-content/text — the already-indexed full text, or null. */
  readonly fetchIndexedText: (canonicalUrl: string) => Promise<string | null>;
  /** GET /v1/page-evidence/summary — the evidence record, or null when absent. */
  readonly fetchEvidenceSummary: (
    canonicalUrl: string,
  ) => Promise<PageEvidenceFeatureSummary | null>;
  /** The LIVE browser extract. Called ONLY when the two links above came up empty. */
  readonly extractLiveText: () => Promise<string | null>;
  /** The focused page's title, when the host knows it. */
  readonly titleFor?: (canonicalUrl: string) => string | null;
}

/**
 * Run the chain for a URL target. Every link swallows its own failure (a 404
 * from the not-indexed route is the NORMAL case, not an error) and moves on.
 */
export const resolveUrlEnrichmentText = async (
  canonicalUrl: string,
  deps: UrlEnrichmentTextDeps,
): Promise<EnrichmentText> => {
  // 1. The text the companion already stored.
  const indexed = await deps.fetchIndexedText(canonicalUrl).catch(() => null);
  if (typeof indexed === 'string' && indexed.trim().length > 0) {
    return { text: indexed, source: 'indexed' };
  }
  // 2. The extraction that already happened, in the form the panel can read.
  const summary = await deps.fetchEvidenceSummary(canonicalUrl).catch(() => null);
  if (hasExtractedFeatures(summary) && summary !== null) {
    const brief = featureBriefFrom({
      canonicalUrl,
      title: deps.titleFor?.(canonicalUrl) ?? null,
      summary,
    });
    if (brief !== null) return { text: brief, source: 'features' };
  }
  // 3. Only now do we go back to the page itself.
  const live = await deps.extractLiveText().catch(() => null);
  if (typeof live === 'string' && live.trim().length > 0) return { text: live, source: 'live' };
  // 4. Nothing exists — the UI asks to index, with the action inline.
  return { text: null, source: 'none' };
};

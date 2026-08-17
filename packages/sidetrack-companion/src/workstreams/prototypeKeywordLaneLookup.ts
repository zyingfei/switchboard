// Request-time keyword-concept lookup cache for the prototype lane's
// serve-time keyword-profile blend (docs/plans/2026-08-16-category-
// flexibility-hyde.md §11). Mirrors recall-v2/pipeline.ts's
// peekRecallV2Store/warmRecallV2Store pattern EXACTLY: a module-level cache
// keyed by vaultRoot, warmed fire-and-forget, peeked WITHOUT ever opening a
// fresh handle on the request path. A cold-start resolve (before the layer
// has been warmed) degrades to "keyword layer not ready yet" — the caller
// gets `undefined` and the prototype lane's keyword blend falls back to
// pure vector scoring, same typed-emptiness contract every other lane in
// this codebase uses — and the NEXT resolve finds the warm handle.
//
// WHY A SEPARATE CACHE FROM prototypeGeneration.ts's OWN keyword-store
// opens. That module opens short-lived handles once per background tick
// (hours apart) and closes them immediately after — a persistent
// request-path cache would be the wrong lifetime for that caller. This
// cache is the opposite: opened once, kept warm for the process lifetime,
// read on every resolve — the same reasoning recall-v2's own store cache
// already applies to `docs_vec`.

import type { KeywordIndexStore } from '../search-index/keywordIndexStore.js';
import type { KeywordConceptStore } from '../enrichment/keywordConceptStore.js';
import { pageKeyForUrl } from './prototypeKeywordProfileBuild.js';

interface KeywordLayerHandles {
  readonly indexStore: KeywordIndexStore;
  readonly conceptStore: KeywordConceptStore;
}

const cache = new Map<string, Promise<KeywordLayerHandles>>();

const openHandles = async (vaultRoot: string): Promise<KeywordLayerHandles> => {
  const { createKeywordIndexStore } = await import('../search-index/keywordIndexStore.js');
  const { createKeywordConceptStore } = await import('../enrichment/keywordConceptStore.js');
  const [indexStore, conceptStore] = await Promise.all([
    createKeywordIndexStore(vaultRoot),
    createKeywordConceptStore(vaultRoot),
  ]);
  return { indexStore, conceptStore };
};

/**
 * Open the keyword layer into the shared cache WITHOUT blocking the caller
 * — fire-and-forget, the exact same contract as warmRecallV2Store (opening
 * two small SQLite files is milliseconds; this just keeps that off the
 * critical path of the resolve that happened to trigger it). Never throws;
 * a failed open leaves the cache empty so a later resolve can retry rather
 * than caching the failure forever.
 */
export const warmPrototypeKeywordLayer = (vaultRoot: string): void => {
  if (cache.has(vaultRoot)) return;
  const opening = openHandles(vaultRoot);
  cache.set(vaultRoot, opening);
  void opening.catch(() => {
    cache.delete(vaultRoot);
  });
};

/** Non-blocking peek — undefined when the layer has not been warmed yet.
 *  Never opens a fresh handle itself (mirrors peekRecallV2Store exactly). */
const peekHandles = async (vaultRoot: string): Promise<KeywordLayerHandles | undefined> => {
  const cached = cache.get(vaultRoot);
  if (cached === undefined) return undefined;
  try {
    return await cached;
  } catch {
    return undefined;
  }
};

/**
 * This page's own resolved concept ids — joins
 * `keywordIndexStore.keywordsForPage(pageKeyForUrl(canonicalUrl))` against
 * `keywordConceptStore.conceptForKeyword` per keyword, deduped. Returns
 * `undefined` (never `[]` for "not ready") when the keyword layer is not
 * warm yet OR the page has never been indexed by it — either way the
 * prototype lane's keyword blend degrades to pure vector scoring, the
 * standing "vectors only" fallback contract this feature area uses
 * throughout (see prototypeKeywordProfile.ts's blendVectorAndKeywordScore).
 * `[]` is still possible and means something different: the page WAS
 * indexed but genuinely has no keywords, or none of its keywords have a
 * concept assignment yet.
 */
export const peekPrototypeKeywordConceptIds = async (
  vaultRoot: string,
  canonicalUrl: string,
): Promise<readonly string[] | undefined> => {
  const handles = await peekHandles(vaultRoot);
  if (handles === undefined) return undefined;
  const keywords = handles.indexStore.keywordsForPage(pageKeyForUrl(canonicalUrl));
  if (keywords === undefined) return undefined;
  const conceptIds = new Set<string>();
  for (const keyword of keywords) {
    const conceptId = handles.conceptStore.conceptForKeyword(keyword);
    if (conceptId !== undefined) conceptIds.add(conceptId);
  }
  return [...conceptIds];
};

export const resetPrototypeKeywordLaneLookupForTest = (): void => {
  cache.clear();
};

// New-label hint — additive wire signal for the batch-resolve response
// (companion side only; the panel affordance that RENDERS this hint is a
// separate, already-in-flight change on another branch, building against
// this contract).
//
// WHAT. When a page reaches the "genuinely no confident pick anywhere"
// state (see below) AND its gist carries >=2 keywords (enrichment/
// keywordIngest.ts / enrichment/keywordBackfillLane.ts), attach a bounded
// {name, keywords} hint the panel can use to offer "start a new category"
// instead of leaving the user with nothing. NO clustering, NO LLM call, NO
// new store — this is a pure per-PAGE read over the SAME keyword-index
// (search-index/keywordIndexStore.ts) the suggestion engine already
// consumes (workstreams/splitSuggestionEngine.ts's keywordNameFor uses the
// identical "top-N keywords joined" naming idea, one cluster's shared terms
// there vs. one page's own terms here).
//
// "GENUINELY NO CONFIDENT PICK" — reused, not reinvented. This is the EXACT
// same two-part condition tabsession/laneFallback.ts's
// applyLaneFallbackGuess already established as "abstain, structurally":
// `fusedCandidates.length === 0 && decision.gate?.reason === 'no-candidates'`.
// Checked by the CALLER (http/server.ts's finalizeBatchResolveResults)
// AFTER applyLaneDecisions has already run — so a page the lane-fallback
// guess successfully rescued is correctly NOT hinted (it found something),
// and a page the user explicitly DECLINED ("not in any stream" — see
// declineMemory.ts's header on why `gate.reason === 'no-candidates'` fires
// for that case TOO) is excluded by the caller's own isUrlDeclined check
// before this module is even reached — the same guard
// applyLaneFallbackGuess/applyLaneCorroboration both apply, for the exact
// same reason: re-suggesting (or here, prompting to create) a category on a
// page the user just refused one for would read the decline as an
// invitation.
//
// LAZY PER-VAULT SINGLETON, same idiom enrichment/keywordIngest.ts and
// http/routes/workstreamSuggestionsRoutes.ts both already established for
// this exact store — this route is a THIRD, independent production caller
// (no shared handle across modules), consistent with that precedent.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createKeywordIndexStore, type KeywordIndexStore } from '../search-index/keywordIndexStore.js';

// ---- flag -----------------------------------------------------------------

export const NEW_LABEL_HINT_ENV = 'SIDETRACK_NEW_LABEL_HINT';

/** Default ON — read-only/derivation-adjacent feature over data already
 *  written (the keyword index), same house rule keywordIngestEnabled()
 *  states for itself. '0'/'false' disables: no store handle is even opened,
 *  zero cost. */
export const newLabelHintEnabled = (): boolean => {
  const raw = process.env[NEW_LABEL_HINT_ENV];
  return raw !== '0' && raw !== 'false';
};

// ---- pure hint synthesis ---------------------------------------------------

export interface NewLabelHint {
  readonly name: string;
  readonly keywords: readonly string[];
}

// A single keyword is not a distinguishing label — "javascript" alone tells
// a user nothing a bare title didn't already. Two-plus keywords is the
// floor at which the hint carries more signal than noise.
export const NEW_LABEL_HINT_MIN_KEYWORDS = 2;
// Same TOP_TERM_COUNT convention splitSuggestionEngine.ts's
// keywordNameFor/structuralNameFor use for cluster naming.
const HINT_NAME_TERM_COUNT = 3;

/**
 * Pure — synthesize a hint from a page's own keyword list, or null when
 * there are too few to be a distinguishing label. `keywords` is expected in
 * keywordIndexStore.ts's own order (most-frequent-first, per
 * keywordExtract.ts's ranking); the hint's `name` takes the top
 * HINT_NAME_TERM_COUNT verbatim rather than re-ranking, so the same
 * ordering already proven for cluster naming carries through unchanged.
 */
export const computeNewLabelHint = (
  keywords: readonly string[] | undefined,
): NewLabelHint | null => {
  if (keywords === undefined || keywords.length < NEW_LABEL_HINT_MIN_KEYWORDS) return null;
  return { name: keywords.slice(0, HINT_NAME_TERM_COUNT).join(' '), keywords };
};

// ---- lazy per-vault singleton handle ---------------------------------------

const handlesByVault = new Map<string, Promise<KeywordIndexStore>>();
const unavailableVaults = new Set<string>();

const ensureHandle = async (vaultRoot: string): Promise<KeywordIndexStore | null> => {
  if (unavailableVaults.has(vaultRoot)) return null;
  let pending = handlesByVault.get(vaultRoot);
  if (pending === undefined) {
    // Self-sufficient — do NOT assume some OTHER already-open store
    // (connectionsStore, etc.) created _BAC/connections first. bun:sqlite's
    // `new Database(path, {create:true})` only creates the missing FILE,
    // never a missing PARENT directory (same gap fixed for
    // scheduleKeywordBackfillLoop's handle-opening — see that module's
    // header). Harmless in production (boot always creates this directory
    // long before the HTTP listener starts accepting requests), but a
    // batch-resolve request against a freshly-created test vault can
    // legitimately race it.
    pending = mkdir(join(vaultRoot, '_BAC', 'connections'), { recursive: true }).then(() =>
      createKeywordIndexStore(vaultRoot),
    );
    handlesByVault.set(vaultRoot, pending);
  }
  try {
    return await pending;
  } catch {
    handlesByVault.delete(vaultRoot);
    unavailableVaults.add(vaultRoot);
    return null;
  }
};

/**
 * Bounded, best-effort per-page keyword lookup + hint synthesis for the
 * batch-resolve response. NEVER throws — a keyword-store hiccup must not
 * fail the resolve it rides along with, same posture as
 * keywordIngest.ts's ingestGistKeywords. Returns null when the flag is off,
 * the store handle is unavailable, or the page has never been keyword-
 * indexed (or was indexed with < NEW_LABEL_HINT_MIN_KEYWORDS results).
 *
 * O(1) — one indexed SQLite read (keywordIndexStore.ts's `keyword_page`
 * table is PRIMARY KEY'd on page_key), never a scan. Called once per URL
 * that reaches the no-confident-pick state in one batch-resolve request —
 * bounded by that request's own URL count, same as every other per-URL lane
 * lookup in finalizeBatchResolveResults.
 */
export const newLabelHintForPage = async (
  vaultRoot: string,
  canonicalUrl: string,
  options?: {
    /** §12 refinement (docs/plans/2026-08-16-category-flexibility-hyde.md
     *  §12, "the attention of sentence matters"). The prototype lane
     *  (guess lane 9, tabsession/prototypeLane.ts) is now sentence-aware
     *  and structurally CANNOT influence the fusion decision that put this
     *  page into the "genuinely no confident pick" state (laneCorroboration
     *  .ts/laneFallback.ts hardcode their lane set to ['content','ai'] —
     *  see prototypeLane.ts's own header) — so a confident prototype-lane
     *  candidate on this SAME page is real, independent evidence that an
     *  existing workstream is actually a decent fit, evidence the pooled/
     *  structural lanes that decided "no candidates" never had access to.
     *  When true, suppress the "start a new category" nudge: re-prompting
     *  to CREATE a new category on a page that a sentence-aware match
     *  already resembles an EXISTING one would be actively misleading, not
     *  merely unhelpful. Optional/undefined behaves exactly as before this
     *  phase (never suppressed on this basis) — the caller (server.ts)
     *  computes this from the SAME per-URL result the prototype lane just
     *  wrote, no second lookup. */
    readonly prototypeLaneHasConfidentMatch?: boolean;
  },
): Promise<NewLabelHint | null> => {
  if (!newLabelHintEnabled()) return null;
  if (options?.prototypeLaneHasConfidentMatch === true) return null;
  const handle = await ensureHandle(vaultRoot);
  if (handle === null) return null;
  try {
    const keywords = handle.keywordsForPage(`url:${canonicalUrl}`);
    return computeNewLabelHint(keywords);
  } catch {
    return null;
  }
};

export const resetNewLabelHintHandlesForTest = (): void => {
  handlesByVault.clear();
  unavailableVaults.clear();
};

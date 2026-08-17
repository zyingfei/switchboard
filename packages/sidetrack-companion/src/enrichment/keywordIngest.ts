// Keyword ingest — orchestration glue between the gist-enrichment write path
// and the keyword layer's two maintained stores (search-index/
// keywordIndexStore.ts, keywordConceptStore.ts).
//
// KEPT OUT OF contentEnrichment.ts ON PURPOSE. That module's own header is
// explicit about being a PURE fold with no side effects; this module is the
// opposite (owns two SQLite handles, calls the embedder), so it stays a
// separate, explicitly-optional hook the ROUTE layer calls — not something
// every existing caller of contentEnrichment.ts silently inherits.
//
// LIVE INGEST = the O(1)-per-event path. http/routes/enrichmentRoutes.ts
// calls `ingestGistKeywords` once per freshly-ACCEPTED gist, handing it the
// gist text it already has in hand — no re-read of the fold, no scan.
//
// RETRACTION = re-sync, not re-derive. `resyncGistKeywordsAfterRetraction`
// deliberately does NOT reimplement contentEnrichment.ts's hash/timestamp
// retraction semantics; it re-reads the (already-correct) gist fold to see
// what CURRENTLY stands for the (kind,id) key and reconciles the keyword
// index against that single source of truth.
//
// NOT WIRED INTO connectionsMaterializer.ts (off-limits). Both entry points
// below are called directly from the route layer.

import type { EventLog } from '../sync/eventLog.js';
import { loadGistLookup, lookupGist } from './contentEnrichment.js';
import type { EntityTitleEnrichedKind } from './events.js';
import { extractKeywords } from './keywordExtract.js';
import {
  createKeywordConceptStore,
  type KeywordConceptStore,
} from './keywordConceptStore.js';
import {
  createKeywordIndexStore,
  type KeywordIndexStore,
} from '../search-index/keywordIndexStore.js';

// ---- flag ---------------------------------------------------------------

export const KEYWORD_INGEST_ENV = 'SIDETRACK_KEYWORD_INGEST';

/** Default ON — read-only/derivation-adjacent feature over data already
 *  written (the gist itself), same house rule entityIndex.ts states for
 *  itself. '0'/'false' disables: no store is even opened, zero cost. */
export const keywordIngestEnabled = (): boolean => {
  const raw = process.env[KEYWORD_INGEST_ENV];
  return raw !== '0' && raw !== 'false';
};

// ---- lazy per-vault singleton handles -------------------------------------

interface Handles {
  readonly index: KeywordIndexStore;
  readonly concepts: KeywordConceptStore;
}

const handlesByVault = new Map<string, Promise<Handles>>();
const unavailableVaults = new Set<string>();

const ensureHandles = async (vaultRoot: string): Promise<Handles | null> => {
  if (unavailableVaults.has(vaultRoot)) return null;
  let pending = handlesByVault.get(vaultRoot);
  if (pending === undefined) {
    pending = (async (): Promise<Handles> => {
      const [index, concepts] = await Promise.all([
        createKeywordIndexStore(vaultRoot),
        createKeywordConceptStore(vaultRoot),
      ]);
      return { index, concepts };
    })();
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

const foldKey = (kind: EntityTitleEnrichedKind, id: string): string => `${kind}:${id}`;

// ---- live ingest ----------------------------------------------------------

export interface KeywordIngestResult {
  readonly ingested: boolean;
  readonly keywords: readonly string[];
  readonly newConcepts: number;
}

const EMPTY_RESULT: KeywordIngestResult = { ingested: false, keywords: [], newConcepts: 0 };

/**
 * Extract + index + concept-assign keywords for ONE freshly-accepted gist.
 * NEVER throws — a failure here must not fail the enrichment write it rides
 * along with (the gist itself is already durably persisted by the time this
 * runs; a keyword-layer hiccup is a missed feature, not a data-loss risk).
 */
export const ingestGistKeywords = async (
  vaultRoot: string,
  kind: EntityTitleEnrichedKind,
  id: string,
  gist: string,
  now: number = Date.now(),
): Promise<KeywordIngestResult> => {
  if (!keywordIngestEnabled()) return EMPTY_RESULT;
  const handles = await ensureHandles(vaultRoot);
  if (handles === null) return EMPTY_RESULT;
  try {
    const extracted = extractKeywords(gist);
    const pageKey = foldKey(kind, id);
    handles.index.upsertPageKeywords(pageKey, extracted.keywords, extracted.source, now);

    const unassigned = extracted.keywords.filter((keyword) => !handles.concepts.hasKeyword(keyword));
    let newConcepts = 0;
    if (unassigned.length > 0) {
      let vectors: readonly Float32Array[] = [];
      try {
        // LAZY, dynamic import — never a static top-level one. This module
        // is reachable from http/routes/enrichmentRoutes.ts, which is part
        // of the SAME compiled server.js module graph /v1/status's handler
        // lives in; a static `import { embed } from '../recall/embedder.js'`
        // here would make onnxruntime-node load eagerly the moment the
        // server module is imported at all — the exact regression
        // statusContract.test.ts exists to catch. Same lazy-import idiom
        // already used at every other embed() call site in this codebase
        // (cli.ts, runtime/companion.ts, page-evidence/embedding.ts,
        // recall-v2/store/backfill.ts, workstreams/prototypeGeneration.ts).
        const { embed } = await import('../recall/embedder.js');
        vectors = await embed(unassigned);
      } catch {
        vectors = [];
      }
      unassigned.forEach((keyword, index) => {
        const vector = vectors[index];
        if (vector === undefined) return; // embedder cold/short batch — skip, never invent
        const outcome = handles.concepts.assignKeyword(keyword, vector, now);
        if (outcome.created) newConcepts += 1;
      });
    }
    return { ingested: true, keywords: extracted.keywords, newConcepts };
  } catch {
    return EMPTY_RESULT;
  }
};

// ---- retraction re-sync ----------------------------------------------------

/**
 * After an accepted content-family retraction, reconcile the keyword index
 * against whatever gist CURRENTLY stands for (kind,id) — delegates to the
 * gist fold's own (already-correct) retraction semantics rather than
 * re-deriving hash/timestamp scoping here.
 */
export const resyncGistKeywordsAfterRetraction = async (
  vaultRoot: string,
  eventLog: EventLog,
  kind: EntityTitleEnrichedKind,
  id: string,
  now: number = Date.now(),
): Promise<void> => {
  if (!keywordIngestEnabled()) return;
  const handles = await ensureHandles(vaultRoot);
  if (handles === null) return;
  try {
    const lookup = await loadGistLookup(vaultRoot, eventLog);
    const standing = lookupGist(lookup, kind, id);
    if (standing === undefined) {
      handles.index.removePage(foldKey(kind, id));
      return;
    }
    await ingestGistKeywords(vaultRoot, kind, id, standing, now);
  } catch {
    // Best-effort. A stale keyword-index entry after a retraction is a
    // bounded, self-correcting staleness window (the next successful gist
    // write for this key fixes it), never a crash of the retraction route.
  }
};

export const resetKeywordIngestHandlesForTest = (): void => {
  handlesByVault.clear();
  unavailableVaults.clear();
};

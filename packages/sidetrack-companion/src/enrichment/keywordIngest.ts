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
  isConceptDistributionDegenerate,
  isDegenerateEmbedding,
  isIdenticalVectorBatch,
} from './keywordConcepts.js';
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

// ---- audible degenerate-concept guard (2026-08-17 incident addendum) -----
//
// A degenerate embedding/collapse is a RARE, PATHOLOGICAL condition (a
// healthy embedder + threshold should essentially never trip these), but
// once it starts it can trip on EVERY gist ingest — so the log line is
// throttled per-vault the same shape as recall/embeddingCache.ts's flush
// log (lastLoggedAtMs + a minimum interval), not a boolean "logged once
// ever" latch, so a condition that clears and later recurs is still
// audible rather than permanently silenced by an early trip.
const degenerateLogState = new Map<string, number>();
const DEGENERATE_LOG_INTERVAL_MS = 60_000;

const logDegenerateThrottled = (
  vaultRoot: string,
  log: (message: string) => void,
  message: string,
): void => {
  const nowMs = Date.now();
  const last = degenerateLogState.get(vaultRoot) ?? 0;
  if (nowMs - last < DEGENERATE_LOG_INTERVAL_MS) return;
  degenerateLogState.set(vaultRoot, nowMs);
  log(message);
};

/** Default audible sink when a caller doesn't supply its own `log` — writes
 *  to stderr so it lands in the companion's normal process output without
 *  requiring every call site (enrichmentRoutes.ts's live-ingest hook, this
 *  module's own retraction re-sync) to thread one through. */
const defaultAudibleLog = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

export const resetDegenerateLogThrottleForTest = (): void => {
  degenerateLogState.clear();
};

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
  log: (message: string) => void = defaultAudibleLog,
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

      // Degenerate-input guards (2026-08-17 incident — see
      // keywordConcepts.ts's header for the full postmortem). A degraded
      // embedder can return a vector per keyword WITHOUT throwing, so the
      // catch above alone does not protect against garbage input reaching
      // assignKeyword. Split the batch into usable vs. individually
      // degenerate BEFORE folding anything, then check the usable set for
      // the "embedder returned the same vector for everything" signature —
      // both cases are logged audibly (throttled) and SKIPPED rather than
      // silently merged into (or corrupting) a concept.
      const usable: { readonly keyword: string; readonly vector: Float32Array }[] = [];
      const degenerateKeywords: string[] = [];
      unassigned.forEach((keyword, index) => {
        const vector = vectors[index];
        if (vector === undefined) return; // embedder cold/short batch — skip, never invent
        if (isDegenerateEmbedding(vector)) {
          degenerateKeywords.push(keyword);
          return;
        }
        usable.push({ keyword, vector });
      });

      if (degenerateKeywords.length > 0) {
        logDegenerateThrottled(
          vaultRoot,
          log,
          `[keyword-concepts] degenerate (all-zero/non-finite) embedding for ${String(
            degenerateKeywords.length,
          )} keyword(s), skipped — not assigned: ${degenerateKeywords.slice(0, 5).join(', ')}${
            degenerateKeywords.length > 5 ? ', …' : ''
          }`,
        );
      }

      if (isIdenticalVectorBatch(usable.map((entry) => entry.vector))) {
        logDegenerateThrottled(
          vaultRoot,
          log,
          `[keyword-concepts] embedder returned IDENTICAL vectors for ${String(
            usable.length,
          )} distinct keywords — likely a degraded/fallback embedder; skipped, not assigned: ${usable
            .slice(0, 5)
            .map((entry) => entry.keyword)
            .join(', ')}${usable.length > 5 ? ', …' : ''}`,
        );
      } else {
        for (const { keyword, vector } of usable) {
          const outcome = handles.concepts.assignKeyword(keyword, vector, now);
          if (outcome.created) newConcepts += 1;
        }
        // Ongoing audible guard — the SAME predicate the keyword-backfill
        // scheduler's self-heal uses (keywordConcepts.ts's
        // isConceptDistributionDegenerate), checked here too so a collapse
        // starting DURING live ingest (not just one discovered at the next
        // companion restart) is caught immediately rather than waiting for
        // the backfill lane's next startup.
        const stats = handles.concepts.stats();
        if (isConceptDistributionDegenerate(stats.distinctKeywords, stats.distinctConcepts)) {
          logDegenerateThrottled(
            vaultRoot,
            log,
            `[keyword-concepts] concept distribution looks collapsed (distinctKeywords=${String(
              stats.distinctKeywords,
            )} distinctConcepts=${String(
              stats.distinctConcepts,
            )}) — threshold or embedder may be degenerate; self-heals on next keyword-backfill scheduler start`,
          );
        }
      }
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

// ---- one-time self-heal: degenerate concept-distribution repair ----------
//
// 2026-08-17 incident (see keywordConcepts.ts's header + docs/plans/
// 2026-08-16-category-flexibility-hyde.md §12 addendum for the full
// postmortem): concept_centroid/keyword_concept are DERIVED state —
// keyword-index.db's keyword_posting/keyword_page remain the single source
// of truth for "which keywords exist". A degenerate distribution (nearly
// every keyword resolved to ONE concept — isConceptDistributionDegenerate)
// is therefore always repairable by resetting the concept tables and
// reassigning from the existing vocabulary. Bounded — the vocabulary is
// small (this module's own header: dozens to low thousands of distinct
// terms), so a full re-embed pass here is the same cost class as a single
// backfill cycle's batch, not an O(corpus) operation.
//
// Called ONCE, at keyword-backfill scheduler startup
// (keywordBackfillLane.ts's scheduleKeywordBackfillLoop) — deliberately NOT
// on every cycle: a repair that resets concept ids mid-cycle would race the
// backfill lane's own in-flight assignments and could hand out a concept id
// that a concurrent assignKeyword call is about to mint too.
export interface ConceptRepairResult {
  /** False when the distribution was already healthy — nothing was reset
   *  or reassigned. */
  readonly repaired: boolean;
  readonly distinctKeywordsBefore: number;
  readonly distinctConceptsBefore: number;
  readonly distinctConceptsAfter: number;
  /** Present when a repair was attempted but could not complete (embedder
   *  unavailable, or the embedder itself returned a degenerate batch) — the
   *  concept tables are left RESET (empty) in this case; the next
   *  successful live-ingest or scheduler restart will repopulate them
   *  incrementally rather than leaving corrupt centroids in place. */
  readonly aborted?: string;
}

export const repairDegenerateKeywordConcepts = async (
  vaultRoot: string,
  keywordIndex: KeywordIndexStore,
  concepts: KeywordConceptStore,
  log: (message: string) => void = defaultAudibleLog,
  now: number = Date.now(),
): Promise<ConceptRepairResult> => {
  const before = concepts.stats();
  if (!isConceptDistributionDegenerate(before.distinctKeywords, before.distinctConcepts)) {
    return {
      repaired: false,
      distinctKeywordsBefore: before.distinctKeywords,
      distinctConceptsBefore: before.distinctConcepts,
      distinctConceptsAfter: before.distinctConcepts,
    };
  }

  log(
    `[keyword-concepts] degenerate concept distribution detected (distinctKeywords=${String(
      before.distinctKeywords,
    )} distinctConcepts=${String(before.distinctConcepts)}) — resetting and reassigning`,
  );
  const vocabulary = keywordIndex.distinctKeywords();
  concepts.reset();

  let vectors: readonly Float32Array[] = [];
  try {
    // Same lazy-import idiom as ingestGistKeywords — see that function's
    // comment for why this must never be a static top-level import.
    const { embed } = await import('../recall/embedder.js');
    vectors = await embed(vocabulary);
  } catch (error) {
    log(`[keyword-concepts] repair: embed() failed, aborting reassignment: ${String(error)}`);
    return {
      repaired: true,
      distinctKeywordsBefore: before.distinctKeywords,
      distinctConceptsBefore: before.distinctConcepts,
      distinctConceptsAfter: concepts.stats().distinctConcepts,
      aborted: 'embed-failed',
    };
  }

  const usable = vocabulary
    .map((keyword, index) => ({ keyword, vector: vectors[index] }))
    .filter(
      (entry): entry is { readonly keyword: string; readonly vector: Float32Array } =>
        entry.vector !== undefined && !isDegenerateEmbedding(entry.vector),
    );

  if (isIdenticalVectorBatch(usable.map((entry) => entry.vector))) {
    log(
      '[keyword-concepts] repair: embedder returned IDENTICAL vectors for the whole vocabulary — ' +
        'aborting reassignment (embedder is likely degraded); concept tables left empty, next ' +
        'successful ingest/backfill cycle will repopulate them incrementally',
    );
    return {
      repaired: true,
      distinctKeywordsBefore: before.distinctKeywords,
      distinctConceptsBefore: before.distinctConcepts,
      distinctConceptsAfter: concepts.stats().distinctConcepts,
      aborted: 'identical-vectors',
    };
  }

  let assigned = 0;
  for (const { keyword, vector } of usable) {
    concepts.assignKeyword(keyword, vector, now);
    assigned += 1;
  }
  const after = concepts.stats();
  log(
    `[keyword-concepts] repair complete: ${String(assigned)}/${String(
      vocabulary.length,
    )} keywords reassigned into ${String(after.distinctConcepts)} concepts`,
  );
  return {
    repaired: true,
    distinctKeywordsBefore: before.distinctKeywords,
    distinctConceptsBefore: before.distinctConcepts,
    distinctConceptsAfter: after.distinctConcepts,
  };
};

export const resetKeywordIngestHandlesForTest = (): void => {
  handlesByVault.clear();
  unavailableVaults.clear();
};

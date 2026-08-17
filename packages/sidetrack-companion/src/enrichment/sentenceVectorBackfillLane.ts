// Sentence-vector backfill lane — bounded, incremental backfill of PAGE
// sentence vectors (recall-v2's `sentence_vectors` table, owner_kind='page')
// over gists that predate this feature (docs/plans/2026-08-16-category-
// flexibility-hyde.md §12 — "the attention of sentence matters", USER
// DESIGN DIRECTIVE 2026-08-17).
//
// SAME IDIOM AS enrichment/keywordBackfillLane.ts, DELIBERATELY —
// self-scheduling cycle (fast poll while backlog remains, slow poll once
// empty), a bounded batch per cycle, persisted progress, never a boot
// full-pass. "Is this page done" is answered the SAME trivial way
// keywordBackfillLane.ts's header describes for its own store
// (recall-v2 store's allSentenceVectorOwnerIds('page') is an exact-existence
// check, no multi-state lifecycle) — so this lane, like that one, does not
// need its own resumption cursor for CORRECTNESS; progress is persisted for
// observability and a small per-page attempt cap (a gist that keeps failing
// deterministically — e.g. splits to zero sentences below the min-length
// floor — must not be retried every single cycle forever; SAME "a gist's
// text never changes on its own, so 3 failures in a row fail it forever, no
// cooldown decay" reasoning keywordBackfillLane.ts's header states for
// itself applies identically here).
//
// CANDIDATE SOURCE is the connections snapshot's WHOLE urlProjection (title
// + gist), NOT prototypeEvidence.ts's gatherWorkstreamEvidence (filed-only)
// or unfiledEvidence.ts's gatherUnfiledEvidence (unfiled-only) alone —
// SUPERSET of both, because BOTH consumers need it: prototypeLane.ts's
// serve-time page-sentence embed only needs the resolving page itself (no
// backfill dependency at all — see that module), but
// splitSuggestionEngine.ts's pairwise clustering (via
// suggestionRecomputeLane.ts) needs sentence vectors for EVERY evidence item
// it clusters, filed ('split' scope) AND unfiled ('new-category' scope)
// alike. One shared backfill population, capped and most-recent-first, same
// idiom keywordBackfillLane.ts's own population cap and
// prototypeEvidence.ts's selectEvidenceWithinBudget both already establish.
//
// EMBEDDER-WARMUP GATE (a real lesson from page-evidence/
// backgroundEmbeddingLane.ts's 90-min soak inertness, NOT present in
// keywordBackfillLane.ts's own design — added here because this lane's
// indexCandidate calls the SAME shared embed() pipeline that lesson is
// about). Optional `isEmbedderReady` dep, default "always ready" (so tests
// and the in-process embedder path are unaffected); when it returns false
// the lane pauses — no candidates offered, no attempts burned — until the
// child warms, exactly the "yield like a drain-pause" contract
// backgroundEmbeddingLane.ts documents for the identical race.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { ConnectionsStore } from '../connections/snapshot.js';
import { SqliteConnectionsStore } from '../connections/snapshot.js';
import { createRevision } from '../domain/ids.js';
import type { EventLog } from '../sync/eventLog.js';
import { deserializeUrlProjection } from '../urls/projection.js';
import { loadGistLookup, lookupGist, type GistLookup } from './contentEnrichment.js';
import { splitPageIntoSentences } from '../workstreams/sentenceSplit.js';

// ---- flag -----------------------------------------------------------------

export const SENTENCE_VECTOR_BACKFILL_ENV = 'SIDETRACK_SENTENCE_BACKFILL';

/** Default ON — same kill-switch idiom as keywordBackfillEnabled(). '0'/
 *  'false' disables: scheduleSentenceVectorBackfillLoop opens no store
 *  handle and starts no timer at all when this is off (zero cost), not
 *  merely a no-op cycle. */
export const sentenceVectorBackfillEnabled = (): boolean => {
  const raw = process.env[SENTENCE_VECTOR_BACKFILL_ENV];
  return raw !== '0' && raw !== 'false';
};

// ---- candidate gathering ----------------------------------------------

export interface SentenceBackfillCandidate {
  readonly canonicalUrl: string;
  readonly title: string | null;
  readonly gist: string | null;
  readonly firstSeenAtMs: number;
}

const parseIso = (value: string | undefined): number => {
  if (value === undefined) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
};

/**
 * Every canonicalUrl the connections snapshot knows about, joined with the
 * gist lookup — filed AND unfiled alike (see this module's header for why
 * that is the right population). Skips a page with neither title nor gist
 * (nothing to split). Returns [] (never throws) when the store is not the
 * sqlite-backed one or the snapshot has no projection yet, matching
 * unfiledEvidence.ts/prototypeEvidence.ts's own typed-empty contract.
 */
export const gatherSentenceBackfillCandidates = async (
  connectionsStore: ConnectionsStore,
  gistLookup: GistLookup | null,
): Promise<readonly SentenceBackfillCandidate[]> => {
  if (!(connectionsStore instanceof SqliteConnectionsStore)) return [];
  let metadata;
  try {
    metadata = await connectionsStore.readSnapshotMetadata();
  } catch {
    return [];
  }
  if (metadata?.urlProjection === undefined) return [];
  const projection = deserializeUrlProjection(metadata.urlProjection);
  const items: SentenceBackfillCandidate[] = [];
  for (const [canonicalUrl, record] of projection.byCanonicalUrl) {
    const title = record.latestTitle ?? null;
    const gist = lookupGist(gistLookup, 'url', canonicalUrl) ?? null;
    if ((title === null || title.trim().length === 0) && (gist === null || gist.trim().length === 0)) {
      continue; // nothing to split
    }
    items.push({ canonicalUrl, title, gist, firstSeenAtMs: parseIso(record.firstSeenAt) });
  }
  return items;
};

export const SENTENCE_BACKFILL_POPULATION_CAP_ENV = 'SIDETRACK_SENTENCE_BACKFILL_POPULATION_CAP';
export const DEFAULT_SENTENCE_BACKFILL_POPULATION_CAP = 2_000;

export const resolveSentenceBackfillPopulationCap = (): number => {
  const raw = process.env[SENTENCE_BACKFILL_POPULATION_CAP_ENV];
  if (raw === undefined || raw === '') return DEFAULT_SENTENCE_BACKFILL_POPULATION_CAP;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SENTENCE_BACKFILL_POPULATION_CAP;
  return parsed;
};

/** Most-recent-first, env-capped — the same "cap the population, never a
 *  full sweep" idiom every other evidence-gathering module in this feature
 *  area uses. Pure with respect to `items`. */
export const sentenceBackfillCandidatesWithinCap = (
  items: readonly SentenceBackfillCandidate[],
  limit: number = resolveSentenceBackfillPopulationCap(),
): readonly SentenceBackfillCandidate[] =>
  [...items].sort((left, right) => right.firstSeenAtMs - left.firstSeenAtMs).slice(0, Math.max(0, limit));

// ---- the lane -----------------------------------------------------------

export interface SentenceVectorBackfillStore {
  replaceSentenceVectors(
    ownerKind: 'page' | 'prototype',
    ownerId: string,
    sentences: readonly {
      readonly sentenceIndex: number;
      readonly source: string;
      readonly text: string;
      readonly embedding: Float32Array;
    }[],
  ): void;
  allSentenceVectorOwnerIds(ownerKind: 'page' | 'prototype'): ReadonlySet<string>;
}

export type SentenceBackfillEmbedFn = (texts: readonly string[]) => Promise<readonly Float32Array[]>;

export interface SentenceVectorBackfillLaneDeps {
  /** List candidate pages that MIGHT need backfilling — most-recent-first,
   *  bounded by the caller. Called once per cycle. */
  readonly listCandidates: () => Promise<readonly SentenceBackfillCandidate[]>;
  readonly store: SentenceVectorBackfillStore;
  readonly embed: SentenceBackfillEmbedFn;
  /** See this module's header — default "always ready" when omitted. */
  readonly isEmbedderReady?: () => boolean;
  readonly readProgress?: () => Promise<SentenceVectorBackfillProgress | null>;
  readonly writeProgress?: (progress: SentenceVectorBackfillProgress) => Promise<void>;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export interface SentenceVectorBackfillLaneConfig {
  readonly batchCap: number;
  readonly cycleIntervalMs: number;
  readonly idleIntervalMs: number;
  /** After this many consecutive failures a page is quarantined
   *  (skipped) permanently, for this lane's lifetime — same "the input text
   *  never changes on its own" reasoning keywordBackfillLane.ts's config
   *  documents for its own maxAttemptsPerPage. */
  readonly maxAttemptsPerPage: number;
}

export const DEFAULT_SENTENCE_VECTOR_BACKFILL_CONFIG: SentenceVectorBackfillLaneConfig = {
  batchCap: 20,
  cycleIntervalMs: 2_000,
  idleIntervalMs: 60_000,
  maxAttemptsPerPage: 3,
};

export interface SentenceVectorBackfillProgress {
  readonly schemaVersion: 1;
  readonly processedTotal: number;
  readonly lastRunAtMs: number | null;
  readonly attemptsByCanonicalUrl: Record<string, number>;
}

const emptyProgress = (): SentenceVectorBackfillProgress => ({
  schemaVersion: 1,
  processedTotal: 0,
  lastRunAtMs: null,
  attemptsByCanonicalUrl: {},
});

export interface SentenceVectorBackfillCycleResult {
  readonly scanned: number;
  readonly backlog: number;
  readonly indexed: number;
  readonly failed: number;
  readonly quarantined: number;
  readonly pausedForWarmup: boolean;
}

export interface SentenceVectorBackfillLaneHealth {
  readonly processedTotal: number;
  readonly lastBacklog: number;
  readonly lastRunAtMs: number | null;
  readonly quarantinedCount: number;
}

export interface SentenceVectorBackfillLane {
  readonly runOnce: () => Promise<SentenceVectorBackfillCycleResult>;
  readonly start: () => void;
  readonly stop: () => void;
  readonly progress: () => SentenceVectorBackfillProgress;
  readonly health: () => SentenceVectorBackfillLaneHealth;
}

/**
 * indexCandidate — split the candidate's title+gist, batch-embed the whole
 * sentence set in ONE embed() call (cost discipline: one round-trip per
 * page, not one per sentence), and persist via
 * store.replaceSentenceVectors('page', canonicalUrl, ...). Throws when the
 * split produces ZERO sentences or the embed fails/mismatches — the lane's
 * own attempt/quarantine machinery treats that as a deterministic,
 * permanent failure for this URL (see this module's header).
 */
const indexOneCandidate = async (
  candidate: SentenceBackfillCandidate,
  embed: SentenceBackfillEmbedFn,
  store: SentenceVectorBackfillStore,
): Promise<void> => {
  const sentences = splitPageIntoSentences(candidate.title, candidate.gist);
  if (sentences.length === 0) {
    throw new Error(`sentence backfill: title+gist split to zero sentences for ${candidate.canonicalUrl}`);
  }
  const vectors = await embed(sentences.map((s) => s.text));
  if (vectors.length !== sentences.length) {
    throw new Error(`sentence backfill: embed count mismatch for ${candidate.canonicalUrl}`);
  }
  store.replaceSentenceVectors(
    'page',
    candidate.canonicalUrl,
    sentences.map((sentence, index) => ({
      sentenceIndex: index,
      source: sentence.source,
      text: sentence.text,
      embedding: vectors[index]!,
    })),
  );
};

export const createSentenceVectorBackfillLane = (
  deps: SentenceVectorBackfillLaneDeps,
  config: SentenceVectorBackfillLaneConfig = DEFAULT_SENTENCE_VECTOR_BACKFILL_CONFIG,
): SentenceVectorBackfillLane => {
  let progressState: SentenceVectorBackfillProgress = emptyProgress();
  let lastBacklog = 0;
  let loaded = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((): void => undefined);
  const isEmbedderReady = deps.isEmbedderReady ?? ((): boolean => true);

  const ensureLoaded = async (): Promise<void> => {
    if (loaded) return;
    loaded = true;
    try {
      const stored = await deps.readProgress?.();
      if (stored !== null && stored !== undefined) progressState = stored;
    } catch {
      // Best-effort — start from empty progress on a read failure.
    }
  };

  const persist = async (): Promise<void> => {
    try {
      await deps.writeProgress?.(progressState);
    } catch {
      // Best-effort — a progress-write failure must not stop the lane.
    }
  };

  const runOnce = async (): Promise<SentenceVectorBackfillCycleResult> => {
    await ensureLoaded();
    if (!isEmbedderReady()) {
      // Pause hard — no candidates offered, no attempts burned. Same
      // "yield like a drain-pause, retry once ready" contract
      // backgroundEmbeddingLane.ts's isEmbedderReady gate documents for the
      // identical cold-embedder race.
      return { scanned: 0, backlog: lastBacklog, indexed: 0, failed: 0, quarantined: 0, pausedForWarmup: true };
    }

    let candidates: readonly SentenceBackfillCandidate[];
    try {
      candidates = await deps.listCandidates();
    } catch {
      candidates = [];
    }

    const alreadyIndexed = (() => {
      try {
        return deps.store.allSentenceVectorOwnerIds('page');
      } catch {
        return new Set<string>();
      }
    })();

    const backlog: SentenceBackfillCandidate[] = [];
    for (const candidate of candidates) {
      const attempts = progressState.attemptsByCanonicalUrl[candidate.canonicalUrl] ?? 0;
      if (attempts >= config.maxAttemptsPerPage) continue; // quarantined — never retried
      if (alreadyIndexed.has(candidate.canonicalUrl)) continue;
      backlog.push(candidate);
    }
    lastBacklog = backlog.length;

    const batch = backlog.slice(0, Math.max(0, config.batchCap));
    let indexed = 0;
    let failed = 0;
    const attemptsByCanonicalUrl = { ...progressState.attemptsByCanonicalUrl };
    for (const candidate of batch) {
      try {
        await indexOneCandidate(candidate, deps.embed, deps.store);
        indexed += 1;
        delete attemptsByCanonicalUrl[candidate.canonicalUrl];
      } catch (error) {
        failed += 1;
        attemptsByCanonicalUrl[candidate.canonicalUrl] =
          (attemptsByCanonicalUrl[candidate.canonicalUrl] ?? 0) + 1;
        log(`sentenceVectorBackfillLane: failed to index ${candidate.canonicalUrl}: ${String(error)}`);
      }
    }

    const quarantined = Object.values(attemptsByCanonicalUrl).filter(
      (attempts) => attempts >= config.maxAttemptsPerPage,
    ).length;

    progressState = {
      schemaVersion: 1,
      processedTotal: progressState.processedTotal + indexed,
      lastRunAtMs: now(),
      attemptsByCanonicalUrl,
    };
    await persist();

    // Audible per-cycle mark — same "silence is how a lane ships with zero
    // production callers undetected" lesson keywordBackfillLane.ts's own
    // cycle log documents.
    log(
      `[sentence-backfill] cycle indexed=${String(indexed)} failed=${String(failed)} remaining=${String(
        Math.max(0, backlog.length - indexed),
      )}`,
    );

    return {
      scanned: candidates.length,
      backlog: backlog.length,
      indexed,
      failed,
      quarantined,
      pausedForWarmup: false,
    };
  };

  const scheduleNext = (delayMs: number): void => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void runOnce()
        .then((result) => {
          const remaining = result.backlog - result.indexed;
          const backToBack = result.pausedForWarmup || remaining > 0;
          scheduleNext(backToBack ? config.cycleIntervalMs : config.idleIntervalMs);
        })
        .catch(() => {
          scheduleNext(config.idleIntervalMs);
        });
    }, delayMs);
    timer.unref?.();
  };

  return {
    runOnce,
    start: () => {
      scheduleNext(0);
    },
    stop: () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    progress: () => progressState,
    health: () => ({
      processedTotal: progressState.processedTotal,
      lastBacklog,
      lastRunAtMs: progressState.lastRunAtMs,
      quarantinedCount: Object.values(progressState.attemptsByCanonicalUrl).filter(
        (attempts) => attempts >= config.maxAttemptsPerPage,
      ).length,
    }),
  };
};

// ---------------------------------------------------------------------------
// Persisted progress artifact — same tiny atomic-write shape (mkdir + tmp
// file + rename) keywordBackfillLane.ts's own copy uses; no shared
// cross-module util exists in this codebase for this, by established
// precedent (see that module's header).
// ---------------------------------------------------------------------------

const sentenceBackfillProgressPath = (vaultRoot: string): string =>
  join(vaultRoot, '_BAC', 'connections', 'sentence-backfill-progress.json');

const atomicWriteJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${basename(path)}.${createRevision()}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
};

const readJsonFile = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
};

export const readSentenceVectorBackfillProgress = async (
  vaultRoot: string,
): Promise<SentenceVectorBackfillProgress | null> => {
  const parsed = await readJsonFile<SentenceVectorBackfillProgress>(sentenceBackfillProgressPath(vaultRoot));
  if (parsed === null || parsed.schemaVersion !== 1) return null;
  return parsed;
};

export const writeSentenceVectorBackfillProgress = async (
  vaultRoot: string,
  progress: SentenceVectorBackfillProgress,
): Promise<void> => {
  await atomicWriteJson(sentenceBackfillProgressPath(vaultRoot), progress);
};

// ---------------------------------------------------------------------------
// Companion background scheduler — same factory shape as
// enrichment/keywordBackfillLane.ts's scheduleKeywordBackfillLoop: the lane
// above is ALREADY self-scheduling, so this wrapper's only job is opening
// the shared recall-v2 store handle (reused, not a second SQLite connection
// to the same file — see recall-v2/pipeline.ts's warmRecallV2Store/
// peekRecallV2Store, the SAME pair workstreams/prototypeGeneration.ts's
// scheduler already uses) and the embedder, building the real deps, and
// starting/stopping the lane.
// ---------------------------------------------------------------------------

/** Modest, matching keywordBackfillLane.ts's own startup delay reasoning:
 *  begin promptly (the backlog this lane exists for is real and starts at
 *  0% coverage on every pre-§12 vault), but non-zero so it never competes
 *  with boot-critical work in the first moments. Overridable via
 *  SIDETRACK_SENTENCE_BACKFILL_STARTUP_DELAY_MS for tests. */
export const SENTENCE_VECTOR_BACKFILL_STARTUP_DELAY_MS = 30_000;

const resolveSentenceBackfillStartupDelayMs = (): number => {
  const raw = process.env['SIDETRACK_SENTENCE_BACKFILL_STARTUP_DELAY_MS'];
  if (raw === undefined || raw === '') return SENTENCE_VECTOR_BACKFILL_STARTUP_DELAY_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : SENTENCE_VECTOR_BACKFILL_STARTUP_DELAY_MS;
};

const buildSentenceBackfillDeps = (
  vaultRoot: string,
  eventLog: EventLog,
  connectionsStore: ConnectionsStore,
  store: SentenceVectorBackfillStore,
  embed: SentenceBackfillEmbedFn,
  isEmbedderReady: (() => boolean) | undefined,
  log: (message: string) => void,
): SentenceVectorBackfillLaneDeps => ({
  listCandidates: async () => {
    const gistLookup = await loadGistLookup(vaultRoot, eventLog).catch(() => null);
    const all = await gatherSentenceBackfillCandidates(connectionsStore, gistLookup).catch(
      () => [] as readonly SentenceBackfillCandidate[],
    );
    return sentenceBackfillCandidatesWithinCap(all);
  },
  store,
  embed,
  ...(isEmbedderReady === undefined ? {} : { isEmbedderReady }),
  readProgress: () => readSentenceVectorBackfillProgress(vaultRoot),
  writeProgress: (progress) => writeSentenceVectorBackfillProgress(vaultRoot, progress),
  log,
});

/**
 * Start the production sentence-vector backfill scheduler for one vault.
 * Env-gated (sentenceVectorBackfillEnabled — SIDETRACK_SENTENCE_BACKFILL,
 * default ON): when off, emits one boot line and returns a no-op disposer
 * without opening any handle or starting any timer. When on, opens (or
 * reuses) the shared recall-v2 store handle after a startup delay, builds
 * the real deps, and starts the lane's own self-scheduling loop.
 *
 * Returns ONE disposer for BOTH teardown[] (startup-failure rollback) and
 * the explicit pre-drain "stopping-lanes" stop set in runtime/companion.ts's
 * close() (#374 lane-stop discipline — a lane left ticking past close() is
 * still a live timer outliving the "shut down" process, even though this
 * lane, like keywordBackfillLane, never appends to the event log and so
 * cannot itself cause the SIGTERM-hang awaitIdle() failure mode that
 * discipline exists for).
 */
export const scheduleSentenceVectorBackfillLoop = (
  eventLog: EventLog,
  connectionsStore: ConnectionsStore,
  vaultRoot: string,
  options?: {
    readonly startupDelayMs?: number;
    readonly config?: SentenceVectorBackfillLaneConfig;
    readonly isEmbedderReady?: () => boolean;
    readonly log?: (message: string) => void;
  },
): (() => void) => {
  const log =
    options?.log ??
    ((message: string): void => {
      process.stdout.write(`${message}\n`);
    });

  if (!sentenceVectorBackfillEnabled()) {
    log(`[sentence-backfill] disabled via ${SENTENCE_VECTOR_BACKFILL_ENV}=0`);
    return () => undefined;
  }
  log('[sentence-backfill] enabled');

  let lane: SentenceVectorBackfillLane | null = null;
  let disposed = false;

  const startupTimer = setTimeout(() => {
    void (async (): Promise<void> => {
      try {
        const { peekRecallV2Store, warmRecallV2Store } = await import('../recall-v2/pipeline.js');
        warmRecallV2Store(vaultRoot);
        const store = await peekRecallV2Store(vaultRoot);
        if (disposed || store === undefined) return;
        const sentenceStore = store as unknown as SentenceVectorBackfillStore;
        if (
          typeof sentenceStore.replaceSentenceVectors !== 'function' ||
          typeof sentenceStore.allSentenceVectorOwnerIds !== 'function'
        ) {
          log('[sentence-backfill] store does not implement sentence-vector methods — skipping');
          return;
        }
        const { embed } = await import('../recall/embedder.js');
        const deps = buildSentenceBackfillDeps(
          vaultRoot,
          eventLog,
          connectionsStore,
          sentenceStore,
          embed,
          options?.isEmbedderReady,
          log,
        );
        lane = createSentenceVectorBackfillLane(deps, options?.config);
        lane.start();
      } catch (error) {
        log(`[sentence-backfill] scheduler failed to start: ${String(error)}`);
      }
    })();
  }, options?.startupDelayMs ?? resolveSentenceBackfillStartupDelayMs());
  startupTimer.unref?.();

  return () => {
    disposed = true;
    clearTimeout(startupTimer);
    lane?.stop();
  };
};

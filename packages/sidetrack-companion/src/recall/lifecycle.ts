import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { MODEL_ID } from './embedder.js';
import { readIndex } from './indexFile.js';
import { rebuildFromEventLog } from './rebuild.js';

// Surfaces the current freshness of the recall index so the side
// panel can show what's happening (and so the companion can decide
// whether to auto-rebuild on startup or after a model upgrade).
//
//   missing    — no index file on disk
//   stale      — index file exists but its model id no longer matches
//                the companion's current model. Cosine search across
//                mixed embeddings is meaningless, so the index is
//                effectively unusable until rebuilt.
//   empty      — index file is current but has no entries (vault has
//                no captured turns yet, or only empty captures).
//   rebuilding — a background rebuild is currently in flight.
//   ready      — index is current AND has at least one entry.
export type RecallStatus = 'missing' | 'stale' | 'empty' | 'rebuilding' | 'ready';

export interface RecallStatusReport {
  readonly status: RecallStatus;
  readonly entryCount: number;
  // Coverage estimate — total turns across every captured event in
  // the vault. The side panel can compare this against `entryCount`
  // to flag "events captured but not indexed" cases that need a
  // manual rebuild.
  readonly eventTurnCount: number;
  readonly modelId: string | null;
  readonly currentModelId: string;
  readonly companionVersion: string;
  readonly lastRebuildAt: string | null;
  readonly lastRebuildIndexed: number | null;
  readonly lastError: string | null;
}

export interface RecallLifecycle {
  readonly report: () => Promise<RecallStatusReport>;
  readonly ensureFresh: () => Promise<RecallStatusReport>;
  readonly scheduleRebuild: (reason: 'startup' | 'manual' | 'reconnect') => void;
  readonly waitForRebuild: () => Promise<void>;
  readonly isRebuilding: () => boolean;
}

export interface CreateRecallLifecycleOptions {
  readonly vaultRoot: string;
  readonly companionVersion: string;
  // Override for tests — defaults to the production embedder model.
  readonly currentModelId?: string;
  // Override for tests — defaults to the production rebuilder.
  readonly rebuilder?: (
    vaultRoot: string,
    eventLogPath: string,
  ) => Promise<{ readonly indexed: number }>;
  // Optional logger — defaults to console.info / console.warn so the
  // companion stdout shows when a rebuild kicks in.
  readonly log?: (message: string) => void;
  readonly warn?: (message: string) => void;
}

const indexPathFor = (vaultRoot: string): string => join(vaultRoot, '_BAC', 'recall', 'index.bin');

const eventLogPathFor = (vaultRoot: string): string => join(vaultRoot, '_BAC', 'events');

const countTurnsInEventLog = async (vaultRoot: string): Promise<number> => {
  const eventDir = eventLogPathFor(vaultRoot);
  const files = await readdir(eventDir).catch(() => [] as readonly string[]);
  let total = 0;
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const raw = await readFile(join(eventDir, file), 'utf8').catch(() => '');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed !== 'object' || parsed === null) continue;
        const turns = (parsed as { readonly turns?: unknown }).turns;
        if (!Array.isArray(turns)) continue;
        for (const rawTurn of turns) {
          if (typeof rawTurn !== 'object' || rawTurn === null) continue;
          const text = (rawTurn as { readonly text?: unknown }).text;
          if (typeof text === 'string' && text.trim().length > 0) {
            total += 1;
          }
        }
      } catch {
        // Ignore malformed lines — the event log is append-only.
      }
    }
  }
  return total;
};

export const createRecallLifecycle = (opts: CreateRecallLifecycleOptions): RecallLifecycle => {
  const currentModelId = opts.currentModelId ?? MODEL_ID;
  const rebuilder = opts.rebuilder ?? rebuildFromEventLog;
  const log = opts.log ?? ((message: string) => {
    // eslint-disable-next-line no-console
    console.info(message);
  });
  const warn = opts.warn ?? ((message: string) => {
    console.warn(message);
  });

  let rebuildPromise: Promise<void> | null = null;
  let lastError: string | null = null;
  let lastRebuildAt: string | null = null;
  let lastRebuildIndexed: number | null = null;

  const report = async (): Promise<RecallStatusReport> => {
    const [index, eventTurnCount] = await Promise.all([
      readIndex(indexPathFor(opts.vaultRoot)),
      countTurnsInEventLog(opts.vaultRoot),
    ]);
    const entryCount = index?.items.length ?? 0;
    const modelId = index?.modelId ?? null;

    let status: RecallStatus;
    if (rebuildPromise !== null) {
      status = 'rebuilding';
    } else if (index === null) {
      status = 'missing';
    } else if (modelId !== currentModelId) {
      status = 'stale';
    } else if (entryCount === 0 && eventTurnCount > 0) {
      // Header is current but nothing got indexed (likely an
      // upgrade from before incremental indexing was wired). Treat
      // as stale so reconnect-time auto-rebuild can heal it.
      status = 'stale';
    } else if (entryCount === 0) {
      status = 'empty';
    } else {
      status = 'ready';
    }

    return {
      status,
      entryCount,
      eventTurnCount,
      modelId,
      currentModelId,
      companionVersion: opts.companionVersion,
      lastRebuildAt,
      lastRebuildIndexed,
      lastError,
    };
  };

  const scheduleRebuild = (reason: 'startup' | 'manual' | 'reconnect'): void => {
    if (rebuildPromise !== null) return;
    log(`[recall] starting background rebuild (${reason})`);
    lastError = null;
    rebuildPromise = (async () => {
      try {
        const result = await rebuilder(opts.vaultRoot, eventLogPathFor(opts.vaultRoot));
        lastRebuildAt = new Date().toISOString();
        lastRebuildIndexed = result.indexed;
        log(`[recall] background rebuild finished: indexed ${String(result.indexed)} entries`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Recall rebuild failed.';
        lastError = message;
        warn(`[recall] background rebuild failed: ${message}`);
      } finally {
        rebuildPromise = null;
      }
    })();
  };

  const ensureFresh = async (): Promise<RecallStatusReport> => {
    const current = await report();
    if (current.status === 'missing' || current.status === 'stale') {
      scheduleRebuild('startup');
    }
    return current;
  };

  const waitForRebuild = async (): Promise<void> => {
    if (rebuildPromise !== null) {
      await rebuildPromise;
    }
  };

  const isRebuilding = (): boolean => rebuildPromise !== null;

  return { report, ensureFresh, scheduleRebuild, waitForRebuild, isRebuilding };
};

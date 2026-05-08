// Stage 4 — replay-on-startup of quarantined lines.
//
// On every boot, after the manifest registry + materializer registry
// are loaded, walk _BAC/audit/quarantine/ and re-attempt promotion
// for every entry. Lines that now succeed → Class A with their
// ORIGINAL emitted_at (not replay timestamp). Lines that still fail
// → stay quarantined with updated last_replay_at.

import { readdir, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

import { quarantineRootFor } from '../../vault/inbox.js';
import type { CollectorEvent, PromotionResult } from './types.js';
import { materializeCollectorLine, type PromoteContext } from './promote.js';

interface QuarantineEntryOnDisk {
  readonly line: CollectorEvent;
  readonly raw_line?: string;
  readonly line_hash?: string;
  readonly quarantined_at: string;
  readonly reason: string;
  readonly companion_version?: string;
  readonly framework_version?: string;
  readonly last_replay_at?: string | null;
}

export interface ReplayResult {
  readonly scanned: number;
  readonly promoted: number;
  readonly stillQuarantined: number;
  readonly removed: readonly string[]; // file paths whose every entry
  // was promoted-then-removed
}

interface ReplayOpts {
  readonly vaultRoot: string;
  readonly ctx: PromoteContext;
  readonly auditRoute: (route: string, subject: string) => Promise<void>;
}

const readJsonLines = async (path: string): Promise<readonly QuarantineEntryOnDisk[]> => {
  const raw = await readFile(path, 'utf8');
  const out: QuarantineEntryOnDisk[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as QuarantineEntryOnDisk);
    } catch {
      // Skip malformed quarantine entries — should never happen
      // because writes are atomic, but be defensive.
    }
  }
  return out;
};

const writeJsonLines = async (
  path: string,
  entries: readonly QuarantineEntryOnDisk[],
): Promise<void> => {
  if (entries.length === 0) {
    try {
      await unlink(path);
    } catch {
      // Already gone — fine.
    }
    return;
  }
  const body = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await writeFile(path, body, 'utf8');
};

const reconstructRawLine = (entry: QuarantineEntryOnDisk): string => {
  if (typeof entry.raw_line === 'string') return entry.raw_line;
  return JSON.stringify(entry.line);
};

export const replayQuarantine = async (opts: ReplayOpts): Promise<ReplayResult> => {
  const root = quarantineRootFor(opts.vaultRoot);
  let dateDirs: string[];
  try {
    dateDirs = await readdir(root);
  } catch {
    return { scanned: 0, promoted: 0, stillQuarantined: 0, removed: [] };
  }

  await opts.auditRoute('collector:replay-started', '');

  let scanned = 0;
  let promoted = 0;
  let stillQuarantined = 0;
  const removed: string[] = [];

  for (const date of dateDirs.sort()) {
    const dateDir = join(root, date);
    let collectorFiles: string[];
    try {
      collectorFiles = await readdir(dateDir);
    } catch {
      continue;
    }

    for (const fname of collectorFiles) {
      if (!fname.endsWith('.jsonl')) continue;
      const path = join(dateDir, fname);
      const entries = await readJsonLines(path);
      const remaining: QuarantineEntryOnDisk[] = [];
      const replayedAt = new Date().toISOString();

      for (const entry of entries) {
        scanned += 1;
        const rawLine = reconstructRawLine(entry);
        const result: PromotionResult = await materializeCollectorLine(rawLine, opts.ctx);

        if (result.kind === 'promoted' || result.kind === 'deduped') {
          promoted += 1;
          await opts.auditRoute('collector:line-promoted', `replay:${entry.line.collector_id}`);
        } else {
          stillQuarantined += 1;
          remaining.push({ ...entry, last_replay_at: replayedAt });
        }
      }

      await writeJsonLines(path, remaining);
      if (remaining.length === 0) {
        removed.push(path);
      }
    }

    try {
      const after = await readdir(dateDir);
      if (after.length === 0) {
        await rmdir(dateDir);
      }
    } catch {
      // Best-effort cleanup.
    }
  }

  await opts.auditRoute(
    'collector:replay-completed',
    `scanned=${scanned},promoted=${promoted},still=${stillQuarantined}`,
  );

  return { scanned, promoted, stillQuarantined, removed };
};

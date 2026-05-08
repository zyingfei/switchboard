// Stage 4 — quarantine writer.
//
// Append-only JSONL at _BAC/audit/quarantine/<YYYY-MM-DD>/<collector_id>.jsonl
// Idempotent on (collector_id, line_hash) — re-quarantining the same
// raw line for the same collector is a no-op (read existing entries,
// dedup before append).

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { writeFileAtomic } from '../../vault/atomic.js';
import {
  parseDateStamp,
  quarantineDirFor,
  quarantineFileFor,
  quarantineRootFor,
} from '../../vault/inbox.js';
import type { CollectorEvent, QuarantineReason } from './types.js';

export interface QuarantineEntry {
  readonly line: CollectorEvent;
  readonly raw_line: string;
  readonly line_hash: string;
  readonly quarantined_at: string;
  readonly reason: QuarantineReason;
  readonly companion_version: string;
  readonly framework_version: string;
  readonly last_replay_at?: string | null;
}

export interface QuarantineWriter {
  readonly write: (
    collectorId: string,
    rawLine: string,
    parsed: CollectorEvent,
    reason: QuarantineReason,
    quarantinedAt?: Date,
  ) => Promise<{ readonly written: boolean; readonly path: string }>;
  readonly readAllForCollector: (collectorId: string) => Promise<readonly QuarantineEntry[]>;
  readonly removeMatching: (
    collectorId: string,
    predicate: (e: QuarantineEntry) => boolean,
  ) => Promise<number>;
}

interface QuarantineOpts {
  readonly vaultRoot: string;
  readonly companionVersion: string;
  readonly frameworkVersion: string;
}

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await readFile(path, 'utf8');
    return true;
  } catch {
    return false;
  }
};

const readEntries = async (path: string): Promise<QuarantineEntry[]> => {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const out: QuarantineEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as QuarantineEntry);
    } catch {
      // Skip malformed.
    }
  }
  return out;
};

const writeEntries = async (path: string, entries: readonly QuarantineEntry[]): Promise<void> => {
  if (entries.length === 0) {
    try {
      await unlink(path);
    } catch {
      // Already gone.
    }
    return;
  }
  const body = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await writeFileAtomic(path, body);
};

const tryRmdirIfEmpty = async (path: string): Promise<void> => {
  try {
    const entries = await readdir(path);
    if (entries.length === 0) {
      await rmdir(path);
    }
  } catch {
    // Best-effort.
  }
};

export const createQuarantineWriter = (opts: QuarantineOpts): QuarantineWriter => {
  const { vaultRoot, companionVersion, frameworkVersion } = opts;

  return {
    async write(collectorId, rawLine, parsed, reason, quarantinedAt) {
      const at = quarantinedAt ?? new Date();
      const path = quarantineFileFor(vaultRoot, collectorId, at);
      const lineHash = sha256Hex(rawLine);

      await mkdir(dirname(path), { recursive: true });

      const existing = await readEntries(path);
      const dup = existing.some(
        (e) => e.line_hash === lineHash && e.line.collector_id === collectorId,
      );
      if (dup) {
        return { written: false, path };
      }

      const entry: QuarantineEntry = {
        line: parsed,
        raw_line: rawLine,
        line_hash: lineHash,
        quarantined_at: at.toISOString(),
        reason,
        companion_version: companionVersion,
        framework_version: frameworkVersion,
        last_replay_at: null,
      };
      const body = JSON.stringify(entry) + '\n';
      await writeFile(path, body, { encoding: 'utf8', flag: 'a' });
      return { written: true, path };
    },

    async readAllForCollector(collectorId) {
      const root = quarantineRootFor(vaultRoot);
      let dates: string[];
      try {
        dates = await readdir(root);
      } catch {
        return [];
      }
      const out: QuarantineEntry[] = [];
      for (const date of dates.sort()) {
        const path = join(root, date, `${collectorId}.jsonl`);
        if (!(await fileExists(path))) continue;
        out.push(...(await readEntries(path)));
      }
      return out;
    },

    async removeMatching(collectorId, predicate) {
      const root = quarantineRootFor(vaultRoot);
      let dates: string[];
      try {
        dates = await readdir(root);
      } catch {
        return 0;
      }
      let removed = 0;
      for (const date of dates) {
        const dateDir = quarantineDirFor(vaultRoot, date);
        const path = join(dateDir, `${collectorId}.jsonl`);
        const entries = await readEntries(path);
        if (entries.length === 0) continue;
        const remaining = entries.filter((e) => !predicate(e));
        const dropped = entries.length - remaining.length;
        if (dropped === 0) continue;
        await writeEntries(path, remaining);
        removed += dropped;
        await tryRmdirIfEmpty(dateDir);
      }
      return removed;
    },
  };
};

export { sha256Hex as _sha256HexForTesting };
// Re-export to silence unused-import warnings for parseDateStamp if a
// future call site needs it; harmless and documents the dependency.
export const _parseDateStampPassthrough = parseDateStamp;

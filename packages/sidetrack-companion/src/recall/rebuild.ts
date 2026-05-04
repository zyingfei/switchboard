import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { embed, MODEL_ID } from './embedder.js';
import { upsertEntries } from './indexFile.js';
import type { IndexEntry } from './ranker.js';

const isCaptureEventRecord = (
  value: unknown,
): value is {
  readonly bac_id?: string;
  readonly threadId?: string;
  readonly threadUrl?: string;
  readonly capturedAt?: string;
  readonly turns: readonly {
    readonly ordinal?: number;
    readonly text?: string;
    readonly capturedAt?: string;
  }[];
} =>
  typeof value === 'object' &&
  value !== null &&
  'turns' in value &&
  Array.isArray((value as { readonly turns?: unknown }).turns);

const eventFiles = async (eventLogPath: string): Promise<readonly string[]> => {
  if (eventLogPath.endsWith('.jsonl')) {
    return [eventLogPath];
  }
  const names = await readdir(eventLogPath).catch(() => []);
  return names
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => join(eventLogPath, name));
};

export const rebuildFromEventLog = async (
  vaultRoot: string,
  eventLogPath: string,
): Promise<{ readonly indexed: number }> => {
  const rawItems: {
    readonly id: string;
    readonly threadId: string;
    readonly capturedAt: string;
    readonly text: string;
  }[] = [];
  for (const file of await eventFiles(eventLogPath)) {
    const raw = await readFile(file, 'utf8').catch(() => '');
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isCaptureEventRecord(parsed)) {
          continue;
        }
        const threadId = parsed.bac_id ?? parsed.threadId ?? parsed.threadUrl;
        if (threadId === undefined || parsed.capturedAt === undefined) {
          continue;
        }
        for (const turn of parsed.turns) {
          if (typeof turn.text !== 'string' || turn.text.trim().length === 0) {
            continue;
          }
          rawItems.push({
            id: `${threadId}:${String(turn.ordinal ?? rawItems.length)}`,
            threadId,
            capturedAt: turn.capturedAt ?? parsed.capturedAt,
            text: turn.text,
          });
        }
      } catch {
        // Ignore malformed event-log lines; the source of truth remains append-only.
      }
    }
  }

  const vectors = await embed(rawItems.map((item) => item.text));
  const entries: IndexEntry[] = rawItems.map((item, index) => ({
    id: item.id,
    threadId: item.threadId,
    capturedAt: item.capturedAt,
    embedding: vectors[index] ?? new Float32Array(384),
  }));
  await upsertEntries(join(vaultRoot, '_BAC', 'recall', 'index.bin'), entries, MODEL_ID);
  return { indexed: entries.length };
};

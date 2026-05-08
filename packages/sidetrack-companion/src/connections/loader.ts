import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { TimelineDayProjection, TimelineStore } from '../timeline/projection.js';
import type {
  CodingSessionVaultRecord,
  DispatchVaultRecord,
  QueueVaultRecord,
  ReminderVaultRecord,
  ThreadVaultRecord,
  WorkstreamVaultRecord,
} from './snapshot.js';

// Lightweight on-disk readers for the connections materializer.
//
// The companion vault layout (mirroring what the MCP server's
// LiveVaultReader walks) is the source of truth for everything
// except the merged event log and timeline projections, which the
// materializer already has via its EventLog + TimelineStore deps.
//
//   _BAC/threads/<id>.json
//   _BAC/workstreams/<id>.json
//   _BAC/dispatches/<id>.json
//   _BAC/queue/<id>.json
//   _BAC/reminders/<id>.json
//   _BAC/coding/sessions/<id>.json
//
// We treat the on-disk records as authoritative when they exist;
// the materializer's reducer merges them with event-derived nodes.

const readJsonDirectory = async <T>(rootPath: string, relative: string): Promise<readonly T[]> => {
  const dir = join(rootPath, relative);
  let entries: string[];
  try {
    entries = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const name of entries.sort()) {
    try {
      const raw = await readFile(join(dir, name), 'utf8');
      out.push(JSON.parse(raw) as T);
    } catch {
      // skip unreadable / malformed files; the materializer's
      // health surface will still report success — partial reads
      // are tolerable for a derived view.
    }
  }
  return out;
};

export interface VaultReadResult {
  readonly threads: readonly ThreadVaultRecord[];
  readonly workstreams: readonly WorkstreamVaultRecord[];
  readonly dispatches: readonly DispatchVaultRecord[];
  readonly queueItems: readonly QueueVaultRecord[];
  readonly reminders: readonly ReminderVaultRecord[];
  readonly codingSessions: readonly CodingSessionVaultRecord[];
}

export const readVaultStores = async (vaultRoot: string): Promise<VaultReadResult> => {
  const [threads, workstreams, dispatches, queueItems, reminders, codingSessions] =
    await Promise.all([
      readJsonDirectory<ThreadVaultRecord>(vaultRoot, '_BAC/threads'),
      readJsonDirectory<WorkstreamVaultRecord>(vaultRoot, '_BAC/workstreams'),
      readJsonDirectory<DispatchVaultRecord>(vaultRoot, '_BAC/dispatches'),
      readJsonDirectory<QueueVaultRecord>(vaultRoot, '_BAC/queue'),
      readJsonDirectory<ReminderVaultRecord>(vaultRoot, '_BAC/reminders'),
      readJsonDirectory<CodingSessionVaultRecord>(vaultRoot, '_BAC/coding/sessions'),
    ]);
  return { threads, workstreams, dispatches, queueItems, reminders, codingSessions };
};

export const readAllTimelineDays = async (
  store: TimelineStore,
): Promise<readonly TimelineDayProjection[]> => {
  const dates = await store.listDays();
  const out: TimelineDayProjection[] = [];
  for (const date of dates) {
    const day = await store.readDay(date);
    if (day !== null) out.push(day);
  }
  return out;
};

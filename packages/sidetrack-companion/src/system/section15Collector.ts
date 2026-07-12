// PRD §15 falsifiability collector — drain-time materialize.
//
// Gathers the raw material for the six §15 counters (section15Counters.ts)
// with the SAME cost discipline as the workGraph-health artifact
// (workGraphHealthArtifact.ts): typed event reads (forEachChunkOfTypes /
// events_type_idx — never a full-log scan), a bounded audit-file scan,
// and a small per-day clean ledger. The connections drain hook calls
// `collectSection15Report`, writes the artifact, and the route serves it
// from disk. Missing/absent inputs degrade to zero counts (unfalsified),
// never throw.
//
// FREEZE-SAFE (ADR-0011): observability only. No serving consumer reads
// any of this.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { AcceptedEvent } from '../sync/causal.js';
import type { EventLog } from '../sync/eventLog.js';
import { getCaughtUpSharedEventStore } from '../sync/eventStore.js';
import {
  SECTION15_EVENT_TYPES,
  type Section15CleanDayRecord,
  type Section15Report,
  computeSection15Counters,
} from './section15Counters.js';

const emptyEvents: readonly AcceptedEvent[] = [];

// Typed read of exactly the §15 event subset. Mirrors
// workGraphHealth.ts:readEventsForHealth — the SQL type filter
// (events_type_idx) when the shared store is available, else a single
// readMerged filtered by type. The §15 types are all sparse (timeline is
// the biggest, but attribution/dispatch/reorg/restore are tiny), so the
// typed path stays cheap.
const readSection15Events = async (
  vaultRoot: string,
  eventLog: EventLog | undefined,
): Promise<readonly AcceptedEvent[]> => {
  if (eventLog === undefined) return emptyEvents;
  const types = [...SECTION15_EVENT_TYPES];
  const typeSet = new Set<string>(types);
  const store = await getCaughtUpSharedEventStore(vaultRoot);
  if (store === null) {
    return (await eventLog.readMerged()).filter((event) => typeSet.has(event.type));
  }
  const events: AcceptedEvent[] = [];
  await store.forEachChunkOfTypes(
    types,
    (chunk) => {
      for (const event of chunk) events.push(event);
    },
    2000,
  );
  return events;
};

// How many trailing audit day-files to scan for criterion 5. The audit
// log is date-stamped (_BAC/audit/<YYYY-MM-DD>.jsonl); the §15 window is
// 30d, so scanning the newest ~35 files covers it with headroom while
// bounding the read (rotated .jsonl.gz files are skipped — recent
// context_pack calls live in the live .jsonl shards).
export const SECTION15_AUDIT_SCAN_DAYS = 35;

// Extract the `tool` field from the audit day-files. Best-effort: an
// unreadable/torn line is skipped, never fatal. Only the tool name is
// read (no argsSummary / body / URL) — privacy-clean.
const readAuditToolNames = async (vaultRoot: string): Promise<readonly string[]> => {
  const auditRoot = join(vaultRoot, '_BAC', 'audit');
  const names = await readdir(auditRoot).catch(() => [] as string[]);
  const dayFiles = names
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .reverse()
    .slice(0, SECTION15_AUDIT_SCAN_DAYS);
  const tools: string[] = [];
  for (const name of dayFiles) {
    const body = await readFile(join(auditRoot, name), 'utf8').catch(() => '');
    for (const line of body.split('\n')) {
      if (line.length === 0) continue;
      try {
        const parsed = JSON.parse(line) as { tool?: unknown };
        if (typeof parsed.tool === 'string' && parsed.tool.length > 0) tools.push(parsed.tool);
      } catch {
        // Torn/partial line (a concurrent append raced the read) — skip.
      }
    }
  }
  return tools;
};

export interface CollectSection15Options {
  readonly vaultRoot: string;
  readonly eventLog?: EventLog;
  // Prior per-day clean ledger (criterion 6). The collector reads it
  // from disk (section15Artifact.ts) and passes it here so this module
  // stays free of the ledger's persistence format.
  readonly cleanDays?: readonly Section15CleanDayRecord[];
  readonly now?: () => Date;
}

// Assemble the raw inputs and compute the report. Pure-ish: all I/O is
// read-only + best-effort; the writer (section15Artifact.ts) owns the
// disk write and the ledger fold.
export const collectSection15Report = async (
  options: CollectSection15Options,
): Promise<Section15Report> => {
  const now = options.now ?? (() => new Date());
  const [events, auditToolNames] = await Promise.all([
    readSection15Events(options.vaultRoot, options.eventLog),
    readAuditToolNames(options.vaultRoot),
  ]);
  return computeSection15Counters({
    events,
    auditToolNames,
    cleanDays: options.cleanDays ?? [],
    now,
  });
};

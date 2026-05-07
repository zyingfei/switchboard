import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { TestCompanion } from './companion';

// Strong-eventual-consistency helpers. The plan distinguishes
// three layers; these helpers each operate at one of them so a
// test reads its assertion as "log SEC", "projection SEC", or
// "query SEC".
//
// Layer 1: event-log SEC
//   assertEventLogContainsAllDots — every replica's merged log
//   contains the same set of (replicaId, seq) dots. Local files
//   differ (each replica writes only its own shard plus imported
//   peer shards), but the union matches.
//
// Layer 2: projection SEC
//   assertProjectionEqual — canonicalized projection records
//   from each replica deep-equal. Canonicalization drops
//   local-only metadata (manifest builtAt, ingest-state
//   timestamps, lifecycle lastRebuildAt).
//
// Layer 3: query SEC
//   assertRecallQueryExcludesTombstoned — default query honors
//   target-level recall tombstones.

export interface AcceptedEventOnDisk {
  readonly clientEventId: unknown;
  readonly type: unknown;
  readonly dot?: { readonly replicaId?: unknown; readonly seq?: unknown };
  readonly deps?: Record<string, unknown>;
  readonly aggregateId?: unknown;
  readonly payload?: unknown;
  readonly acceptedAtMs?: unknown;
}

const readReplicaLogShard = async (
  vaultRoot: string,
  replicaId: string,
): Promise<AcceptedEventOnDisk[]> => {
  const dir = path.join(vaultRoot, '_BAC', 'log', replicaId);
  const files = await readdir(dir).catch(() => [] as readonly string[]);
  const events: AcceptedEventOnDisk[] = [];
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const raw = await readFile(path.join(dir, file), 'utf8').catch(() => '');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        events.push(JSON.parse(trimmed) as AcceptedEventOnDisk);
      } catch {
        // Skip malformed lines (the append-only log is
        // tolerant of partial last-line writes).
      }
    }
  }
  return events;
};

const readMergedLog = async (vaultRoot: string): Promise<AcceptedEventOnDisk[]> => {
  const logRoot = path.join(vaultRoot, '_BAC', 'log');
  const replicaDirs = await readdir(logRoot).catch(() => [] as readonly string[]);
  const all: AcceptedEventOnDisk[] = [];
  for (const replicaDir of replicaDirs) {
    all.push(...(await readReplicaLogShard(vaultRoot, replicaDir)));
  }
  return all;
};

const dotKey = (event: AcceptedEventOnDisk): string => {
  const dot = event.dot;
  if (typeof dot !== 'object' || dot === null) return '__no_dot__';
  return `${String(dot.replicaId ?? '')}:${String(dot.seq ?? '')}`;
};

// Quiesce: poll each replica's merged log until both replicas see
// the same set of (replicaId, seq) dots. The relay path is
// best-effort + ws-buffered, so a freshly-emitted event takes a
// moment to land on the peer; this helper centralizes the wait
// so individual tests don't sprinkle setTimeout(2000) everywhere.

export interface QuiesceOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export const quiesceUntilConverged = async (
  replicas: readonly TestCompanion[],
  options: QuiesceOptions = {},
): Promise<void> => {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let lastSnapshots: string[] = [];
  while (Date.now() < deadline) {
    const snapshots = await Promise.all(
      replicas.map(async (replica) => {
        const merged = await readMergedLog(replica.vaultPath);
        const dots = merged.map(dotKey).sort();
        return JSON.stringify(dots);
      }),
    );
    lastSnapshots = snapshots;
    const allEqual = snapshots.every((s) => s === snapshots[0]);
    if (allEqual) return;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(
    `quiesceUntilConverged: replicas did not converge within ${String(timeoutMs)}ms.\n` +
      lastSnapshots
        .map((s, i) => `  replica[${String(i)}].dots=${s.slice(0, 200)}`)
        .join('\n'),
  );
};

// Layer-1 assertion: replica's merged logs share the same set of
// dots + identical payloads per dot. acceptedAtMs CAN differ
// across replicas — the dot is the durable identity, not the
// wall-clock at acceptance.

export interface AssertEventLogOptions {
  // Compare full payload bytes (default) or just dots. Set to
  // true when you only care that the events were transported,
  // not that their content matches (rare).
  readonly dotOnly?: boolean;
}

export const assertEventLogContainsAllDots = async (
  replicas: readonly TestCompanion[],
  options: AssertEventLogOptions = {},
): Promise<void> => {
  if (replicas.length < 2) {
    throw new Error('assertEventLogContainsAllDots requires ≥ 2 replicas.');
  }
  const snapshots = await Promise.all(
    replicas.map(async (replica) => {
      const merged = await readMergedLog(replica.vaultPath);
      // Sort by dot so order isn't a comparison axis.
      const sorted = merged.slice().sort((a, b) => dotKey(a).localeCompare(dotKey(b)));
      return sorted;
    }),
  );
  const first = snapshots[0]!;
  for (let i = 1; i < snapshots.length; i += 1) {
    const other = snapshots[i]!;
    if (other.length !== first.length) {
      throw new Error(
        `event-log dot count mismatch: replica[0]=${String(first.length)} replica[${String(
          i,
        )}]=${String(other.length)}`,
      );
    }
    for (let j = 0; j < first.length; j += 1) {
      const a = first[j]!;
      const b = other[j]!;
      if (dotKey(a) !== dotKey(b)) {
        throw new Error(
          `dot mismatch at index ${String(j)}: replica[0]=${dotKey(a)} replica[${String(i)}]=${dotKey(b)}`,
        );
      }
      if (options.dotOnly === true) continue;
      // Compare payload bytes via JSON canonicalization. dot,
      // type, payload, deps must match; acceptedAtMs is allowed
      // to differ (each replica timestamps on its own clock at
      // import time).
      const canonical = (e: AcceptedEventOnDisk) =>
        JSON.stringify({
          dot: e.dot,
          deps: e.deps ?? {},
          type: e.type,
          aggregateId: e.aggregateId,
          payload: e.payload,
          clientEventId: e.clientEventId,
        });
      const ca = canonical(a);
      const cb = canonical(b);
      if (ca !== cb) {
        throw new Error(
          `event payload mismatch at dot ${dotKey(a)}: ` +
            `\n  replica[0]=${ca.slice(0, 300)}` +
            `\n  replica[${String(i)}]=${cb.slice(0, 300)}`,
        );
      }
    }
  }
};

// Layer-3 assertion: default recall query excludes any chunk whose
// threadId is in the supplied tombstone set. Hits the running
// companion's HTTP, not the filesystem — query-layer SEC is what
// the user perceives, not the index file's `tombstoned` flag.

export const assertRecallQueryExcludesTombstoned = async (
  replica: TestCompanion,
  tombstonedThreadIds: readonly string[],
  query: string,
): Promise<void> => {
  const response = await fetch(
    `http://127.0.0.1:${String(replica.port)}/v1/recall/query?q=${encodeURIComponent(query)}`,
    { headers: { 'x-bac-bridge-key': replica.bridgeKey } },
  );
  if (!response.ok) {
    throw new Error(
      `recall query against replica on :${String(replica.port)} failed: ${String(response.status)}`,
    );
  }
  const body = (await response.json()) as { readonly data?: readonly { readonly threadId?: string }[] };
  const matchedTombstoned = (body.data ?? []).filter(
    (row) => row.threadId !== undefined && tombstonedThreadIds.includes(row.threadId),
  );
  if (matchedTombstoned.length > 0) {
    const ids = matchedTombstoned.map((r) => r.threadId).join(', ');
    throw new Error(
      `recall query returned chunks for tombstoned threads (${ids}) — target-level tombstone violated`,
    );
  }
};

// Helper for tests that need to wire concurrent ops by referencing
// a specific event's dot. Walks the merged log + returns the first
// match; useful to construct deps that observe a peer event.

export const dotOf = async (
  replica: TestCompanion,
  predicate: (event: AcceptedEventOnDisk) => boolean,
): Promise<{ readonly replicaId: string; readonly seq: number }> => {
  const merged = await readMergedLog(replica.vaultPath);
  const match = merged.find(predicate);
  if (match === undefined || typeof match.dot !== 'object' || match.dot === null) {
    throw new Error('dotOf: no event matched the predicate');
  }
  return {
    replicaId: String(match.dot.replicaId ?? ''),
    seq: Number(match.dot.seq ?? 0),
  };
};

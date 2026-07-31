import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { isAcceptedEvent } from '../sync/eventLog.js';

// Proof-gated retention plan for the legacy capture ingress spool,
// `_BAC/events/<YYYY-MM-DD>.jsonl`.
//
// THE MEASUREMENT. 131.5 MB across 40 daily files reaching back to May on the
// dogfood vault — the fifth-largest family, and one with NO retention of any
// kind. The CLI says so out loud (`cli.ts`: the GC "never touches _BAC/log,
// _BAC/events, threads, workstreams, or other canonical user state"), and the
// 2026-07-11 architecture audit measured it at 70 MB. It has since doubled.
//
// WHY IT LOOKS DELETABLE AND IS NOT. `POST /v1/events` does a DUAL write: the
// legacy line into `_BAC/events/<date>.jsonl` (vault/writer.ts writeCaptureEvent)
// AND a `capture.recorded` event into the canonical log
// (`_BAC/log/<replica>/<date>.jsonl`). If the canonical copy were guaranteed,
// the spool would be pure duplication and age alone would justify deletion.
//
// It is not guaranteed, and the brief's premise — "find the ingest-state /
// idempotency record that proves a day was fully ingested" — does not survive
// contact with the code. THAT RECORD DOES NOT EXIST. Exhaustively:
//   - `_BAC/recall/ingest-state.json` (recall/ingestor.ts) holds
//     `processedEvents: Record<replicaId, seq>` — a version vector over the
//     CANONICAL log / event store. It has no filename, no byte offset, and no
//     concept of the spool. It proves the canonical log was consumed, which is
//     a different claim entirely.
//   - `.config/idempotency/<hash>.json` receipts are keyed on the client's
//     Idempotency-Key, are per-response not per-file, and EXPIRE AFTER 1 HOUR.
//   - `sync/lineage.ts` does not list `_BAC/events/` as canonical state. Its
//     only safe recovery parent is a matching capture.recorded payload in the
//     canonical JSONL log, verified below rather than assumed.
//   - the only dedupe is at READ time and in memory: recall/rebuild.ts skips a
//     spool line whose `bac_id` it already saw in the canonical log. `bac_id` is
//     minted FRESH on every writeCaptureEvent call, so a capture retried past
//     the 1h idempotency TTL lands under a different bac_id that this dedupe
//     cannot collapse — and the canonical-log append on that path is
//     best-effort with its result discarded, so a divergence is neither
//     prevented nor recorded.
//   - the per-file bookmark idiom EXISTS in this repo — collectors keep
//     `<inbox>/.bookmark.json` = {filename, byte_offset, line_hash_of_last_
//     promoted, updated_at} — it is simply not wired to this spool.
//
// SAFE TRANSITION (S2). A separate bookmark was never added. Instead, the
// canonical log itself is the durable read-back proof: every non-empty spool
// line must parse, carry a bac_id, and have a byte-equivalent capture payload
// in a structurally-valid `capture.recorded` AcceptedEvent. A missing canonical
// log is `absent`; a present log with a missing/mismatched record is `refuted`.
// Only a fully covered, past-retention day is reclaimable. Apply lives in
// storageRetirement.ts and repeats this proof against the exact file hash
// immediately before unlinking it.

const SPOOL_SEGMENTS = ['_BAC', 'events'] as const;
const SPOOL_NAME_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u;

/** Default: keep two weeks of spool days before a day is even a candidate. */
export const INGRESS_RETAIN_DAYS_DEFAULT = 14;

export const ingressRetainDays = (): number => {
  const raw = process.env['SIDETRACK_INGRESS_RETAIN_DAYS'];
  if (raw === undefined) return INGRESS_RETAIN_DAYS_DEFAULT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : INGRESS_RETAIN_DAYS_DEFAULT;
};

/**
 * Whether a day's full ingestion into the canonical log can be PROVEN from
 * disk.
 *   - `absent`  — no proof artifact exists for this spool at all (today's
 *                 reality; see the header). Reclaimable stays 0.
 *   - `verified`— a proof artifact says this day is fully ingested.
 *   - `refuted` — a proof artifact exists and says it is NOT fully ingested.
 * Three states, not a boolean: "no proof" and "proof says no" are different
 * facts and must not collapse.
 */
export type IngestionProof = 'absent' | 'verified' | 'refuted';

export interface IngressDayPlan {
  readonly path: string;
  readonly date: string;
  readonly bytes: number;
  readonly lines: number | null;
  /** SHA-256 of the exact spool bytes. Apply uses it as the stale-plan guard. */
  readonly contentHash: string;
  /** True when the day is older than the retention window. */
  readonly pastRetention: boolean;
  readonly proof: IngestionProof;
  /** Bytes this planner is willing to call reclaimable. 0 unless proof is
   *  `verified` AND the day is past retention. */
  readonly reclaimable: number;
  readonly note: string;
}

export interface IngressRetentionPlan {
  readonly producedAt: string;
  readonly retainDays: number;
  /** Days strictly before this UTC date are past retention. */
  readonly cutoffDate: string;
  readonly days: readonly IngressDayPlan[];
  readonly totalBytes: number;
  /** Bytes in past-retention days — the size of the opportunity. */
  readonly pastRetentionBytes: number;
  /** Bytes this planner will actually vouch for. 0 while proof is absent. */
  readonly reclaimableBytes: number;
  /** Planning is read-only; verified entries are applied only by the explicit
   * storage-retirement confirmation path. */
  readonly reportOnly: false;
  /** Present when nothing is reclaimable because no proof artifact exists. */
  readonly blockedBy: {
    readonly reason: string;
    readonly missingArtifact: string;
    readonly clearedBy: string;
  } | null;
}

const dateMinusDays = (now: Date, days: number): string =>
  new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);

const hashText = (raw: string): string => createHash('sha256').update(raw).digest('hex');

const canonicalCapturePayload = (value: Record<string, unknown>): Record<string, unknown> => ({
  bac_id: value['bac_id'],
  ...(value['threadId'] === undefined ? {} : { threadId: value['threadId'] }),
  threadUrl: value['threadUrl'],
  provider: value['provider'],
  ...(value['title'] === undefined ? {} : { title: value['title'] }),
  capturedAt: value['capturedAt'],
  turns: value['turns'],
});

const capturePayloadHash = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row['bac_id'] !== 'string' ||
    typeof row['threadUrl'] !== 'string' ||
    typeof row['provider'] !== 'string' ||
    typeof row['capturedAt'] !== 'string' ||
    !Array.isArray(row['turns'])
  ) {
    return null;
  }
  return hashText(JSON.stringify(canonicalCapturePayload(row)));
};

interface CanonicalCaptureIndex {
  readonly available: boolean;
  readonly valid: boolean;
  readonly payloadHashes: ReadonlyMap<string, string>;
}

const listCanonicalShards = async (vaultRoot: string): Promise<readonly string[]> => {
  const root = join(vaultRoot, '_BAC', 'log');
  const replicas = await readdir(root).catch(() => []);
  const paths: string[] = [];
  for (const replica of replicas.sort()) {
    const dir = join(root, replica);
    const names = await readdir(dir).catch(() => []);
    for (const name of names.sort()) {
      if (name.endsWith('.jsonl')) paths.push(join(dir, name));
    }
  }
  return paths;
};

/** Read the canonical bytes back from disk; no in-memory append result counts
 * as proof. Any malformed non-empty canonical line fails the proof closed. */
const buildCanonicalCaptureIndex = async (vaultRoot: string): Promise<CanonicalCaptureIndex> => {
  const shards = await listCanonicalShards(vaultRoot);
  if (shards.length === 0) return { available: false, valid: false, payloadHashes: new Map() };
  const payloadHashes = new Map<string, string>();
  for (const shard of shards) {
    let raw: string;
    try {
      raw = await readFile(shard, 'utf8');
    } catch {
      return { available: true, valid: false, payloadHashes };
    }
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        return { available: true, valid: false, payloadHashes };
      }
      if (!isAcceptedEvent(parsed)) {
        return { available: true, valid: false, payloadHashes };
      }
      if (parsed.type !== 'capture.recorded') continue;
      const payloadHash = capturePayloadHash(parsed.payload);
      if (payloadHash === null) return { available: true, valid: false, payloadHashes };
      const bacId = (parsed.payload as Record<string, unknown>)['bac_id'] as string;
      const prior = payloadHashes.get(bacId);
      if (prior !== undefined && prior !== payloadHash) {
        return { available: true, valid: false, payloadHashes };
      }
      payloadHashes.set(bacId, payloadHash);
    }
  }
  return { available: true, valid: true, payloadHashes };
};

const verifySpoolDay = (
  raw: string,
  canonical: CanonicalCaptureIndex,
): { readonly proof: IngestionProof; readonly lines: number } => {
  const nonEmptyLines = raw.split('\n').filter((line) => line.trim().length > 0);
  const lines = nonEmptyLines.length;
  if (!canonical.available) return { proof: 'absent', lines };
  if (!canonical.valid) return { proof: 'refuted', lines };
  for (const line of nonEmptyLines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return { proof: 'refuted', lines };
    }
    const payloadHash = capturePayloadHash(parsed);
    if (payloadHash === null) return { proof: 'refuted', lines };
    const bacId = (parsed as Record<string, unknown>)['bac_id'] as string;
    if (canonical.payloadHashes.get(bacId) !== payloadHash) {
      return { proof: 'refuted', lines };
    }
  }
  return { proof: 'verified', lines };
};

/**
 * Build the report-only ingress retention plan. Reads spool file CONTENTS only
 * for the line count; pass `countLines: false` to keep it stat-only on a large
 * spool.
 */
export const planIngressRetention = async (
  vaultRoot: string,
  options: {
    readonly now?: Date;
    readonly retainDays?: number;
    readonly countLines?: boolean;
  } = {},
): Promise<IngressRetentionPlan> => {
  const now = options.now ?? new Date();
  const retainDays = options.retainDays ?? ingressRetainDays();
  const cutoffDate = dateMinusDays(now, retainDays);
  const spoolDir = join(vaultRoot, ...SPOOL_SEGMENTS);
  const wantLines = options.countLines !== false;

  let names: readonly string[];
  try {
    names = await readdir(spoolDir);
  } catch {
    names = [];
  }
  const canonical = await buildCanonicalCaptureIndex(vaultRoot);

  const days: IngressDayPlan[] = [];
  for (const name of names) {
    const match = SPOOL_NAME_RE.exec(name);
    if (match === null) continue;
    const date = match[1] as string;
    const path = join(spoolDir, name);
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isFile()) continue;
    const raw = await readFile(path, 'utf8').catch(() => null);
    if (raw === null) continue;
    const verified = verifySpoolDay(raw, canonical);
    const proof = verified.proof;
    // Lexicographic compare is correct for YYYY-MM-DD.
    const pastRetention = date < cutoffDate;
    const reclaimable = pastRetention && proof === 'verified' ? info.size : 0;
    days.push({
      path,
      date,
      bytes: info.size,
      lines: wantLines ? verified.lines : null,
      contentHash: hashText(raw),
      pastRetention,
      proof,
      reclaimable,
      note: !pastRetention
        ? `within the ${String(retainDays)}-day retention window`
        : proof === 'verified'
          ? 'past retention and provably ingested'
          : proof === 'refuted'
            ? 'past retention, but the ingestion bookmark does not yet cover it'
            : 'past retention, but nothing on disk proves it was ingested — kept',
    });
  }
  days.sort((left, right) => left.date.localeCompare(right.date));

  return {
    producedAt: now.toISOString(),
    retainDays,
    cutoffDate,
    days,
    totalBytes: days.reduce((sum, day) => sum + day.bytes, 0),
    pastRetentionBytes: days
      .filter((day) => day.pastRetention)
      .reduce((sum, day) => sum + day.bytes, 0),
    reclaimableBytes: days.reduce((sum, day) => sum + day.reclaimable, 0),
    reportOnly: false,
    blockedBy: days.some((day) => day.pastRetention && day.proof === 'absent')
      ? {
          reason: 'no canonical JSONL shard exists to prove the spool day was durably mirrored',
          missingArtifact:
            '_BAC/log/<replicaId>/<date>.jsonl containing a matching capture.recorded event for every spool line',
          clearedBy:
            'successfully append every capture.recorded event and read the canonical shard back',
        }
      : null,
  };
};

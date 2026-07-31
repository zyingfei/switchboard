import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

// REPORT-ONLY retention plan for the legacy capture ingress spool,
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
//   - `sync/lineage.ts` — the registry that enumerates every canonical and
//     derived store — does not list `_BAC/events/` AT ALL. No node, no parent,
//     no rebuild entrypoint.
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
// SO THIS PLANNER REPORTS AND STOPS. It classifies days as past-retention and
// measures what they cost, and it sets `reclaimableBytes` to 0 with the reason
// named, because the honest answer to "can I delete May?" is "not provably".
// Deleting a spool day on age alone risks discarding a capture whose only copy
// is that file. `proof: 'absent'` is a typed emptiness: it is not "nothing is
// reclaimable", it is "reclaimability is unknown and here is the missing
// artifact". The day the bookmark record lands, this planner needs one branch,
// not a rewrite — which is why the shape is already here.

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
  /** REPORT-ONLY marker: this module has no apply function, by design. */
  readonly reportOnly: true;
  /** Present when nothing is reclaimable because no proof artifact exists. */
  readonly blockedBy: {
    readonly reason: string;
    readonly missingArtifact: string;
    readonly clearedBy: string;
  } | null;
}

const dateMinusDays = (now: Date, days: number): string =>
  new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);

/**
 * Locate the per-day ingestion proof, if any exists. Kept as its own function
 * (rather than inlined as `'absent'`) so the search is auditable and so the
 * fix is a one-place change: today it looks for the collector-style bookmark
 * that would make this decidable, finds nothing, and says so.
 */
const findIngestionProof = async (spoolDir: string): Promise<IngestionProof> => {
  // The collectors' bookmark shape ({filename, byte_offset, ...}) is the record
  // that would prove this. If someone wires it to the spool, it lands here.
  const bookmark = join(spoolDir, '.bookmark.json');
  try {
    const parsed = JSON.parse(await readFile(bookmark, 'utf8')) as {
      readonly filename?: unknown;
      readonly byte_offset?: unknown;
    };
    if (typeof parsed.filename === 'string' && typeof parsed.byte_offset === 'number') {
      // A bookmark exists. Per-day verification against it is deliberately NOT
      // implemented here: introducing it silently would make this planner start
      // vouching for deletions on a code path no test covers. Report `refuted`
      // (proof exists, this day is not yet shown ingested) so the operator sees
      // the artifact was found and the comparison is the remaining work.
      return 'refuted';
    }
  } catch {
    /* no bookmark — the expected case */
  }
  return 'absent';
};

/** Cheap line count for a spool day. Null when the file could not be read —
 *  absent ≠ zero lines. */
const countLines = async (path: string): Promise<number | null> => {
  try {
    const raw = await readFile(path, 'utf8');
    let lines = 0;
    for (const line of raw.split('\n')) {
      if (line.trim().length > 0) lines += 1;
    }
    return lines;
  } catch {
    return null;
  }
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
  const proof = await findIngestionProof(spoolDir);

  const days: IngressDayPlan[] = [];
  for (const name of names) {
    const match = SPOOL_NAME_RE.exec(name);
    if (match === null) continue;
    const date = match[1] as string;
    const path = join(spoolDir, name);
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isFile()) continue;
    // Lexicographic compare is correct for YYYY-MM-DD.
    const pastRetention = date < cutoffDate;
    const reclaimable = pastRetention && proof === 'verified' ? info.size : 0;
    days.push({
      path,
      date,
      bytes: info.size,
      lines: wantLines ? await countLines(path) : null,
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
    reportOnly: true,
    blockedBy:
      proof === 'absent'
        ? {
            reason:
              'no artifact on disk proves a spool day was fully mirrored into the canonical log; the canonical-log append on POST /v1/events is best-effort and its result is discarded, and the only dedupe is a read-time bac_id set that a re-minted bac_id defeats',
            missingArtifact:
              '_BAC/events/.bookmark.json — the collector bookmark shape ({filename, byte_offset, line_hash_of_last_promoted, updated_at}) applied to this spool',
            clearedBy:
              'have the /v1/events handler record the spool offset it successfully mirrored, then compare per-day here',
          }
        : null,
  };
};

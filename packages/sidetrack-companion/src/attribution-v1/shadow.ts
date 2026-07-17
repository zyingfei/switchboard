// Attribution v1 — shadow lane (observability only, never serves).
//
// At the point the incumbent resolver produces its dry-run candidates
// (http/server.ts GET/POST /v1/visits/:url/resolve), we ALSO run the v1
// scorer against the drain-time state artifact and record a compact
// comparison. This mirrors the topic-producer A/B shadow-diagnostics
// pattern (connections/topicShadowObservation.ts): the challenger runs
// beside the incumbent, its output is logged, and NOTHING it produces
// changes what serves.
//
// COST DISCIPLINE: the serve path must not do disk I/O per request. The
// shadow record is pushed into a bounded in-process ring buffer (O(1),
// allocation-only); the connections drain hook flushes the buffer to a
// bounded JSONL artifact on the drain cadence. A resolve that runs with no
// fresh state artifact, or with the flag off, records nothing — the serve
// path is untouched either way.
//
// FLAG: SIDETRACK_ATTRIBUTION_V1_SHADOW, default ON (observability). Read at
// the call site so tests can assert the served response is byte-identical
// with the flag on vs off.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { AttributionV1Action, AttributionV1Result } from './scorer.js';

export const ATTRIBUTION_V1_SHADOW_ENV = 'SIDETRACK_ATTRIBUTION_V1_SHADOW';

// Default ON: absence of the env var means enabled (observability). Only an
// explicit '0' disables. Verified against wiring in the shadow-emit call
// site, not this comment.
export const attributionV1ShadowEnabled = (): boolean =>
  process.env[ATTRIBUTION_V1_SHADOW_ENV] !== '0';

// Compact per-resolve comparison record. Deliberately small: the incumbent
// and v1 top workstream ids, the v1 action, and whether they agree. `ts` is
// the record time (ms). No page content, no title text — audit-log-clean.
export interface AttributionV1ShadowRecord {
  readonly url: string;
  readonly ts: number;
  // Incumbent's chosen workstream (its decision target) or null when the
  // incumbent abstained (inbox / no candidate).
  readonly incumbentTop: string | null;
  // v1's top-ranked workstream or null when v1 abstained.
  readonly v1Top: string | null;
  readonly v1Action: AttributionV1Action;
  // True when both name the same non-null workstream, OR both abstain
  // (null == null) — the honest "they made the same call" definition.
  readonly agree: boolean;
}

// Bounded ring buffer of recent shadow records. Drain flushes + clears it.
// The cap bounds memory between drains (a busy resolve burst can't grow it
// without bound); overflow drops the OLDEST record (a shadow miss is
// acceptable — this is observability).
const SHADOW_BUFFER_CAP = 2000;
let shadowBuffer: AttributionV1ShadowRecord[] = [];

// Sibling of the other v1 files under system/. Bounded by drain-time
// truncation (drainFlush caps the on-disk tail).
const ATTRIBUTION_V1_SHADOW_LOG_RELATIVE_PATH = '_BAC/system/attribution-v1-shadow.jsonl';

// Max records retained on disk after a flush. The flusher rewrites the file
// with the newest SHADOW_LOG_MAX_LINES so the log can't grow unbounded
// across many drains.
export const ATTRIBUTION_V1_SHADOW_LOG_MAX_LINES = 20000;

export const attributionV1ShadowLogPath = (vaultRoot: string): string =>
  join(vaultRoot, ATTRIBUTION_V1_SHADOW_LOG_RELATIVE_PATH);

// Compute the compact record from the incumbent's decided workstream and
// the v1 result. `incumbentTop` is the incumbent decision's target
// workstream (or null when it abstained). Pure — no I/O, no clock (caller
// supplies ts) — so it's unit-testable.
export const buildShadowRecord = (input: {
  readonly url: string;
  readonly ts: number;
  readonly incumbentTop: string | null;
  readonly v1: AttributionV1Result;
}): AttributionV1ShadowRecord => {
  const v1Top =
    input.v1.action === 'abstain' || input.v1.candidates.length === 0
      ? null
      : input.v1.candidates[0]!.workstreamId;
  const agree = input.incumbentTop === v1Top;
  return {
    url: input.url,
    ts: input.ts,
    incumbentTop: input.incumbentTop,
    v1Top,
    v1Action: input.v1.action,
    agree,
  };
};

// Push a record into the in-process buffer (O(1), allocation-only — safe on
// the serve path). Drops the oldest when at cap.
export const recordShadowObservation = (record: AttributionV1ShadowRecord): void => {
  shadowBuffer.push(record);
  if (shadowBuffer.length > SHADOW_BUFFER_CAP) {
    shadowBuffer = shadowBuffer.slice(shadowBuffer.length - SHADOW_BUFFER_CAP);
  }
};

// Test/inspection helpers. `drainShadowBuffer` returns and CLEARS the
// buffered records (the drain flusher's source).
export const drainShadowBuffer = (): readonly AttributionV1ShadowRecord[] => {
  const out = shadowBuffer;
  shadowBuffer = [];
  return out;
};

export const peekShadowBufferSize = (): number => shadowBuffer.length;

export const resetShadowBufferForTest = (): void => {
  shadowBuffer = [];
};

// Drain-time flush: append the buffered records to the JSONL log and
// truncate the on-disk tail to ATTRIBUTION_V1_SHADOW_LOG_MAX_LINES. Called
// from the connections drain hook. Best-effort: any I/O failure is
// swallowed by the caller — observability must never surface as a drain
// failure. Returns the number of records flushed.
export const flushShadowBuffer = async (vaultRoot: string): Promise<number> => {
  const records = drainShadowBuffer();
  if (records.length === 0) return 0;
  const path = attributionV1ShadowLogPath(vaultRoot);
  await mkdir(dirname(path), { recursive: true });
  const appended = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  await appendFile(path, appended, 'utf8');
  // Truncate the tail: rewrite with the newest MAX_LINES so the log is
  // bounded. Cheap because the log is small (bounded by MAX_LINES already).
  await truncateShadowLog(path);
  return records.length;
};

const truncateShadowLog = async (path: string): Promise<void> => {
  const body = await readFile(path, 'utf8').catch(() => '');
  if (body.length === 0) return;
  const lines = body.split('\n').filter((line) => line.length > 0);
  if (lines.length <= ATTRIBUTION_V1_SHADOW_LOG_MAX_LINES) return;
  const kept = lines.slice(lines.length - ATTRIBUTION_V1_SHADOW_LOG_MAX_LINES);
  const { writeFile, rename } = await import('node:fs/promises');
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, kept.join('\n') + '\n', 'utf8');
  await rename(tmp, path);
};

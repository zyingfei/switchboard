// Lane prequential — measure what every guess lane actually gets right.
//
// THE GAP (review §G1/G3, enhancement E1 — "the keystone"). Eight guess lanes
// disclose an opinion on every resolve and NONE of them feeds the decision.
// The stated reason is sound (lanes are query-time, fusion is cached) but the
// unstated one is worse: nobody knows how good they are. There is no number.
// The live Kimi case — six structural lanes empty, content + ai both naming the
// right workstream, decision `held: corroboration 1 < 2` — is unarguable only
// because a human looked at it. To let lane agreement COUNT, the system first
// has to be able to say "the content lane has been right 41 times out of 57".
//
// PREQUENTIAL DISCIPLINE (test-then-train, the same rule
// attribution-v1/eval/prequential.ts replays offline, applied here to LIVE
// serving):
//   1. On every batch-resolve, write down each lane's top pick for the URL,
//      with a timestamp. That is the PREDICTION, made before the answer exists.
//   2. When the user later files that URL (USER_ORGANIZED_ITEM), the filing is
//      the ANSWER. A prediction is scored against the FIRST filing strictly
//      after it; a prediction with no subsequent filing is unscored, not a miss.
//   3. Precision@1 per lane = hits / scored.
// Nothing here can peek: the prediction is on disk with its timestamp before
// the label exists, so the join cannot be gamed by a later re-resolve.
//
// LAZY JOIN, NO WATCHER. The scoring is a fold over (JSONL ∪ organized-item
// events) computed at READ time. A live watcher joining predictions to filings
// as they land would need its own durability story, its own restart semantics,
// and a second source of truth for a number that is trivially recomputable from
// two append-only logs. Reading is rare (health, the promotion's self-gate),
// writing is per-resolve — so the cost belongs on the read.
//
// DEDUPE IS LOAD-BEARING. The panel re-resolves the focused tab continuously;
// one page can produce dozens of identical predictions before the user files
// it. Counting each would make precision a measure of how often the panel
// polled. Only the LATEST prediction per (url, lane) before a given filing is
// scored — one prediction, one label, one outcome.
//
// A DECLINE IS A MISS. "Not in any stream" (toContainer null) scores every
// lane that named a workstream as wrong. That is the honest reading for the
// consumer this feeds: the promotion decides whether to SURFACE a lane pick,
// and a page the user refused to file is a page where surfacing was wrong.

import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { USER_ORGANIZED_ITEM, isUserOrganizedItemPayload } from '../feedback/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { getCaughtUpSharedEventStore } from '../sync/eventStore.js';
import type { GuessLane, GuessLaneResult } from './guessLanes.js';

// ---- env flag ---------------------------------------------------------

export const LANE_PREQUENTIAL_ENV = 'SIDETRACK_LANE_PREQUENTIAL';

// Default ON. This is an OBSERVATION lane: it appends a few hundred bytes per
// resolve and changes no served value. The promotion that consumes it
// (laneCorroboration.ts) is the part that is default OFF. Only an explicit
// '0' / 'false' disables — same parse as SIDETRACK_GUESS_LANES.
export const lanePrequentialEnabled = (): boolean => {
  const raw = process.env[LANE_PREQUENTIAL_ENV];
  return raw !== '0' && raw !== 'false';
};

// ---- on-disk contract --------------------------------------------------

/** `<vault>/_BAC/eval/lane-prequential.jsonl` — the live prediction log. */
export const lanePrequentialPath = (vaultRoot: string): string =>
  join(vaultRoot, '_BAC', 'eval', 'lane-prequential.jsonl');

/** The single rotated generation. See ROTATE_AT_BYTES. */
export const lanePrequentialRotatedPath = (vaultRoot: string): string =>
  `${lanePrequentialPath(vaultRoot)}.1`;

// Rotate at 4 MB. At ~70 bytes/line and up to 8 lines per resolved URL, that is
// on the order of 7,500 resolved URLs' worth of predictions — comfortably more
// than the 500-scored trailing window needs, and small enough that the summary
// fold stays a sub-100ms file read. ONE rotated generation is kept and IS read
// by the summary, so a rotation never zeroes the window mid-measurement.
const ROTATE_AT_BYTES = 4 * 1024 * 1024;

/**
 * One prediction line. Keys are one character because this file has one line
 * per lane per resolve and the field names would otherwise be most of it.
 *   u = canonicalUrl, l = lane id, w = predicted workstreamId, t = epoch ms
 *
 * Exported so the scorer's signature is nameable (and testable) without
 * re-declaring the on-disk contract in two places.
 */
export interface LanePredictionRecord {
  readonly u: string;
  readonly l: string;
  readonly w: string;
  readonly t: number;
}

const isLaneRecord = (value: unknown): value is LanePredictionRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['u'] === 'string' &&
    record['u'].length > 0 &&
    typeof record['l'] === 'string' &&
    record['l'].length > 0 &&
    typeof record['w'] === 'string' &&
    record['w'].length > 0 &&
    typeof record['t'] === 'number' &&
    Number.isFinite(record['t'])
  );
};

// ---- the writer --------------------------------------------------------

export interface LanePredictionInput {
  readonly canonicalUrl: string;
  readonly lanes: readonly GuessLaneResult[] | undefined;
}

/**
 * Append every lane's TOP pick for each resolved URL, as one write.
 *
 * Batched deliberately: a batch-resolve serves up to a few dozen URLs, and one
 * append of N lines is one syscall instead of N. Best-effort by contract —
 * the caller fires this without awaiting on the response path and a failure
 * costs a measurement, never a resolve.
 *
 * A lane with no candidates writes nothing: typed emptiness is not a
 * prediction, and scoring an abstention as a miss would punish the lanes that
 * are honest about having no view.
 *
 * Returns the number of lines appended (0 when disabled / nothing to say), so
 * tests and diagnostics can assert on it.
 */
export const recordLanePredictions = async (
  vaultRoot: string,
  entries: readonly LanePredictionInput[],
  nowMs: number = Date.now(),
): Promise<number> => {
  if (!lanePrequentialEnabled()) return 0;
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.lanes === undefined) continue;
    for (const lane of entry.lanes) {
      const top = lane.candidates[0];
      if (top === undefined || top.workstreamId.length === 0) continue;
      const record: LanePredictionRecord = {
        u: entry.canonicalUrl,
        l: lane.lane,
        w: top.workstreamId,
        t: nowMs,
      };
      lines.push(JSON.stringify(record));
    }
  }
  if (lines.length === 0) return 0;
  const path = lanePrequentialPath(vaultRoot);
  await mkdir(join(vaultRoot, '_BAC', 'eval'), { recursive: true });
  // Rotate BEFORE appending so the cap is a real ceiling on the live file
  // rather than "the cap plus whatever the last batch happened to be".
  const info = await stat(path).catch(() => null);
  if (info !== null && info.size >= ROTATE_AT_BYTES) {
    await rename(path, lanePrequentialRotatedPath(vaultRoot)).catch(() => undefined);
  }
  await appendFile(path, `${lines.join('\n')}\n`, 'utf8');
  return lines.length;
};

// ---- the reader --------------------------------------------------------

const readRecords = async (path: string): Promise<readonly LanePredictionRecord[]> => {
  const handle = await open(path, 'r').catch(() => null);
  if (handle === null) return [];
  try {
    const text = await handle.readFile('utf8');
    const out: LanePredictionRecord[] = [];
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A torn last line (the writer was interrupted mid-append) is the one
        // corruption this format can produce. Skip it; a measurement must not
        // be able to throw into a health probe or a resolve.
        continue;
      }
      if (isLaneRecord(parsed)) out.push(parsed);
    }
    return out;
  } finally {
    await handle.close().catch(() => undefined);
  }
};

/**
 * A user filing, time-ordered. `workstreamId === null` is the "not in any
 * stream" decline — a real answer (and a miss for every lane), not an absence.
 */
export interface LaneFiling {
  readonly canonicalUrl: string;
  readonly workstreamId: string | null;
  readonly atMs: number;
}

// Time-ordered filings for the join. Deliberately a DIFFERENT projection from
// declineMemory.ts's fold over the same event type: that one collapses to
// latest-per-url ("is this URL declined right now?"), this one keeps the full
// ordered stream ("what answer came next after this prediction?"). Two folds,
// one event family — sharing a projection would force one of them to lie.
const foldFilings = (events: readonly AcceptedEvent[]): readonly LaneFiling[] => {
  const filings: LaneFiling[] = [];
  for (const event of events) {
    if (event.type !== USER_ORGANIZED_ITEM || !isUserOrganizedItemPayload(event.payload)) continue;
    const payload = event.payload;
    if (payload.itemKind !== 'canonical-url' || payload.action !== 'move') continue;
    filings.push({
      canonicalUrl: payload.itemId,
      workstreamId: payload.toContainer ?? null,
      atMs: event.acceptedAtMs,
    });
  }
  return filings.sort((left, right) => left.atMs - right.atMs);
};

// Typed read via events_type_idx — never the untyped full scan (the 45s-timeout
// shape this repo has fixed repeatedly).
const readFilingEvents = async (vaultRoot: string): Promise<readonly AcceptedEvent[]> => {
  const store = await getCaughtUpSharedEventStore(vaultRoot);
  if (store === null) return [];
  const events: AcceptedEvent[] = [];
  await store.forEachChunkOfTypes(
    [USER_ORGANIZED_ITEM],
    (chunk) => {
      for (const event of chunk) events.push(event);
    },
    2000,
  );
  return events;
};

// ---- scoring -----------------------------------------------------------

/** Per-lane precision@1 over the trailing scored window. */
export interface LanePrecision {
  readonly lane: string;
  /** Scored predictions (a prediction followed by a filing). */
  readonly n: number;
  readonly hits: number;
  /** hits / n, or null when n === 0 — never a fabricated 0.0. */
  readonly precision: number | null;
}

export interface LanePrequentialSummary {
  /** Total scored (prediction, filing) pairs in the window, across all lanes. */
  readonly scored: number;
  /** The trailing-window cap that produced it. */
  readonly window: number;
  /** Predictions on disk that no filing has answered yet — honest, not a miss. */
  readonly unscored: number;
  readonly lanes: readonly LanePrecision[];
  /** 'off' when the flag is disabled, else 'ok'. Typed emptiness for a reader. */
  readonly status: 'ok' | 'off';
}

// The trailing window, in SCORED pairs. Bounded so precision tracks recent
// behavior (lane implementations change under it — the hub guard landed on
// 2026-07-28 and materially altered what content/ai vote for) rather than
// averaging over every generation of the code that ever ran.
export const LANE_PREQUENTIAL_WINDOW = 500;

export const EMPTY_LANE_PREQUENTIAL_SUMMARY: LanePrequentialSummary = {
  scored: 0,
  window: LANE_PREQUENTIAL_WINDOW,
  unscored: 0,
  lanes: [],
  status: 'ok',
};

/**
 * Join predictions to filings and score them. Pure — the I/O is the caller's.
 *
 * The join, stated precisely:
 *   - group predictions by (url, lane), ascending by t;
 *   - walk the url's filings ascending; each filing consumes the LATEST
 *     prediction strictly before it that has not already been scored;
 *   - hit iff the filing's workstreamId equals the prediction's;
 *   - a decline (workstreamId null) is a miss;
 *   - predictions after the last filing stay unscored.
 */
export const scoreLanePredictions = (
  records: readonly LanePredictionRecord[],
  filings: readonly LaneFiling[],
  window: number = LANE_PREQUENTIAL_WINDOW,
): LanePrequentialSummary => {
  const filingsByUrl = new Map<string, LaneFiling[]>();
  for (const filing of filings) {
    const list = filingsByUrl.get(filing.canonicalUrl);
    if (list === undefined) filingsByUrl.set(filing.canonicalUrl, [filing]);
    else list.push(filing);
  }
  // url -> lane -> the predictions for it, ascending in time. NESTED rather
  // than a joined "url|lane" string key: canonical URLs can contain any
  // separator character you might pick, and a key collision here would silently
  // merge two lanes' records into one precision number.
  const byUrl = new Map<string, Map<string, LanePredictionRecord[]>>();
  for (const record of records) {
    let byLane = byUrl.get(record.u);
    if (byLane === undefined) {
      byLane = new Map<string, LanePredictionRecord[]>();
      byUrl.set(record.u, byLane);
    }
    const list = byLane.get(record.l);
    if (list === undefined) byLane.set(record.l, [record]);
    else list.push(record);
  }

  interface Scored {
    readonly lane: string;
    readonly hit: boolean;
    readonly atMs: number;
  }
  const scored: Scored[] = [];
  let unscored = 0;

  for (const [url, byLane] of byUrl) {
    const urlFilings = filingsByUrl.get(url) ?? [];
    for (const predictions of byLane.values()) {
      predictions.sort((left, right) => left.t - right.t);
      let cursor = 0; // first prediction not yet consumed
      for (const filing of urlFilings) {
        // The LATEST unconsumed prediction strictly before this filing.
        let chosen = -1;
        let index = cursor;
        while (index < predictions.length && predictions[index]!.t < filing.atMs) {
          chosen = index;
          index += 1;
        }
        if (chosen < 0) continue;
        const prediction = predictions[chosen]!;
        scored.push({
          lane: prediction.l,
          hit: filing.workstreamId !== null && filing.workstreamId === prediction.w,
          atMs: filing.atMs,
        });
        // Everything up to and including `chosen` is spent: the superseded
        // re-resolves were the same prediction restated, and a later filing must
        // not re-score them.
        cursor = chosen + 1;
      }
      unscored += predictions.length - cursor;
    }
  }

  // Trailing window by ANSWER time — the newest `window` scored pairs.
  scored.sort((left, right) => left.atMs - right.atMs);
  const windowed = scored.slice(Math.max(0, scored.length - window));

  const perLane = new Map<string, { n: number; hits: number }>();
  for (const item of windowed) {
    const agg = perLane.get(item.lane) ?? { n: 0, hits: 0 };
    agg.n += 1;
    if (item.hit) agg.hits += 1;
    perLane.set(item.lane, agg);
  }
  const lanes: LanePrecision[] = [...perLane.entries()]
    .map(([lane, agg]) => ({
      lane,
      n: agg.n,
      hits: agg.hits,
      precision: agg.n === 0 ? null : agg.hits / agg.n,
    }))
    .sort((left, right) =>
      right.n !== left.n ? right.n - left.n : left.lane < right.lane ? -1 : 1,
    );

  return {
    scored: windowed.length,
    window,
    unscored,
    lanes,
    status: 'ok',
  };
};

// ---- memoized summary --------------------------------------------------

interface MemoizedSummary {
  readonly vaultRoot: string;
  readonly signature: string;
  readonly summary: LanePrequentialSummary;
}

let memoized: MemoizedSummary | null = null;

// Cache key: size + mtime of both prediction generations. Cheap (two stats) and
// it moves whenever a prediction is appended — which, on an active companion,
// is every batch-resolve. KNOWN LIMIT, stated rather than hidden: a filing that
// lands with NO subsequent prediction append does not bust this key, so the
// summary can lag one filing behind. The consumer is a promotion gate keyed on
// n>=20 — a one-label lag cannot flip it, and the next resolve refreshes it.
const summarySignature = async (vaultRoot: string): Promise<string> => {
  const [live, rotated] = await Promise.all([
    stat(lanePrequentialPath(vaultRoot)).catch(() => null),
    stat(lanePrequentialRotatedPath(vaultRoot)).catch(() => null),
  ]);
  const token = (info: { size: number; mtimeMs: number } | null): string =>
    info === null ? 'none' : `${String(info.size)}:${String(Math.round(info.mtimeMs))}`;
  return `${token(live)}|${token(rotated)}`;
};

/**
 * Per-lane {n, hits, precision} over the trailing window, memoized on the
 * prediction files' size+mtime.
 *
 * Never throws: any read failure degrades to the empty summary, because both
 * consumers (the health surface and the promotion's self-gate) must treat "no
 * measurement" as "no promotion", not as an error.
 */
export const lanePrequentialSummary = async (
  vaultRoot: string,
  window: number = LANE_PREQUENTIAL_WINDOW,
): Promise<LanePrequentialSummary> => {
  if (!lanePrequentialEnabled()) {
    return { ...EMPTY_LANE_PREQUENTIAL_SUMMARY, window, status: 'off' };
  }
  const signature = await summarySignature(vaultRoot).catch(() => 'unavailable');
  if (memoized !== null && memoized.vaultRoot === vaultRoot && memoized.signature === signature) {
    return memoized.summary;
  }
  const summary = await (async (): Promise<LanePrequentialSummary> => {
    // Rotated generation first so the merged stream is roughly time-ordered
    // before the per-key sorts (which do not depend on it, but a near-sorted
    // input keeps them cheap).
    const [rotated, live, events] = await Promise.all([
      readRecords(lanePrequentialRotatedPath(vaultRoot)),
      readRecords(lanePrequentialPath(vaultRoot)),
      readFilingEvents(vaultRoot).catch(() => [] as readonly AcceptedEvent[]),
    ]);
    return scoreLanePredictions([...rotated, ...live], foldFilings(events), window);
  })().catch(() => ({ ...EMPTY_LANE_PREQUENTIAL_SUMMARY, window }));
  memoized = { vaultRoot, signature, summary };
  return summary;
};

/** The measured precision for one lane, or null when it has no window rows. */
export const lanePrecisionFrom = (
  summary: LanePrequentialSummary,
  lane: GuessLane,
): LanePrecision | null => summary.lanes.find((entry) => entry.lane === lane) ?? null;

export const resetLanePrequentialMemoForTest = (): void => {
  memoized = null;
};

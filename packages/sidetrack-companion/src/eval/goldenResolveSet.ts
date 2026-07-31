// Golden resolve set — replay the user's own filings against the live resolver.
//
// THE GAP (review §G9, enhancement E8). "Resolve *plumbing* is well-tested;
// resolve *quality* is not. The Binance mis-ranking, the false-friend, the
// hub-magnet class — each was caught by a human eyeball on a live page. A
// frozen set of (page → correct workstream) cases would have caught all three
// mechanically."
//
// This is that set, built from the only ground truth that exists: the user's
// own USER_ORGANIZED_ITEM filings. Every filing is a labelled example — "this
// page belongs in that workstream" — asserted by the person the system serves.
// The harness takes up to 200 of them, asks the IN-PROCESS resolver what it
// would have said, and reports precision@1 for fusion and for every lane.
//
// WHY THIS FILE IS A SCRIPT AND ITS OUTPUT IS NOT COMMITTED. The pairs are the
// user's real browsing history. The committed, CI-runnable half of E8 is
// `goldenResolveCases.test.ts` — the four failure CLASSES reduced to synthetic
// fixtures. This half runs locally, against a real vault, and writes its report
// under the vault (never the repo).
//
// READ-ONLY, AND NOT OVER THE WIRE. It imports the resolver directly rather
// than calling the running companion: the point is to measure the decision
// function, and going through HTTP would measure the cache, the SWR lane and
// whatever the panel last asked for instead. It reads the event log from disk
// (the same reader attribution-v1/eval/cli.ts uses) and the connections
// snapshot from `_BAC/connections/current.json`, falling back to the store's
// own readCurrent. It writes exactly one file: the report.
//
// WHAT IT DOES *NOT* MEASURE, stated so the number is not over-read. Lanes 7
// ('content') and 8 ('ai') are query-time retrieval against the recall-v2 store
// with a loaded embedder; neither exists in this standalone process, so those
// two lanes are absent from the offline scores. They ARE measured — on the live
// serving path, prequentially, by tabsession/lanePrequential.ts — and this
// harness prints that summary alongside its own so both halves are visible in
// one place.
//
// PREQUENTIAL IT IS NOT. The resolver here sees the CURRENT graph, including
// the filing being scored and every filing after it. That is a deliberate
// tradeoff: this is a REGRESSION net (did a code change make the ranking
// worse?), and it answers that question well because the leakage is identical
// across runs. It is NOT a forecast of live accuracy — the time-ordered,
// no-peeking measurement is attribution-v1/eval/prequential.ts. Do not quote
// this number as "how often Sidetrack is right".

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { USER_ORGANIZED_ITEM, isUserOrganizedItemPayload } from '../feedback/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { ConnectionsSnapshot } from '../connections/types.js';
import type { GuessLaneResult } from '../tabsession/guessLanes.js';
import { lanePrequentialSummary, type LanePrequentialSummary } from '../tabsession/lanePrequential.js';
import type { UrlResolutionResult } from '../tabsession/resolver.js';

// ---- configuration -----------------------------------------------------

/** Default vault when neither --vault nor SIDETRACK_VAULT is given. */
export const DEFAULT_GOLDEN_VAULT_ENV = 'SIDETRACK_VAULT';

export const defaultGoldenVaultRoot = (
  env: Record<string, string | undefined> = process.env,
): string => {
  const fromEnv = env[DEFAULT_GOLDEN_VAULT_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  // The dogfood TEST vault, deliberately — never the live one by default.
  return join(env['HOME'] ?? '.', '.sidetrack-vault-test');
};

/** Cap on scored pairs. 200 is the review's number (E8: "~200 historical"). */
export const GOLDEN_SET_MAX_PAIRS = 200;

export const goldenReportPath = (vaultRoot: string): string =>
  join(vaultRoot, '_BAC', 'eval', 'golden-resolve-set.json');

// ---- pair extraction ---------------------------------------------------

export interface GoldenPair {
  readonly canonicalUrl: string;
  readonly workstreamId: string;
  readonly atMs: number;
}

/**
 * The (canonicalUrl → workstreamId) ground truth, newest first, capped.
 *
 * Same supervised-label definition the attribution study and the resolver use:
 * `itemKind: 'canonical-url'` + `action: 'move'`. LATEST-WINS per URL, so a
 * page filed, re-filed and re-filed again contributes ONE pair carrying the
 * user's final answer — not three, two of which the user has since overruled.
 *
 * Declines (`toContainer: null`) are EXCLUDED. They are real labels, but they
 * are a different question ("should this be suggested at all?") than the one
 * precision@1 answers ("of the workstreams, which one?"), and mixing them
 * would make a system that abstains perfectly look inaccurate.
 *
 * Newest-first so the cap keeps the most RECENT filings: the graph the resolver
 * sees is the current one, and the newest labels are the ones whose evidence it
 * most plausibly has.
 */
export const extractGoldenPairs = (
  events: readonly AcceptedEvent[],
  limit: number = GOLDEN_SET_MAX_PAIRS,
): readonly GoldenPair[] => {
  const latest = new Map<string, { workstreamId: string | null; atMs: number; seq: number }>();
  for (const event of events) {
    if (event.type !== USER_ORGANIZED_ITEM || !isUserOrganizedItemPayload(event.payload)) continue;
    const payload = event.payload;
    if (payload.itemKind !== 'canonical-url' || payload.action !== 'move') continue;
    const incumbent = latest.get(payload.itemId);
    const atMs = event.acceptedAtMs;
    const seq = event.dot.seq;
    if (
      incumbent === undefined ||
      atMs > incumbent.atMs ||
      (atMs === incumbent.atMs && seq > incumbent.seq)
    ) {
      latest.set(payload.itemId, { workstreamId: payload.toContainer ?? null, atMs, seq });
    }
  }
  const pairs: GoldenPair[] = [];
  for (const [canonicalUrl, entry] of latest) {
    if (entry.workstreamId === null) continue;
    pairs.push({ canonicalUrl, workstreamId: entry.workstreamId, atMs: entry.atMs });
  }
  return pairs.sort((left, right) => right.atMs - left.atMs).slice(0, limit);
};

// ---- scoring -----------------------------------------------------------

/** One replayed pair: what the resolver said vs. what the user did. */
export interface GoldenRow {
  readonly canonicalUrl: string;
  readonly expected: string;
  /** Fusion's top candidate, or null when nothing reached fusion. */
  readonly fusionTop: string | null;
  readonly action: string;
  readonly gateReason: string | null;
  /** Each lane's top pick (absent lanes and typed-empty lanes are omitted). */
  readonly laneTops: Readonly<Record<string, string>>;
}

export interface GoldenArmScore {
  readonly arm: string;
  /** Pairs where this arm named ANY workstream. */
  readonly answered: number;
  readonly hits: number;
  /** hits / answered — null when the arm never answered. */
  readonly precision: number | null;
  /** hits / total pairs: precision weighted by how often it speaks at all. */
  readonly coverage: number;
}

export interface GoldenRunResult {
  readonly vaultRoot: string;
  readonly generatedAt: string;
  readonly pairs: number;
  readonly fusion: GoldenArmScore;
  readonly lanes: readonly GoldenArmScore[];
  /** Distribution of gate reasons over the replayed set — where picks die. */
  readonly gateReasons: Readonly<Record<string, number>>;
  /** The LIVE prequential numbers, which do include lanes 7/8. */
  readonly livePrequential: LanePrequentialSummary | null;
  readonly rows: readonly GoldenRow[];
}

const scoreArm = (
  arm: string,
  rows: readonly GoldenRow[],
  pick: (row: GoldenRow) => string | null,
): GoldenArmScore => {
  let answered = 0;
  let hits = 0;
  for (const row of rows) {
    const predicted = pick(row);
    if (predicted === null) continue;
    answered += 1;
    if (predicted === row.expected) hits += 1;
  }
  return {
    arm,
    answered,
    hits,
    precision: answered === 0 ? null : hits / answered,
    coverage: rows.length === 0 ? 0 : hits / rows.length,
  };
};

/** Aggregate replayed rows into per-arm scores. Pure. */
export const scoreGoldenRows = (
  rows: readonly GoldenRow[],
  vaultRoot: string,
  generatedAt: string,
  livePrequential: LanePrequentialSummary | null = null,
): GoldenRunResult => {
  const laneIds = new Set<string>();
  const gateReasons: Record<string, number> = {};
  for (const row of rows) {
    for (const lane of Object.keys(row.laneTops)) laneIds.add(lane);
    const reason = row.gateReason ?? 'none';
    gateReasons[reason] = (gateReasons[reason] ?? 0) + 1;
  }
  return {
    vaultRoot,
    generatedAt,
    pairs: rows.length,
    fusion: scoreArm('fusion', rows, (row) => row.fusionTop),
    lanes: [...laneIds]
      .sort()
      .map((lane) => scoreArm(lane, rows, (row) => row.laneTops[lane] ?? null)),
    gateReasons,
    livePrequential,
    rows,
  };
};

/** The top pick of each populated lane, keyed by lane id. */
export const laneTopsOf = (
  lanes: readonly GuessLaneResult[] | undefined,
): Readonly<Record<string, string>> => {
  const tops: Record<string, string> = {};
  if (lanes === undefined) return tops;
  for (const lane of lanes) {
    const top = lane.candidates[0];
    if (top === undefined || top.workstreamId.length === 0) continue;
    tops[lane.lane] = top.workstreamId;
  }
  return tops;
};

export const rowFromResolution = (
  pair: GoldenPair,
  result: UrlResolutionResult,
): GoldenRow => ({
  canonicalUrl: pair.canonicalUrl,
  expected: pair.workstreamId,
  fusionTop: result.fusedCandidates[0]?.workstreamId ?? null,
  action: result.decision.action,
  gateReason: result.decision.gate?.reason ?? null,
  laneTops: laneTopsOf(result.lanes),
});

// ---- report formatting -------------------------------------------------

const pct = (value: number | null): string =>
  value === null ? '   —  ' : `${(value * 100).toFixed(1).padStart(5)}%`;

/**
 * A compact fixed-width table. Deliberately plain text: this is read in a
 * terminal next to a code change, and the question it must answer at a glance
 * is "did the number move?".
 */
export const formatGoldenReport = (result: GoldenRunResult): string => {
  const lines: string[] = [];
  lines.push(`golden resolve set — ${result.vaultRoot}`);
  lines.push(`generated ${result.generatedAt} · ${String(result.pairs)} labelled pairs`);
  lines.push('');
  lines.push('  arm             answered   hits   precision@1   coverage');
  lines.push('  ────────────────────────────────────────────────────────');
  const row = (score: GoldenArmScore): string =>
    `  ${score.arm.padEnd(14)} ${String(score.answered).padStart(8)} ${String(score.hits).padStart(6)}` +
    `   ${pct(score.precision)}      ${pct(score.coverage)}`;
  lines.push(row(result.fusion));
  for (const lane of result.lanes) lines.push(row(lane));
  lines.push('');
  lines.push('  gate reasons (where picks die)');
  const reasons = Object.entries(result.gateReasons).sort((left, right) => right[1] - left[1]);
  if (reasons.length === 0) lines.push('    (none)');
  for (const [reason, count] of reasons) {
    lines.push(`    ${reason.padEnd(18)} ${String(count).padStart(4)}`);
  }
  lines.push('');
  // The live half — lanes 7/8, which this offline harness cannot compute.
  lines.push('  live prequential (serving path — includes lanes content + ai)');
  const live = result.livePrequential;
  if (live === null || live.status !== 'ok') {
    lines.push('    unavailable (measurement off, or no predictions recorded yet)');
  } else {
    lines.push(
      `    delivery rows=${String(live.rawPredictionRows)} · opportunities=${String(live.eligibleOpportunities)}` +
        ` · outcome join=${String(live.outcomesJoined)}/${String(live.outcomesObserved)}`,
    );
  }
  if (live !== null && live.status === 'ok' && live.lanes.length === 0) {
    lines.push(
      `    no scored predictions yet · ${String(live.unscored)} awaiting a filing to score against`,
    );
  } else if (live !== null && live.status === 'ok') {
    for (const lane of live.lanes) {
      lines.push(
        `    ${lane.lane.padEnd(14)} n=${String(lane.n).padStart(4)}  p=${pct(lane.precision)}`,
      );
    }
  }
  lines.push('');
  lines.push('  NOTE: this replay sees the CURRENT graph, including the labels it scores.');
  lines.push('  It is a regression net, not a forecast. For the no-peeking number run');
  lines.push('  `sidetrack-companion eval --vault <path>` (attribution prequential).');
  return lines.join('\n');
};

// ---- vault loading (read-only) -----------------------------------------

/** The merged event log, read from disk without a running companion. */
export const readVaultEvents = async (vaultRoot: string): Promise<readonly AcceptedEvent[]> => {
  const { createEventLog } = await import('../sync/eventLog.js');
  const { loadOrCreateReplica } = await import('../sync/replicaId.js');
  const replica = await loadOrCreateReplica(vaultRoot);
  return await createEventLog(vaultRoot, replica).readMerged();
};

/**
 * The connections snapshot. Tries the plain JSON publication first (a pure
 * read that cannot touch a running companion's sqlite), then the configured
 * store's own readCurrent.
 */
export const readVaultSnapshot = async (
  vaultRoot: string,
): Promise<ConnectionsSnapshot | null> => {
  const jsonPath = join(vaultRoot, '_BAC', 'connections', 'current.json');
  try {
    const text = await readFile(jsonPath, 'utf8');
    const parsed = JSON.parse(text) as ConnectionsSnapshot;
    if (Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) return parsed;
  } catch {
    // Fall through to the store.
  }
  try {
    const { createConnectionsStore } = await import('../connections/snapshot.js');
    return await createConnectionsStore(vaultRoot).readCurrent();
  } catch {
    return null;
  }
};

// ---- the run -----------------------------------------------------------

export interface GoldenRunOptions {
  readonly vaultRoot?: string;
  readonly limit?: number;
  /** When false the report is computed and returned but not written. */
  readonly persist?: boolean;
  readonly now?: () => Date;
  /** Injectable for tests. */
  readonly readEvents?: (vaultRoot: string) => Promise<readonly AcceptedEvent[]>;
  readonly readSnapshot?: (vaultRoot: string) => Promise<ConnectionsSnapshot | null>;
  readonly resolve?: (
    vaultRoot: string,
    pair: GoldenPair,
    snapshot: ConnectionsSnapshot,
    events: readonly AcceptedEvent[],
  ) => Promise<UrlResolutionResult>;
}

const defaultResolve = async (
  vaultRoot: string,
  pair: GoldenPair,
  snapshot: ConnectionsSnapshot,
  events: readonly AcceptedEvent[],
): Promise<UrlResolutionResult> => {
  const { resolveUrlAttributionArmed } = await import('../attribution-v1/armedResolve.js');
  return await resolveUrlAttributionArmed({
    vaultRoot,
    canonicalUrl: pair.canonicalUrl,
    snapshot,
    events,
  });
};

export const runGoldenResolveSet = async (
  options: GoldenRunOptions = {},
): Promise<GoldenRunResult> => {
  const vaultRoot = options.vaultRoot ?? defaultGoldenVaultRoot();
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const readEvents = options.readEvents ?? readVaultEvents;
  const readSnapshot = options.readSnapshot ?? readVaultSnapshot;
  const resolve = options.resolve ?? defaultResolve;

  const events = await readEvents(vaultRoot);
  const pairs = extractGoldenPairs(events, options.limit ?? GOLDEN_SET_MAX_PAIRS);
  const snapshot = await readSnapshot(vaultRoot);
  if (snapshot === null) {
    throw new Error(
      `No connections snapshot under ${vaultRoot}. Run a drain (or start the companion once) first.`,
    );
  }

  const rows: GoldenRow[] = [];
  for (const pair of pairs) {
    try {
      rows.push(rowFromResolution(pair, await resolve(vaultRoot, pair, snapshot, events)));
    } catch {
      // One unresolvable URL must not lose the whole run. It is recorded as an
      // abstention (no fusion pick, no lanes), which is what the user would
      // have seen.
      rows.push({
        canonicalUrl: pair.canonicalUrl,
        expected: pair.workstreamId,
        fusionTop: null,
        action: 'inbox',
        gateReason: 'resolve-failed',
        laneTops: {},
      });
    }
  }

  const livePrequential = await lanePrequentialSummary(vaultRoot).catch(() => null);
  const result = scoreGoldenRows(rows, vaultRoot, generatedAt, livePrequential);
  if (options.persist !== false) {
    await mkdir(join(vaultRoot, '_BAC', 'eval'), { recursive: true });
    await writeFile(goldenReportPath(vaultRoot), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  return result;
};

// ---- CLI ---------------------------------------------------------------

export const parseGoldenArgs = (argv: readonly string[]): GoldenRunOptions => {
  const options: { vaultRoot?: string; limit?: number; persist?: boolean } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--vault' && value !== undefined) {
      options.vaultRoot = value;
      index += 1;
    } else if (arg === '--limit' && value !== undefined) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) options.limit = Math.floor(parsed);
      index += 1;
    } else if (arg === '--no-persist') {
      options.persist = false;
    }
  }
  return options;
};

export const goldenResolveSetMain = async (
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> => {
  const options = parseGoldenArgs(argv);
  const result = await runGoldenResolveSet(options);
  process.stdout.write(`${formatGoldenReport(result)}\n`);
  if (options.persist !== false) {
    process.stdout.write(`\nreport → ${goldenReportPath(result.vaultRoot)}\n`);
  }
  return 0;
};

// `bun run eval:golden` / `bun src/eval/goldenResolveSet.ts`. Guarded so the
// module stays importable (the tests import it) without running the harness.
if (import.meta.main) {
  goldenResolveSetMain()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`golden resolve set failed: ${String(err)}\n`);
      process.exitCode = 1;
    });
}

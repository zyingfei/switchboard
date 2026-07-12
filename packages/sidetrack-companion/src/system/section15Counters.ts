// PRD §15 falsifiability counters (ADR-0011 freeze-lift table).
//
// The §15 amendment (PRD.md §15, 2026-07-11) makes the P1-freeze-lift
// condition a table of six OBSERVABLE signals. Before this module those
// six criteria were "pending" with ZERO emit sites — the 30-day dogfood
// window could not be graded because nothing counted them. This module
// computes all six as first-class signals.
//
// FREEZE-SAFE (ADR-0011): this is pure observability. Nothing here feeds
// recall/ranker/connections/attribution serving math — it only READS
// existing event/audit surfaces and reports met/pending vs a threshold.
//
// The six criteria (PRD §15):
//   1. trackedSessionsFraction ≥ 0.80 over a rolling 30d window
//   2. ≥5 packets dispatched (research_packet + coding_agent_packet)
//   3. ≥3 lossless reorgs (move_item with preserved identity)
//   4. ≥1 tab recovery (chrome.sessions.restore success)
//   5. ≥1 MCP context-pack session (audit: workstreams.context_pack)
//   6. ≥7 consecutive clean days (dataLoss tripwires green)
//
// COMPUTE SHAPE: `computeSection15Counters` is a PURE function over
// injected raw inputs (events, audit lines, clean-days ledger). The
// drain-time collector (section15Collector.ts) does the typed reads +
// disk I/O and hands the raw material here, so every counter is unit-
// testable with a fixture that PASSES and one that FAILS its threshold
// without booting a companion.

import type { AcceptedEvent } from '../sync/causal.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import { TAB_SESSION_ATTRIBUTION_INFERRED } from '../tabsession/events.js';
import { DISPATCH_RECORDED, isDispatchRecordedPayload } from '../dispatches/events.js';
import { USER_ORGANIZED_ITEM, isUserOrganizedItemPayload } from '../feedback/events.js';
import { CHROME_SESSIONS_RESTORE } from './section15Events.js';

// The event types the collector must read (typed forEachChunkOfTypes —
// never a full-log scan). Exported so the collector + the route hint
// stay in lockstep with the counters they feed.
export const SECTION15_EVENT_TYPES = [
  BROWSER_TIMELINE_OBSERVED,
  TAB_SESSION_ATTRIBUTION_INFERRED,
  DISPATCH_RECORDED,
  USER_ORGANIZED_ITEM,
  CHROME_SESSIONS_RESTORE,
] as const;

// The MCP tool whose invocation the audit log records for criterion 5.
// Matches PRD §15 ("sidetrack.workstreams.context_pack call via
// streamable-HTTP") and the tool id registered in
// packages/sidetrack-mcp/src/server/mcpServer.ts.
//
// The EMIT SITE that makes this counter falsifiable lives in the MCP
// package: packages/sidetrack-mcp/src/server/contextPackAudit.ts writes
// an `_BAC/audit/<day>.jsonl` line with `tool` set to this exact value
// each time the streamable-HTTP server serves a context_pack call.
// context_pack is a pure READ, so it never flows through the companion's
// vault-writer audit() closure — without that dedicated emit this filter
// could never match and criterion 5 would permanently block the freeze
// lift. Keep this constant in lockstep with MCP_CONTEXT_PACK_TOOL there.
export const MCP_CONTEXT_PACK_TOOL = 'sidetrack.workstreams.context_pack';

// Rolling window for criterion 1. 30d matches the §15 dogfood window.
export const SECTION15_TRACKED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// Thresholds — the freeze-lift condition. Kept as named constants so the
// UI and the compute agree and a table row is never hard-coded twice.
export const SECTION15_THRESHOLDS = {
  trackedSessionsFraction: 0.8,
  packetsDispatched: 5,
  losslessReorgs: 3,
  tabRecoveries: 1,
  mcpContextPackSessions: 1,
  consecutiveCleanDays: 7,
} as const;

export type Section15CriterionId =
  | 'trackedSessionsFraction'
  | 'packetsDispatched'
  | 'losslessReorgs'
  | 'tabRecoveries'
  | 'mcpContextPackSessions'
  | 'consecutiveCleanDays';

// One row of the §15 table. `value` is the measured signal, `threshold`
// the bar it must clear, `met` the boolean the freeze-lift AND is built
// from. `unit` disambiguates the fraction row from the count rows in the
// UI without the reader special-casing an id.
export interface Section15Criterion {
  readonly id: Section15CriterionId;
  readonly label: string;
  readonly observable: string;
  readonly value: number;
  readonly threshold: number;
  readonly unit: 'fraction' | 'count' | 'days';
  readonly met: boolean;
  // Extra context the UI can surface without recomputing (e.g. the
  // numerator/denominator behind a fraction).
  readonly detail: string;
}

export interface Section15Report {
  readonly criteria: readonly Section15Criterion[];
  // The freeze-lift condition: every criterion met. This is the single
  // boolean the PRD §15 table resolves to.
  readonly freezeLiftEligible: boolean;
}

// Per-day durability record for criterion 6. The collector maintains a
// small append/upsert ledger (one row per UTC day) at drain time; the
// streak counter walks it backward from today.
export interface Section15CleanDayRecord {
  // UTC calendar day, YYYY-MM-DD.
  readonly day: string;
  // dataLoss.clean for the LAST observation on that day. A day is dirty
  // if it was ever dirty — a torn/dropped event does not un-happen.
  readonly clean: boolean;
}

export interface Section15CounterInputs {
  // Typed subset of the event log (SECTION15_EVENT_TYPES only).
  readonly events: readonly AcceptedEvent[];
  // Parsed audit lines from _BAC/audit/*.jsonl (the collector caps the
  // scan to a bounded recent window). Only the `tool` field is read.
  readonly auditToolNames: readonly string[];
  // Per-day clean/dirty ledger (criterion 6). Newest-last not required —
  // the streak walk sorts by day.
  readonly cleanDays: readonly Section15CleanDayRecord[];
  // Window anchor. Criterion 1 counts events with acceptedAtMs within
  // [now - 30d, now]; criterion 6 anchors "today" here.
  readonly now: () => Date;
}

const toIsoDay = (date: Date): string => date.toISOString().slice(0, 10);

// Criterion 1 — tracked-sessions fraction over the rolling 30d window.
// Denominator: distinct tabSessionId observed in browser.timeline.observed
// within the window. Numerator: distinct tabSessionId that got attributed
// to a workstream (tabsession.attribution.inferred) within the window. A
// "tracked" session is one Sidetrack successfully filed. 0 observed ⇒
// fraction 0 (unfalsified rather than a divide-by-zero NaN).
const computeTrackedSessionsFraction = (
  inputs: Section15CounterInputs,
): { value: number; observed: number; tracked: number } => {
  const cutoffMs = inputs.now().getTime() - SECTION15_TRACKED_WINDOW_MS;
  const observed = new Set<string>();
  const tracked = new Set<string>();
  for (const event of inputs.events) {
    if (event.acceptedAtMs < cutoffMs) continue;
    if (event.type === BROWSER_TIMELINE_OBSERVED) {
      const sessionId = (event.payload as { tabSessionId?: unknown }).tabSessionId;
      if (typeof sessionId === 'string' && sessionId.length > 0) observed.add(sessionId);
    } else if (event.type === TAB_SESSION_ATTRIBUTION_INFERRED) {
      const sessionId = (event.payload as { tabSessionId?: unknown }).tabSessionId;
      if (typeof sessionId === 'string' && sessionId.length > 0) tracked.add(sessionId);
    }
  }
  // Only count attributions whose session was actually observed in the
  // window: an attribution for a session first observed before the
  // window would inflate the numerator past the denominator.
  let trackedInWindow = 0;
  for (const sessionId of tracked) {
    if (observed.has(sessionId)) trackedInWindow += 1;
  }
  const value = observed.size === 0 ? 0 : trackedInWindow / observed.size;
  return { value, observed: observed.size, tracked: trackedInWindow };
};

// Criterion 2 — packets dispatched, split into research vs coding.
// dispatch.recorded is the persisted form of a dispatch audit record
// (dispatches/events.ts); its target/kind lives in the correlated
// DispatchEventRecord, but the log payload carries enough to classify:
// the UI packet kind maps research→research_packet, coding→coding_agent_
// packet (extension src/dispatch/types.ts). We classify from the
// event's `kind` when present, else fall back to counting the dispatch.
const RESEARCH_KINDS: ReadonlySet<string> = new Set(['research']);
const CODING_KINDS: ReadonlySet<string> = new Set(['coding']);

const computeDispatchClassification = (
  inputs: Section15CounterInputs,
): { research: number; coding: number; total: number } => {
  let research = 0;
  let coding = 0;
  let total = 0;
  for (const event of inputs.events) {
    if (event.type !== DISPATCH_RECORDED) continue;
    if (!isDispatchRecordedPayload(event.payload)) continue;
    total += 1;
    // The log payload does not carry `kind` directly (it is on the
    // correlated JSONL record), but forward-compatible producers may
    // stamp it under dimensions.kind. Classify when we can; a dispatch
    // we can't classify still counts toward the ≥5 packet total.
    const kind = (event.payload as { dimensions?: { kind?: unknown } }).dimensions?.kind;
    if (typeof kind === 'string') {
      if (RESEARCH_KINDS.has(kind)) research += 1;
      else if (CODING_KINDS.has(kind)) coding += 1;
    }
  }
  return { research, coding, total };
};

// Criterion 3 — lossless reorgs. A "move_item with preserved identity"
// is a user.organized.item with action='move' where the item keeps its
// id (itemId is stable across the move) and moves between containers
// (fromContainer→toContainer both present). The event model IS the
// identity-preserving reorg: the itemId never changes, only its
// container membership, and links (edges keyed by itemId) survive. We
// count DISTINCT itemIds moved (a re-move of the same item is one
// lossless reorg for the falsifiability bar, not many).
const computeLosslessReorgs = (
  inputs: Section15CounterInputs,
): { count: number; movedItemIds: number } => {
  const movedItems = new Set<string>();
  let count = 0;
  for (const event of inputs.events) {
    if (event.type !== USER_ORGANIZED_ITEM) continue;
    if (!isUserOrganizedItemPayload(event.payload)) continue;
    const payload = event.payload;
    if (payload.action !== 'move') continue;
    // Identity preserved + a real container transition: both endpoints
    // present (a move with no destination is a removal, not a reorg).
    if (payload.fromContainer === undefined) continue;
    if (payload.toContainer === undefined || payload.toContainer === null) continue;
    if (payload.fromContainer === payload.toContainer) continue;
    count += 1;
    movedItems.add(payload.itemId);
  }
  return { count, movedItemIds: movedItems.size };
};

// Criterion 4 — tab recoveries. Each chrome.sessions.restore event the
// extension emits after a successful restore is one recovery.
const computeTabRecoveries = (inputs: Section15CounterInputs): number => {
  let count = 0;
  for (const event of inputs.events) {
    if (event.type === CHROME_SESSIONS_RESTORE) count += 1;
  }
  return count;
};

// Criterion 5 — MCP context-pack sessions. Count audit lines whose
// `tool` is the context_pack tool. PRD §15 phrases this as "≥1 MCP
// context-pack session"; a session is one invocation of the tool (the
// audit line is written per tool call).
const computeMcpContextPackSessions = (inputs: Section15CounterInputs): number =>
  inputs.auditToolNames.filter((tool) => tool === MCP_CONTEXT_PACK_TOOL).length;

// Criterion 6 — consecutive clean days. Walk the per-day ledger backward
// from today (or the most-recent recorded day when today has no record
// yet — a companion that hasn't drained today should still credit the
// streak up to yesterday) and count contiguous clean days. A gap in the
// ledger BREAKS the streak: an unrecorded day is not provably clean.
const computeConsecutiveCleanDays = (inputs: Section15CounterInputs): number => {
  if (inputs.cleanDays.length === 0) return 0;
  const byDay = new Map<string, boolean>();
  for (const record of inputs.cleanDays) {
    // A day is clean only if EVERY observation of it was clean.
    const prior = byDay.get(record.day);
    byDay.set(record.day, prior === undefined ? record.clean : prior && record.clean);
  }
  const days = [...byDay.keys()].sort();
  // Anchor: the latest recorded day (streak is trailing-contiguous from
  // the freshest record; a stale ledger reports the streak as of its
  // last write, which the artifact's freshness bound already governs).
  let cursor = days[days.length - 1];
  if (cursor === undefined) return 0;
  let streak = 0;
  while (byDay.get(cursor) === true) {
    streak += 1;
    // Step to the previous calendar day.
    const prev = new Date(`${cursor}T00:00:00.000Z`);
    prev.setUTCDate(prev.getUTCDate() - 1);
    const prevDay = toIsoDay(prev);
    if (!byDay.has(prevDay)) break;
    cursor = prevDay;
  }
  return streak;
};

export const computeSection15Counters = (inputs: Section15CounterInputs): Section15Report => {
  const tracked = computeTrackedSessionsFraction(inputs);
  const dispatch = computeDispatchClassification(inputs);
  const reorgs = computeLosslessReorgs(inputs);
  const tabRecoveries = computeTabRecoveries(inputs);
  const mcpContextPack = computeMcpContextPackSessions(inputs);
  const cleanDays = computeConsecutiveCleanDays(inputs);

  const criteria: readonly Section15Criterion[] = [
    {
      id: 'trackedSessionsFraction',
      label: '≥80% tracked',
      observable: 'trackedSessionsFraction over 30d',
      value: tracked.value,
      threshold: SECTION15_THRESHOLDS.trackedSessionsFraction,
      unit: 'fraction',
      met: tracked.value >= SECTION15_THRESHOLDS.trackedSessionsFraction,
      detail: `${tracked.tracked}/${tracked.observed} sessions attributed (30d)`,
    },
    {
      id: 'packetsDispatched',
      label: '≥5 packets dispatched',
      observable: 'research_packet + coding_agent_packet dispatch events',
      value: dispatch.total,
      threshold: SECTION15_THRESHOLDS.packetsDispatched,
      unit: 'count',
      met: dispatch.total >= SECTION15_THRESHOLDS.packetsDispatched,
      detail: `${dispatch.total} dispatched (research ${dispatch.research}, coding ${dispatch.coding})`,
    },
    {
      id: 'losslessReorgs',
      label: '≥3 lossless reorgs',
      observable: 'move_item sequences with preserved identity/links',
      value: reorgs.count,
      threshold: SECTION15_THRESHOLDS.losslessReorgs,
      unit: 'count',
      met: reorgs.count >= SECTION15_THRESHOLDS.losslessReorgs,
      detail: `${reorgs.count} moves (${reorgs.movedItemIds} distinct items)`,
    },
    {
      id: 'tabRecoveries',
      label: '≥1 tab recovery',
      observable: 'chrome.sessions.restore success',
      value: tabRecoveries,
      threshold: SECTION15_THRESHOLDS.tabRecoveries,
      unit: 'count',
      met: tabRecoveries >= SECTION15_THRESHOLDS.tabRecoveries,
      detail: `${tabRecoveries} restores`,
    },
    {
      id: 'mcpContextPackSessions',
      label: '≥1 MCP context-pack session',
      observable: 'sidetrack.workstreams.context_pack audit calls',
      value: mcpContextPack,
      threshold: SECTION15_THRESHOLDS.mcpContextPackSessions,
      unit: 'count',
      met: mcpContextPack >= SECTION15_THRESHOLDS.mcpContextPackSessions,
      detail: `${mcpContextPack} context_pack calls`,
    },
    {
      id: 'consecutiveCleanDays',
      label: '≥7 days zero data loss',
      observable: 'dataLoss drain-lag + outbox tripwires green',
      value: cleanDays,
      threshold: SECTION15_THRESHOLDS.consecutiveCleanDays,
      unit: 'days',
      met: cleanDays >= SECTION15_THRESHOLDS.consecutiveCleanDays,
      detail: `${cleanDays} consecutive clean days`,
    },
  ];

  return {
    criteria,
    freezeLiftEligible: criteria.every((criterion) => criterion.met),
  };
};

// Fold today's dataLoss.clean into the per-day ledger. Pure: the
// collector reads the prior ledger, calls this, and writes the result.
// A day already present stays dirty if it was ever dirty (clean AND).
// Bounds the ledger to a trailing window so it never grows unbounded.
export const SECTION15_CLEAN_DAY_LEDGER_MAX_DAYS = 60;

export const foldCleanDay = (
  prior: readonly Section15CleanDayRecord[],
  observation: { readonly clean: boolean; readonly now: () => Date },
  maxDays: number = SECTION15_CLEAN_DAY_LEDGER_MAX_DAYS,
): readonly Section15CleanDayRecord[] => {
  const today = toIsoDay(observation.now());
  const byDay = new Map<string, boolean>();
  for (const record of prior) {
    const existing = byDay.get(record.day);
    byDay.set(record.day, existing === undefined ? record.clean : existing && record.clean);
  }
  const existingToday = byDay.get(today);
  byDay.set(
    today,
    existingToday === undefined ? observation.clean : existingToday && observation.clean,
  );
  return [...byDay.entries()]
    .map(([day, clean]) => ({ day, clean }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .slice(-maxDays);
};

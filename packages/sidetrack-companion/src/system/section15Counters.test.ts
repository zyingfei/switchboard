import { describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import { TAB_SESSION_ATTRIBUTION_INFERRED } from '../tabsession/events.js';
import { DISPATCH_RECORDED } from '../dispatches/events.js';
import { USER_ORGANIZED_ITEM } from '../feedback/events.js';
import { CHROME_SESSIONS_RESTORE } from './section15Events.js';
import {
  MCP_CONTEXT_PACK_TOOL,
  computeSection15Counters,
  foldCleanDay,
  type Section15CleanDayRecord,
  type Section15CounterInputs,
  type Section15CriterionId,
} from './section15Counters.js';

const NOW = new Date('2026-07-11T12:00:00.000Z');
const now = (): Date => NOW;

let seq = 0;
const evt = (type: string, payload: unknown, acceptedAt: Date = NOW): AcceptedEvent => {
  seq += 1;
  return {
    clientEventId: `client-${String(seq)}`,
    dot: { replicaId: 'r1', seq },
    deps: {},
    aggregateId: `agg-${String(seq)}`,
    type,
    payload,
    acceptedAtMs: acceptedAt.getTime(),
  };
};

const timeline = (tabSessionId: string, at: Date = NOW): AcceptedEvent =>
  evt(BROWSER_TIMELINE_OBSERVED, { eventId: `e-${tabSessionId}`, tabSessionId, transition: 'activated', url: 'https://x.test' }, at);

const attributed = (tabSessionId: string, at: Date = NOW): AcceptedEvent =>
  evt(TAB_SESSION_ATTRIBUTION_INFERRED, { payloadVersion: 1, tabSessionId, workstreamId: 'w1' }, at);

const dispatch = (kind?: string): AcceptedEvent =>
  evt(DISPATCH_RECORDED, {
    bac_id: `d-${String(seq)}`,
    target: { provider: 'chatgpt' },
    createdAt: NOW.toISOString(),
    body: 'x',
    ...(kind === undefined ? {} : { dimensions: { kind } }),
  });

const move = (itemId: string, from: string, to: string): AcceptedEvent =>
  evt(USER_ORGANIZED_ITEM, {
    payloadVersion: 1,
    itemKind: 'canonical-url',
    itemId,
    action: 'move',
    fromContainer: from,
    toContainer: to,
  });

const restore = (): AcceptedEvent =>
  evt(CHROME_SESSIONS_RESTORE, { payloadVersion: 1, sessionId: `s-${String(seq)}`, matchedOn: 'url' });

const baseInputs = (overrides: Partial<Section15CounterInputs> = {}): Section15CounterInputs => ({
  events: [],
  auditToolNames: [],
  cleanDays: [],
  now,
  ...overrides,
});

const criterion = (report: ReturnType<typeof computeSection15Counters>, id: Section15CriterionId) => {
  const found = report.criteria.find((c) => c.id === id);
  if (found === undefined) throw new Error(`missing criterion ${id}`);
  return found;
};

describe('section15 counters — trackedSessionsFraction (criterion 1)', () => {
  it('PASSES when ≥80% of observed sessions are attributed over 30d', () => {
    const events = [
      timeline('sess-a'),
      timeline('sess-b'),
      timeline('sess-c'),
      timeline('sess-d'),
      timeline('sess-e'),
      attributed('sess-a'),
      attributed('sess-b'),
      attributed('sess-c'),
      attributed('sess-d'),
    ];
    const c = criterion(computeSection15Counters(baseInputs({ events })), 'trackedSessionsFraction');
    expect(c.value).toBeCloseTo(0.8);
    expect(c.met).toBe(true);
  });

  it('FAILS below the 0.80 threshold', () => {
    const events = [
      timeline('sess-a'),
      timeline('sess-b'),
      timeline('sess-c'),
      timeline('sess-d'),
      timeline('sess-e'),
      attributed('sess-a'),
      attributed('sess-b'),
    ];
    const c = criterion(computeSection15Counters(baseInputs({ events })), 'trackedSessionsFraction');
    expect(c.value).toBeCloseTo(0.4);
    expect(c.met).toBe(false);
  });

  it('excludes sessions observed before the 30d window', () => {
    const old = new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000);
    const events = [
      timeline('old-sess', old),
      attributed('old-sess', old),
      timeline('fresh-sess'),
      attributed('fresh-sess'),
    ];
    const c = criterion(computeSection15Counters(baseInputs({ events })), 'trackedSessionsFraction');
    // Only fresh-sess is in-window ⇒ 1/1.
    expect(c.value).toBe(1);
    expect(c.detail).toContain('1/1');
  });
});

describe('section15 counters — packetsDispatched (criterion 2)', () => {
  it('PASSES at ≥5 dispatches and classifies research vs coding', () => {
    const events = [
      dispatch('research'),
      dispatch('research'),
      dispatch('coding'),
      dispatch('coding'),
      dispatch('note'),
    ];
    const c = criterion(computeSection15Counters(baseInputs({ events })), 'packetsDispatched');
    expect(c.value).toBe(5);
    expect(c.met).toBe(true);
    expect(c.detail).toContain('research 2');
    expect(c.detail).toContain('coding 2');
  });

  it('FAILS below 5 dispatches', () => {
    const events = [dispatch('research'), dispatch('coding'), dispatch()];
    const c = criterion(computeSection15Counters(baseInputs({ events })), 'packetsDispatched');
    expect(c.value).toBe(3);
    expect(c.met).toBe(false);
  });
});

describe('section15 counters — losslessReorgs (criterion 3)', () => {
  it('PASSES at ≥3 identity-preserving moves', () => {
    const events = [
      move('url-a', 'ws:1', 'ws:2'),
      move('url-b', 'ws:1', 'ws:3'),
      move('url-c', 'ws:2', 'ws:3'),
    ];
    const c = criterion(computeSection15Counters(baseInputs({ events })), 'losslessReorgs');
    expect(c.value).toBe(3);
    expect(c.met).toBe(true);
  });

  it('FAILS below 3, and does not count a move with no destination or a same-container move', () => {
    const events = [
      move('url-a', 'ws:1', 'ws:2'),
      // no toContainer ⇒ removal, not a lossless reorg.
      evt(USER_ORGANIZED_ITEM, {
        payloadVersion: 1,
        itemKind: 'canonical-url',
        itemId: 'url-b',
        action: 'move',
        fromContainer: 'ws:1',
        toContainer: null,
      }),
      // same container ⇒ no transition.
      move('url-c', 'ws:9', 'ws:9'),
    ];
    const c = criterion(computeSection15Counters(baseInputs({ events })), 'losslessReorgs');
    expect(c.value).toBe(1);
    expect(c.met).toBe(false);
  });
});

describe('section15 counters — tabRecoveries (criterion 4)', () => {
  it('PASSES at ≥1 restore', () => {
    const c = criterion(computeSection15Counters(baseInputs({ events: [restore()] })), 'tabRecoveries');
    expect(c.value).toBe(1);
    expect(c.met).toBe(true);
  });

  it('FAILS with zero restores', () => {
    const c = criterion(computeSection15Counters(baseInputs()), 'tabRecoveries');
    expect(c.value).toBe(0);
    expect(c.met).toBe(false);
  });
});

describe('section15 counters — mcpContextPackSessions (criterion 5)', () => {
  it('PASSES at ≥1 context_pack audit call', () => {
    const c = criterion(
      computeSection15Counters(baseInputs({ auditToolNames: ['sidetrack.search', MCP_CONTEXT_PACK_TOOL] })),
      'mcpContextPackSessions',
    );
    expect(c.value).toBe(1);
    expect(c.met).toBe(true);
  });

  it('FAILS with no context_pack calls (other tools do not count)', () => {
    const c = criterion(
      computeSection15Counters(baseInputs({ auditToolNames: ['sidetrack.search', 'sidetrack.threads.move'] })),
      'mcpContextPackSessions',
    );
    expect(c.value).toBe(0);
    expect(c.met).toBe(false);
  });
});

describe('section15 counters — consecutiveCleanDays (criterion 6)', () => {
  const cleanRun = (days: readonly string[], clean: boolean): Section15CleanDayRecord[] =>
    days.map((day) => ({ day, clean }));

  it('PASSES at ≥7 contiguous clean days', () => {
    const cleanDays = cleanRun(
      [
        '2026-07-05',
        '2026-07-06',
        '2026-07-07',
        '2026-07-08',
        '2026-07-09',
        '2026-07-10',
        '2026-07-11',
      ],
      true,
    );
    const c = criterion(computeSection15Counters(baseInputs({ cleanDays })), 'consecutiveCleanDays');
    expect(c.value).toBe(7);
    expect(c.met).toBe(true);
  });

  it('FAILS when a dirty day breaks the streak', () => {
    const cleanDays: Section15CleanDayRecord[] = [
      { day: '2026-07-05', clean: true },
      { day: '2026-07-06', clean: true },
      { day: '2026-07-07', clean: false },
      { day: '2026-07-08', clean: true },
      { day: '2026-07-09', clean: true },
      { day: '2026-07-10', clean: true },
      { day: '2026-07-11', clean: true },
    ];
    const c = criterion(computeSection15Counters(baseInputs({ cleanDays })), 'consecutiveCleanDays');
    // Trailing clean run from 07-08..07-11 = 4, below the 7 bar.
    expect(c.value).toBe(4);
    expect(c.met).toBe(false);
  });

  it('breaks the streak on a gap in the ledger (an unrecorded day is not provably clean)', () => {
    const cleanDays: Section15CleanDayRecord[] = [
      { day: '2026-07-05', clean: true },
      // 07-06 missing.
      { day: '2026-07-07', clean: true },
      { day: '2026-07-08', clean: true },
    ];
    const c = criterion(computeSection15Counters(baseInputs({ cleanDays })), 'consecutiveCleanDays');
    // Walk from 07-08 (clean) → 07-07 (clean) → 07-06 missing ⇒ stop. = 2.
    expect(c.value).toBe(2);
  });
});

describe('section15 counters — foldCleanDay ledger', () => {
  it('marks today clean and preserves prior days', () => {
    const folded = foldCleanDay([{ day: '2026-07-10', clean: true }], { clean: true, now });
    expect(folded).toEqual([
      { day: '2026-07-10', clean: true },
      { day: '2026-07-11', clean: true },
    ]);
  });

  it('a dirty observation makes today dirty and stays dirty (clean AND)', () => {
    const once = foldCleanDay([], { clean: true, now });
    const twice = foldCleanDay(once, { clean: false, now });
    expect(twice).toEqual([{ day: '2026-07-11', clean: false }]);
    const thrice = foldCleanDay(twice, { clean: true, now });
    // Once dirty, the day stays dirty for the rest of the calendar day.
    expect(thrice).toEqual([{ day: '2026-07-11', clean: false }]);
  });

  it('bounds the ledger to maxDays', () => {
    const many: Section15CleanDayRecord[] = Array.from({ length: 100 }, (_v, i) => ({
      day: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      clean: true,
    }));
    const folded = foldCleanDay(many, { clean: true, now }, 10);
    expect(folded.length).toBe(10);
  });
});

describe('section15 counters — freezeLiftEligible', () => {
  it('is true only when every criterion is met', () => {
    const events = [
      // criterion 1: 4/4 attributed = 1.0
      timeline('a'),
      timeline('b'),
      timeline('c'),
      timeline('d'),
      attributed('a'),
      attributed('b'),
      attributed('c'),
      attributed('d'),
      // criterion 2: 5 dispatches
      dispatch('research'),
      dispatch('research'),
      dispatch('coding'),
      dispatch('coding'),
      dispatch('note'),
      // criterion 3: 3 moves
      move('m1', 'x', 'y'),
      move('m2', 'x', 'y'),
      move('m3', 'x', 'y'),
      // criterion 4: 1 restore
      restore(),
    ];
    const cleanDays: Section15CleanDayRecord[] = [
      '2026-07-05',
      '2026-07-06',
      '2026-07-07',
      '2026-07-08',
      '2026-07-09',
      '2026-07-10',
      '2026-07-11',
    ].map((day) => ({ day, clean: true }));
    const report = computeSection15Counters(
      baseInputs({ events, auditToolNames: [MCP_CONTEXT_PACK_TOOL], cleanDays }),
    );
    expect(report.freezeLiftEligible).toBe(true);
    expect(report.criteria.every((c) => c.met)).toBe(true);
  });

  it('is false when any single criterion is unmet', () => {
    const report = computeSection15Counters(baseInputs());
    expect(report.freezeLiftEligible).toBe(false);
  });
});

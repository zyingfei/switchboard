// Stage 5.2 W2c — tab-session projection accumulator parity tests.
// Verifies seed + fold produces the same byte output as the legacy
// projectTabSessions, that the fold dispatcher correctly routes each
// event type, and that non-tab-session events are no-ops.

import { describe, expect, it } from 'vitest';

import { USER_ORGANIZED_ITEM } from '../feedback/events.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { TAB_SESSION_ATTRIBUTION_INFERRED } from './events.js';
import {
  createEmptyTabSessionProjectionAccumulator,
  foldEventIntoTabSessionProjectionAccumulator,
  projectTabSessions,
  seedTabSessionProjectionAccumulator,
  tabSessionProjectionFromAccumulator,
} from './projection.js';

const observation = (overrides: {
  seq: number;
  tabSessionId: string;
  tabIdHash?: string;
  url?: string;
  title?: string;
  observedAt?: string;
  transition?: 'activated' | 'updated' | 'completed' | 'closed';
}): AcceptedEvent => ({
  clientEventId: `obs-${String(overrides.seq)}`,
  dot: { replicaId: 'replica-A', seq: overrides.seq },
  deps: {},
  aggregateId: 'agg',
  type: BROWSER_TIMELINE_OBSERVED,
  payload: {
    eventId: `evt-${String(overrides.seq)}`,
    observedAt: overrides.observedAt ?? `2026-05-12T10:00:0${String(overrides.seq)}.000Z`,
    url: overrides.url ?? 'https://example.com/page',
    canonicalUrl: overrides.url ?? 'https://example.com/page',
    ...(overrides.title === undefined ? {} : { title: overrides.title }),
    transition: overrides.transition ?? 'activated',
    tabSessionId: overrides.tabSessionId,
    ...(overrides.tabIdHash === undefined ? {} : { tabIdHash: overrides.tabIdHash }),
    payloadVersion: 1,
    dimensions: {},
  },
  acceptedAtMs: 1_700_000_000_000 + overrides.seq * 1000,
});

const organize = (overrides: {
  seq: number;
  tabSessionId: string;
  workstreamId: string | null;
}): AcceptedEvent => ({
  clientEventId: `org-${String(overrides.seq)}`,
  dot: { replicaId: 'replica-A', seq: overrides.seq },
  deps: {},
  aggregateId: 'agg',
  type: USER_ORGANIZED_ITEM,
  payload: {
    payloadVersion: 1,
    itemKind: 'tab-session' as const,
    itemId: overrides.tabSessionId,
    action: 'move' as const,
    toContainer: overrides.workstreamId,
  },
  acceptedAtMs: 1_700_000_000_000 + overrides.seq * 1000,
});

const infer = (overrides: {
  seq: number;
  tabSessionId: string;
  workstreamId: string;
}): AcceptedEvent => ({
  clientEventId: `inf-${String(overrides.seq)}`,
  dot: { replicaId: 'replica-A', seq: overrides.seq },
  deps: {},
  aggregateId: 'agg',
  type: TAB_SESSION_ATTRIBUTION_INFERRED,
  payload: {
    payloadVersion: 1,
    tabSessionId: overrides.tabSessionId,
    workstreamId: overrides.workstreamId,
    policyMode: 'balanced',
    dominantSource: 'similarity',
    rawFusionLogit: 1.5,
    margin: 0.4,
    corroborationCount: 2,
    modelRevision: 'tabsession-resolver-v1',
    graphRevision: '2026-05-12:1:1',
    evidenceHash: 'abc',
    resolverDependencyKey: 'k',
    reasonSummary: 'sim',
  },
  acceptedAtMs: 1_700_000_000_000 + overrides.seq * 1000,
});

const serializeProjection = (projection: ReturnType<typeof projectTabSessions>): string =>
  JSON.stringify({
    schemaVersion: projection.schemaVersion,
    bySessionId: [...projection.bySessionId.entries()],
    openSessionsByTabId: [...projection.openSessionsByTabId.entries()],
  });

describe('Stage 5.2 W2c — tab-session projection accumulator', () => {
  it('seed → derive matches one-shot projectTabSessions for the basic flow', () => {
    const events = [
      observation({ seq: 1, tabSessionId: 'tses_a', tabIdHash: 'tab_a', title: 'A' }),
      observation({
        seq: 2,
        tabSessionId: 'tses_a',
        tabIdHash: 'tab_a',
        url: 'https://example.com/b',
      }),
      organize({ seq: 3, tabSessionId: 'tses_a', workstreamId: 'ws_x' }),
      observation({ seq: 4, tabSessionId: 'tses_b', tabIdHash: 'tab_b', title: 'B' }),
      infer({ seq: 5, tabSessionId: 'tses_b', workstreamId: 'ws_y' }),
    ];
    const oneShot = projectTabSessions(events);
    const viaAcc = tabSessionProjectionFromAccumulator(
      seedTabSessionProjectionAccumulator(events),
    );
    expect(serializeProjection(viaAcc)).toBe(serializeProjection(oneShot));
  });

  it('seed handles unsorted event order via internal sort', () => {
    const seq1 = observation({ seq: 1, tabSessionId: 'tses_a', title: 'A' });
    const seq2 = observation({
      seq: 2,
      tabSessionId: 'tses_a',
      url: 'https://example.com/b',
    });
    const sorted = seedTabSessionProjectionAccumulator([seq1, seq2]);
    const reversed = seedTabSessionProjectionAccumulator([seq2, seq1]);
    expect(serializeProjection(tabSessionProjectionFromAccumulator(reversed))).toBe(
      serializeProjection(tabSessionProjectionFromAccumulator(sorted)),
    );
  });

  it('close transition seals the record + removes the tabIdHash → open mapping', () => {
    const events = [
      observation({ seq: 1, tabSessionId: 'tses_a', tabIdHash: 'tab_a' }),
      observation({ seq: 2, tabSessionId: 'tses_a', tabIdHash: 'tab_a', transition: 'closed' }),
    ];
    const projection = projectTabSessions(events);
    const record = projection.bySessionId.get('tses_a');
    expect(record?.closedAt).toBeDefined();
    expect(projection.openSessionsByTabId.has('tab_a')).toBe(false);
  });

  it('user_asserted > inferred attribution precedence preserved across folds', () => {
    const inferEvt = infer({ seq: 1, tabSessionId: 'tses_a', workstreamId: 'ws_inferred' });
    const organizeEvt = organize({ seq: 2, tabSessionId: 'tses_a', workstreamId: 'ws_user' });
    const acc = createEmptyTabSessionProjectionAccumulator();
    foldEventIntoTabSessionProjectionAccumulator(acc, organizeEvt);
    foldEventIntoTabSessionProjectionAccumulator(acc, inferEvt);
    const record = tabSessionProjectionFromAccumulator(acc).bySessionId.get('tses_a');
    expect(record?.currentAttribution?.source).toBe('user_asserted');
    expect(record?.currentAttribution?.workstreamId).toBe('ws_user');
  });

  it('non-tab-session events are no-ops in fold', () => {
    const acc = createEmptyTabSessionProjectionAccumulator();
    foldEventIntoTabSessionProjectionAccumulator(acc, {
      clientEventId: 'unrelated-1',
      dot: { replicaId: 'replica-A', seq: 1 },
      deps: {},
      aggregateId: 'agg',
      type: 'unrelated.event',
      payload: {},
      acceptedAtMs: 1_700_000_000_000,
    });
    expect(acc.records.size).toBe(0);
    expect(acc.openSessionsByTabId.size).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';

import { USER_ORGANIZED_ITEM } from '../feedback/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import { TAB_SESSION_ATTRIBUTION_INFERRED } from './events.js';
import { projectTabSessions, serializeTabSessionProjection } from './projection.js';

const buildEvent = (input: {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
  readonly acceptedAtMs?: number;
}): AcceptedEvent => ({
  clientEventId: `evt-${String(input.seq)}`,
  dot: { replicaId: 'replica-A', seq: input.seq },
  deps: {},
  aggregateId: 'agg',
  type: input.type,
  payload: input.payload,
  acceptedAtMs: input.acceptedAtMs ?? Date.parse('2026-05-07T10:00:00.000Z') + input.seq,
});

const observed = (input: {
  readonly seq: number;
  readonly tabSessionId: string;
  readonly tabIdHash?: string;
  readonly observedAt: string;
  readonly transition?: 'activated' | 'updated' | 'completed' | 'closed';
  readonly openerTabSessionId?: string;
}): AcceptedEvent =>
  buildEvent({
    seq: input.seq,
    type: BROWSER_TIMELINE_OBSERVED,
    payload: {
      eventId: `tl-${String(input.seq)}`,
      observedAt: input.observedAt,
      url: `https://example.test/${input.tabSessionId}/${String(input.seq)}`,
      title: `Page ${String(input.seq)}`,
      provider: 'generic',
      transition: input.transition ?? 'updated',
      ...(input.tabIdHash === undefined ? {} : { tabIdHash: input.tabIdHash }),
      tabSessionId: input.tabSessionId,
      ...(input.openerTabSessionId === undefined
        ? {}
        : { openerTabSessionId: input.openerTabSessionId }),
    },
  });

const attribution = (input: {
  readonly seq: number;
  readonly tabSessionId: string;
  readonly workstreamId: string | null;
  readonly acceptedAtMs?: number;
  readonly attributionSource?: 'manual' | 'tab-group-pull-in' | 'tab-group-pull-out';
}): AcceptedEvent =>
  buildEvent({
    seq: input.seq,
    type: USER_ORGANIZED_ITEM,
    ...(input.acceptedAtMs === undefined ? {} : { acceptedAtMs: input.acceptedAtMs }),
    payload: {
      payloadVersion: 1,
      itemKind: 'tab-session',
      itemId: input.tabSessionId,
      action: 'move',
      toContainer: input.workstreamId,
      ...(input.attributionSource === undefined
        ? {}
        : { details: { attributionSource: input.attributionSource } }),
    },
  });

const inferredAttribution = (input: {
  readonly seq: number;
  readonly tabSessionId: string;
  readonly workstreamId: string;
  readonly acceptedAtMs?: number;
}): AcceptedEvent =>
  buildEvent({
    seq: input.seq,
    type: TAB_SESSION_ATTRIBUTION_INFERRED,
    ...(input.acceptedAtMs === undefined ? {} : { acceptedAtMs: input.acceptedAtMs }),
    payload: {
      payloadVersion: 1,
      tabSessionId: input.tabSessionId,
      workstreamId: input.workstreamId,
      policyMode: 'balanced',
      dominantSource: 'ppr',
      rawFusionLogit: 3.2,
      margin: 0.8,
      corroborationCount: 2,
    },
  });

describe('tab-session projection', () => {
  it('is deterministic under shuffled events and latest Class A attribution wins', () => {
    const events = [
      observed({
        seq: 1,
        tabSessionId: 'tses_a',
        tabIdHash: 'tab_a',
        observedAt: '2026-05-07T10:00:00.000Z',
      }),
      attribution({ seq: 2, tabSessionId: 'tses_a', workstreamId: 'ws_old' }),
      attribution({ seq: 3, tabSessionId: 'tses_a', workstreamId: 'ws_new' }),
    ];

    const left = serializeTabSessionProjection(projectTabSessions(events));
    const right = serializeTabSessionProjection(projectTabSessions([...events].reverse()));

    expect(right).toEqual(left);
    expect(left.bySessionId['tses_a']?.currentAttribution).toMatchObject({
      workstreamId: 'ws_new',
      source: 'user_asserted',
      clientEventId: 'evt-3',
    });
    expect(left.bySessionId['tses_a']).toMatchObject({
      latestUrl: 'https://example.test/tses_a/1',
      latestTitle: 'Page 1',
      provider: 'generic',
    });
    expect(left.openSessionsByTabId).toEqual({ tab_a: 'tses_a' });
  });

  it('is idempotent across repeated projection runs', () => {
    const events = [
      observed({
        seq: 1,
        tabSessionId: 'tses_a',
        tabIdHash: 'tab_a',
        observedAt: '2026-05-07T10:00:00.000Z',
      }),
      attribution({ seq: 2, tabSessionId: 'tses_a', workstreamId: null }),
    ];

    expect(serializeTabSessionProjection(projectTabSessions(events))).toEqual(
      serializeTabSessionProjection(projectTabSessions(events)),
    );
  });

  it('freezes a session after close and keeps it out of open tab indexes', () => {
    const projection = serializeTabSessionProjection(
      projectTabSessions([
        observed({
          seq: 1,
          tabSessionId: 'tses_a',
          tabIdHash: 'tab_a',
          observedAt: '2026-05-07T10:00:00.000Z',
        }),
        observed({
          seq: 2,
          tabSessionId: 'tses_a',
          tabIdHash: 'tab_a',
          observedAt: '2026-05-07T10:01:00.000Z',
          transition: 'closed',
        }),
        observed({
          seq: 3,
          tabSessionId: 'tses_a',
          tabIdHash: 'tab_a',
          observedAt: '2026-05-07T10:02:00.000Z',
        }),
      ]),
    );

    expect(projection.bySessionId['tses_a']).toMatchObject({
      closedAt: '2026-05-07T10:01:00.000Z',
      lastActivityAt: '2026-05-07T10:01:00.000Z',
    });
    expect(projection.openSessionsByTabId).toEqual({});
  });

  it('keeps user assertions above inferred attribution while pull-out wins by LWW inside Class A', () => {
    const projection = serializeTabSessionProjection(
      projectTabSessions([
        observed({
          seq: 1,
          tabSessionId: 'tses_a',
          tabIdHash: 'tab_a',
          observedAt: '2026-05-07T10:00:00.000Z',
        }),
        inferredAttribution({
          seq: 2,
          tabSessionId: 'tses_a',
          workstreamId: 'ws_inferred',
          acceptedAtMs: Date.parse('2026-05-07T10:01:00.000Z'),
        }),
        attribution({
          seq: 3,
          tabSessionId: 'tses_a',
          workstreamId: 'ws_group',
          attributionSource: 'tab-group-pull-in',
          acceptedAtMs: Date.parse('2026-05-07T10:02:00.000Z'),
        }),
        inferredAttribution({
          seq: 4,
          tabSessionId: 'tses_a',
          workstreamId: 'ws_later_inferred',
          acceptedAtMs: Date.parse('2026-05-07T10:03:00.000Z'),
        }),
        attribution({
          seq: 5,
          tabSessionId: 'tses_a',
          workstreamId: null,
          attributionSource: 'tab-group-pull-out',
          acceptedAtMs: Date.parse('2026-05-07T10:04:00.000Z'),
        }),
      ]),
    );

    expect(projection.bySessionId['tses_a']?.currentAttribution).toMatchObject({
      workstreamId: null,
      source: 'tab-group-pull-out',
      clientEventId: 'evt-5',
    });
  });
});

import { describe, expect, it } from 'vitest';

import { USER_ORGANIZED_ITEM } from '../feedback/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import { URL_ATTRIBUTION_INFERRED } from './events.js';
import { projectUrls, urlInbox } from './projection.js';

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
  readonly canonicalUrl: string;
  readonly title?: string;
  readonly observedAt?: string;
  readonly tabSessionId?: string;
  readonly transition?: 'activated' | 'updated' | 'completed' | 'closed';
}): AcceptedEvent =>
  buildEvent({
    seq: input.seq,
    type: BROWSER_TIMELINE_OBSERVED,
    payload: {
      eventId: `tl-${String(input.seq)}`,
      observedAt: input.observedAt ?? '2026-05-07T10:00:00.000Z',
      url: input.canonicalUrl,
      canonicalUrl: input.canonicalUrl,
      ...(input.title === undefined ? {} : { title: input.title }),
      transition: input.transition ?? 'updated',
      ...(input.tabSessionId === undefined ? {} : { tabSessionId: input.tabSessionId }),
    },
  });

const userMove = (input: {
  readonly seq: number;
  readonly canonicalUrl: string;
  readonly workstreamId: string | null;
}): AcceptedEvent =>
  buildEvent({
    seq: input.seq,
    type: USER_ORGANIZED_ITEM,
    payload: {
      payloadVersion: 1,
      itemKind: 'canonical-url',
      itemId: input.canonicalUrl,
      action: 'move',
      toContainer: input.workstreamId,
    },
  });

const inferredMove = (input: {
  readonly seq: number;
  readonly canonicalUrl: string;
  readonly workstreamId: string;
}): AcceptedEvent =>
  buildEvent({
    seq: input.seq,
    type: URL_ATTRIBUTION_INFERRED,
    payload: {
      payloadVersion: 1,
      canonicalUrl: input.canonicalUrl,
      workstreamId: input.workstreamId,
      policyMode: 'balanced',
      dominantSource: 'similarity',
      rawFusionLogit: 1.5,
      margin: 0.4,
      corroborationCount: 2,
      modelRevision: 'urls-resolver-v1',
      graphRevision: '2026-05-07:1:1',
      evidenceHash: 'abc',
      resolverDependencyKey: 'k',
      reasonSummary: 'sim',
    },
  });

describe('url projection', () => {
  it('aggregates visits per canonical URL', () => {
    const events: AcceptedEvent[] = [
      observed({ seq: 1, canonicalUrl: 'https://x/a', title: 'A1', tabSessionId: 'tses_a' }),
      observed({
        seq: 2,
        canonicalUrl: 'https://x/a',
        title: 'A2',
        tabSessionId: 'tses_b',
        observedAt: '2026-05-07T10:05:00.000Z',
      }),
      observed({ seq: 3, canonicalUrl: 'https://x/b', title: 'B', tabSessionId: 'tses_b' }),
    ];
    const projection = projectUrls(events);
    expect(projection.byCanonicalUrl.size).toBe(2);
    const a = projection.byCanonicalUrl.get('https://x/a');
    expect(a?.visitCount).toBe(2);
    expect(a?.tabSessionIds).toEqual(['tses_a', 'tses_b']);
    expect(a?.latestTitle).toBe('A2');
    expect(a?.host).toBe('x');
  });

  it('user.organized.item with itemKind canonical-url sets attribution', () => {
    const events: AcceptedEvent[] = [
      observed({ seq: 1, canonicalUrl: 'https://x/a' }),
      userMove({ seq: 2, canonicalUrl: 'https://x/a', workstreamId: 'ws_sec' }),
    ];
    const projection = projectUrls(events);
    const record = projection.byCanonicalUrl.get('https://x/a');
    expect(record?.currentAttribution?.workstreamId).toBe('ws_sec');
    expect(record?.currentAttribution?.source).toBe('user_asserted');
  });

  it('user-asserted attribution beats inferred regardless of order', () => {
    const events: AcceptedEvent[] = [
      observed({ seq: 1, canonicalUrl: 'https://x/a' }),
      userMove({ seq: 2, canonicalUrl: 'https://x/a', workstreamId: 'ws_user' }),
      inferredMove({ seq: 3, canonicalUrl: 'https://x/a', workstreamId: 'ws_inferred' }),
    ];
    const projection = projectUrls(events);
    const record = projection.byCanonicalUrl.get('https://x/a');
    expect(record?.currentAttribution?.workstreamId).toBe('ws_user');
  });

  it('user can null-out an attribution (dismiss back to Inbox)', () => {
    const events: AcceptedEvent[] = [
      observed({ seq: 1, canonicalUrl: 'https://x/a' }),
      userMove({ seq: 2, canonicalUrl: 'https://x/a', workstreamId: 'ws_sec' }),
      userMove({ seq: 3, canonicalUrl: 'https://x/a', workstreamId: null }),
    ];
    const projection = projectUrls(events);
    const record = projection.byCanonicalUrl.get('https://x/a');
    expect(record?.currentAttribution?.workstreamId).toBeNull();
  });

  it('inbox lists unattributed URLs newest-first by first-seen', () => {
    const events: AcceptedEvent[] = [
      observed({
        seq: 1,
        canonicalUrl: 'https://x/old',
        observedAt: '2026-05-07T10:00:00.000Z',
      }),
      observed({
        seq: 2,
        canonicalUrl: 'https://x/new',
        observedAt: '2026-05-07T11:00:00.000Z',
      }),
      observed({
        seq: 3,
        canonicalUrl: 'https://x/done',
        observedAt: '2026-05-07T10:30:00.000Z',
      }),
      userMove({ seq: 4, canonicalUrl: 'https://x/done', workstreamId: 'ws' }),
    ];
    const projection = projectUrls(events);
    const inbox = urlInbox(projection, { limit: 10, offset: 0 });
    expect(inbox.map((r) => r.canonicalUrl)).toEqual(['https://x/new', 'https://x/old']);
  });

  it('inbox order stays stable when an existing URL is revisited', () => {
    // The user reported the Inbox "items jumping" when sorted by
    // lastSeenAt — every revisit reordered the list. firstSeenAt sort
    // keeps existing items in place; only NEW URLs appear at the top.
    const events: AcceptedEvent[] = [
      observed({ seq: 1, canonicalUrl: 'https://x/a', observedAt: '2026-05-07T10:00:00.000Z' }),
      observed({ seq: 2, canonicalUrl: 'https://x/b', observedAt: '2026-05-07T10:10:00.000Z' }),
      observed({ seq: 3, canonicalUrl: 'https://x/c', observedAt: '2026-05-07T10:20:00.000Z' }),
    ];
    const before = urlInbox(projectUrls(events), { limit: 10, offset: 0 }).map((r) => r.canonicalUrl);
    // Revisit `a` — under lastSeenAt sort this would jump `a` to the
    // top of the list. Under firstSeenAt sort it stays put.
    const withRevisit: AcceptedEvent[] = [
      ...events,
      observed({ seq: 4, canonicalUrl: 'https://x/a', observedAt: '2026-05-07T11:00:00.000Z' }),
    ];
    const after = urlInbox(projectUrls(withRevisit), { limit: 10, offset: 0 }).map(
      (r) => r.canonicalUrl,
    );
    expect(after).toEqual(before);
  });
});

import { describe, expect, it } from 'vitest';

import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import { THREAD_UPSERTED } from '../../threads/events.js';
import type { AcceptedEvent } from '../causal.js';
import { invalidationsForEvent } from './invalidation.js';
import { invalidationKeysToScopes } from './connectionsScopes.js';

const event = (type: string, payload: unknown): AcceptedEvent => ({
  clientEventId: `evt-${type}`,
  dot: { replicaId: 'replica-scopes', seq: 1 },
  deps: {},
  aggregateId: 'aggregate',
  type,
  payload,
  acceptedAtMs: Date.parse('2026-05-22T10:00:00.000Z'),
});

describe('connections scope invalidation mapping', () => {
  it('maps thread upserts to thread, URL, and workstream scopes', () => {
    expect(
      invalidationKeysToScopes(
        invalidationsForEvent(
          event(THREAD_UPSERTED, {
            bac_id: 'thread-a',
            threadUrl: 'https://chatgpt.com/c/thread-a',
            primaryWorkstreamId: 'workstream-a',
          }),
        ),
      ),
    ).toEqual([
      { kind: 'thread', id: 'thread-a' },
      { kind: 'url', id: 'https://chatgpt.com/c/thread-a' },
      { kind: 'workstream', id: 'workstream-a' },
    ]);
  });

  it('maps browser observations to visit, tab-session, and URL scopes', () => {
    expect(
      invalidationKeysToScopes(
        invalidationsForEvent(
          event(BROWSER_TIMELINE_OBSERVED, {
            eventId: 'visit-a',
            observedAt: '2026-05-22T10:00:00.000Z',
            url: 'https://example.test/path',
            canonicalUrl: 'https://example.test/path',
            transition: 'activated',
            tabSessionId: 'tab-a',
          }),
        ),
      ),
    ).toEqual([
      { kind: 'tab-session', id: 'tab-a' },
      { kind: 'url', id: 'https://example.test/path' },
      { kind: 'url', id: 'visit-a' },
      { kind: 'visit', id: 'visit-a' },
    ]);
  });
});

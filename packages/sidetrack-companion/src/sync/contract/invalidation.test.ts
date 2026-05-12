import { describe, expect, it } from 'vitest';

import { ANNOTATION_CREATED } from '../../annotations/events.js';
import { DISPATCH_RECORDED } from '../../dispatches/events.js';
import {
  USER_ENGAGEMENT_RELABELED,
  USER_FLOW_CONFIRMED,
  USER_FLOW_REJECTED,
  USER_ORGANIZED_ITEM,
} from '../../feedback/events.js';
import { QUEUE_CREATED } from '../../queue/events.js';
import { CAPTURE_RECORDED, RECALL_TOMBSTONE_TARGET } from '../../recall/events.js';
import { CAPTURE_EXTRACTION_PRODUCED } from '../../recall/extraction/events.js';
import { TAB_SESSION_ATTRIBUTION_INFERRED } from '../../tabsession/events.js';
import {
  THREAD_ARCHIVED,
  THREAD_UPSERTED,
} from '../../threads/events.js';
import { URL_ATTRIBUTION_INFERRED } from '../../urls/events.js';
import { WORKSTREAM_DELETED, WORKSTREAM_UPSERTED } from '../../workstreams/events.js';
import type { AcceptedEvent } from '../causal.js';
import {
  dedupeInvalidationKeys,
  invalidationsForEvent,
  type InvalidationKey,
} from './invalidation.js';

const makeEvent = (type: string, payload: unknown): AcceptedEvent => ({
  clientEventId: 'evt-1',
  dot: { replicaId: 'replica-A', seq: 1 },
  deps: {},
  aggregateId: 'agg',
  type,
  payload,
  acceptedAtMs: 1_700_000_000_000,
});

describe('Stage 5.2 W6 — invalidation rules', () => {
  it('user.organized.item canonical-url → url slice', () => {
    const keys = invalidationsForEvent(
      makeEvent(USER_ORGANIZED_ITEM, {
        itemKind: 'canonical-url',
        itemId: 'https://example.com/a',
        action: 'move',
        toContainer: 'ws_x',
      }),
    );
    expect(keys).toEqual([{ kind: 'url', canonicalUrl: 'https://example.com/a' }]);
  });

  it('user.organized.item tab-session → tabSession slice', () => {
    const keys = invalidationsForEvent(
      makeEvent(USER_ORGANIZED_ITEM, {
        itemKind: 'tab-session',
        itemId: 'tses_abc',
        action: 'move',
        toContainer: 'ws_x',
      }),
    );
    expect(keys).toEqual([{ kind: 'tabSession', tabSessionId: 'tses_abc' }]);
  });

  it('user.organized.item thread → thread slice', () => {
    const keys = invalidationsForEvent(
      makeEvent(USER_ORGANIZED_ITEM, {
        itemKind: 'thread',
        itemId: 'bac_thread_x',
        action: 'move',
        toContainer: 'ws_x',
      }),
    );
    expect(keys).toEqual([{ kind: 'thread', bacId: 'bac_thread_x' }]);
  });

  it('user.engagement.relabeled → engagementVisit + rankerLabels', () => {
    const keys = invalidationsForEvent(
      makeEvent(USER_ENGAGEMENT_RELABELED, { visitId: 'visit-1' }),
    );
    expect(keys).toEqual([
      { kind: 'engagementVisit', visitId: 'visit-1' },
      { kind: 'rankerLabels' },
    ]);
  });

  it('user.flow.confirmed produces a topicMember per visit', () => {
    const keys = invalidationsForEvent(
      makeEvent(USER_FLOW_CONFIRMED, { visitIds: ['v1', 'v2'] }),
    );
    expect(keys).toEqual([
      { kind: 'topicMember', visitId: 'v1' },
      { kind: 'topicMember', visitId: 'v2' },
    ]);
  });

  it('user.flow.rejected produces a topicMember per visit', () => {
    const keys = invalidationsForEvent(
      makeEvent(USER_FLOW_REJECTED, { visitIds: ['v1'] }),
    );
    expect(keys).toEqual([{ kind: 'topicMember', visitId: 'v1' }]);
  });

  it('workstream.upserted produces workstream + tree + pathMemo', () => {
    const keys = invalidationsForEvent(
      makeEvent(WORKSTREAM_UPSERTED, { bac_id: 'ws_x', title: 'X' }),
    );
    expect(keys).toEqual([
      { kind: 'workstream', bacId: 'ws_x' },
      { kind: 'workstreamTree' },
      { kind: 'workstreamPathMemo', bacId: 'ws_x' },
    ]);
  });

  it('workstream.deleted produces workstream + tree + pathMemo', () => {
    const keys = invalidationsForEvent(
      makeEvent(WORKSTREAM_DELETED, { bac_id: 'ws_x' }),
    );
    expect(keys).toEqual([
      { kind: 'workstream', bacId: 'ws_x' },
      { kind: 'workstreamTree' },
      { kind: 'workstreamPathMemo', bacId: 'ws_x' },
    ]);
  });

  it('thread.upserted produces thread + url (thread-mapped URL)', () => {
    const keys = invalidationsForEvent(
      makeEvent(THREAD_UPSERTED, {
        bac_id: 'bac_thread',
        threadUrl: 'https://chatgpt.com/c/abc',
        title: 'Test',
        provider: 'chatgpt',
        lastSeenAt: '2026-05-12T00:00:00.000Z',
        tags: [],
      }),
    );
    expect(keys).toEqual([
      { kind: 'thread', bacId: 'bac_thread' },
      { kind: 'url', canonicalUrl: 'https://chatgpt.com/c/abc' },
    ]);
  });

  it('thread.archived produces thread + inboxFilter', () => {
    const keys = invalidationsForEvent(
      makeEvent(THREAD_ARCHIVED, { bac_id: 'bac_thread' }),
    );
    expect(keys).toEqual([
      { kind: 'thread', bacId: 'bac_thread' },
      { kind: 'inboxFilter' },
    ]);
  });

  it('urls.attribution.inferred → url slice', () => {
    const keys = invalidationsForEvent(
      makeEvent(URL_ATTRIBUTION_INFERRED, { canonicalUrl: 'https://example.com/a' }),
    );
    expect(keys).toEqual([{ kind: 'url', canonicalUrl: 'https://example.com/a' }]);
  });

  it('tabsession.attribution.inferred → tabSession slice', () => {
    const keys = invalidationsForEvent(
      makeEvent(TAB_SESSION_ATTRIBUTION_INFERRED, { tabSessionId: 'tses_x' }),
    );
    expect(keys).toEqual([{ kind: 'tabSession', tabSessionId: 'tses_x' }]);
  });

  it('queue.created → queue slice', () => {
    const keys = invalidationsForEvent(
      makeEvent(QUEUE_CREATED, { itemId: 'q-1' }),
    );
    expect(keys).toEqual([{ kind: 'queue', itemId: 'q-1' }]);
  });

  it('Group B — capture.recorded invalidates sourceUnit + recallIndex + contentSimilarity', () => {
    const keys = invalidationsForEvent(
      makeEvent(CAPTURE_RECORDED, { sourceUnitId: 'source-1' }),
    );
    expect(keys).toEqual([
      { kind: 'sourceUnit', sourceUnitId: 'source-1' },
      { kind: 'recallIndex', sourceUnitId: 'source-1' },
      { kind: 'contentSimilarity', sourceUnitId: 'source-1' },
    ]);
  });

  it('Group B — capture.extraction.produced adds extractionRevision', () => {
    const keys = invalidationsForEvent(
      makeEvent(CAPTURE_EXTRACTION_PRODUCED, {
        sourceUnitId: 'source-1',
        extractionRevisionId: 'ext-rev-1',
      }),
    );
    expect(keys).toEqual([
      { kind: 'sourceUnit', sourceUnitId: 'source-1' },
      { kind: 'recallIndex', sourceUnitId: 'source-1' },
      { kind: 'contentSimilarity', sourceUnitId: 'source-1' },
      { kind: 'extractionRevision', extractionRevisionId: 'ext-rev-1' },
    ]);
  });

  it('Group B — recall.tombstone.target wires resolverAnchors when affectedNodeIds present', () => {
    const keys = invalidationsForEvent(
      makeEvent(RECALL_TOMBSTONE_TARGET, {
        sourceUnitId: 'source-1',
        affectedNodeIds: ['thread:bac_a', 'tab-session:tses_b'],
      }),
    );
    expect(keys).toEqual([
      { kind: 'sourceUnit', sourceUnitId: 'source-1' },
      { kind: 'recallIndex', sourceUnitId: 'source-1' },
      { kind: 'contentSimilarity', sourceUnitId: 'source-1' },
      { kind: 'resolverAnchors', nodeIds: ['thread:bac_a', 'tab-session:tses_b'] },
    ]);
  });

  // Negative property — organization mutations MUST NOT trigger Group B
  // (re-embedding when only attribution changed is wasted work).
  it('user.organized.item does NOT invalidate Group B (sourceUnit / recallIndex / contentSimilarity)', () => {
    const keys = invalidationsForEvent(
      makeEvent(USER_ORGANIZED_ITEM, {
        itemKind: 'canonical-url',
        itemId: 'https://example.com/a',
        action: 'move',
        toContainer: 'ws_x',
      }),
    );
    expect(keys.some((k) => k.kind === 'sourceUnit')).toBe(false);
    expect(keys.some((k) => k.kind === 'recallIndex')).toBe(false);
    expect(keys.some((k) => k.kind === 'contentSimilarity')).toBe(false);
  });

  it('workstream.upserted does NOT invalidate Group B', () => {
    const keys = invalidationsForEvent(
      makeEvent(WORKSTREAM_UPSERTED, { bac_id: 'ws_x', title: 'X' }),
    );
    expect(keys.some((k) => k.kind === 'sourceUnit')).toBe(false);
  });

  it('annotation / dispatch events are graph-additive — produce no invalidations', () => {
    expect(invalidationsForEvent(makeEvent(ANNOTATION_CREATED, {}))).toEqual([]);
    expect(invalidationsForEvent(makeEvent(DISPATCH_RECORDED, {}))).toEqual([]);
  });

  it('unknown event type returns empty (caller decides)', () => {
    expect(invalidationsForEvent(makeEvent('unknown.event', {}))).toEqual([]);
  });

  it('payload missing required field → empty (defensive)', () => {
    expect(invalidationsForEvent(makeEvent(USER_ORGANIZED_ITEM, {}))).toEqual([]);
    expect(invalidationsForEvent(makeEvent(URL_ATTRIBUTION_INFERRED, {}))).toEqual([]);
  });
});

describe('Stage 5.2 W6 — dedupeInvalidationKeys', () => {
  it('keeps the first occurrence of each unique key', () => {
    const input: readonly InvalidationKey[] = [
      { kind: 'url', canonicalUrl: 'a' },
      { kind: 'url', canonicalUrl: 'b' },
      { kind: 'url', canonicalUrl: 'a' },
      { kind: 'workstreamTree' },
      { kind: 'workstreamTree' },
    ];
    expect(dedupeInvalidationKeys(input)).toEqual([
      { kind: 'url', canonicalUrl: 'a' },
      { kind: 'url', canonicalUrl: 'b' },
      { kind: 'workstreamTree' },
    ]);
  });

  it('treats key variants with different fields as distinct', () => {
    const input: readonly InvalidationKey[] = [
      { kind: 'workstreamPathMemo', bacId: 'a' },
      { kind: 'workstreamPathMemo', bacId: 'b' },
    ];
    expect(dedupeInvalidationKeys(input)).toHaveLength(2);
  });
});

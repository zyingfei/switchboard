import { describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import { projectReviewDraft, type ReviewProjectionAnchor } from './projection.js';

const anchor = (exact: string): ReviewProjectionAnchor => ({
  textQuote: { exact, prefix: 'pre-', suffix: '-suf' },
  textPosition: { start: 0, end: exact.length },
  cssSelector: 'main > p',
});

const event = (
  partial: {
    type: string;
    replicaId: string;
    seq: number;
    deps?: Record<string, number>;
    payload?: Record<string, unknown>;
    acceptedAtMs?: number;
  },
): AcceptedEvent => ({
  clientEventId: `${partial.replicaId}.${String(partial.seq)}`,
  dot: { replicaId: partial.replicaId, seq: partial.seq },
  deps: partial.deps ?? {},
  aggregateId: 't',
  type: partial.type,
  payload: partial.payload ?? {},
  acceptedAtMs: partial.acceptedAtMs ?? 0,
});

describe('projectReviewDraft', () => {
  it('returns a resolved-empty projection for an empty event list', () => {
    const projection = projectReviewDraft('t', 'url', []);
    expect(projection.spans).toEqual([]);
    expect(projection.overall).toEqual({ status: 'resolved' });
    expect(projection.verdict).toEqual({ status: 'resolved' });
    expect(projection.vector).toEqual({});
  });

  it('builds a single-span projection with comment + overall + verdict', () => {
    const events: AcceptedEvent[] = [
      event({
        type: 'review-draft.span.added',
        replicaId: 'A',
        seq: 1,
        payload: {
          spanId: 'span-1',
          anchor: anchor('hello'),
          quote: 'hello',
          comment: 'first take',
          capturedAt: '2026-05-05T11:59:00.000Z',
        },
      }),
      event({
        type: 'review-draft.comment.set',
        replicaId: 'A',
        seq: 2,
        deps: { A: 1 },
        payload: { spanId: 'span-1', text: 'second take' },
      }),
      event({
        type: 'review-draft.overall.set',
        replicaId: 'A',
        seq: 3,
        deps: { A: 2 },
        payload: { text: 'overall verdict prose' },
      }),
      event({
        type: 'review-draft.verdict.set',
        replicaId: 'A',
        seq: 4,
        deps: { A: 3 },
        payload: { value: 'agree' },
      }),
    ];
    const projection = projectReviewDraft('t', 'url', events);
    expect(projection.spans).toHaveLength(1);
    expect(projection.spans[0]?.comment).toMatchObject({ status: 'resolved', value: 'second take' });
    expect(projection.overall).toMatchObject({ status: 'resolved', value: 'overall verdict prose' });
    expect(projection.verdict).toMatchObject({ status: 'resolved', value: 'agree' });
    expect(projection.vector).toEqual({ A: 4 });
  });

  it('observed-remove: a remove that depends on the add hides it', () => {
    const events: AcceptedEvent[] = [
      event({
        type: 'review-draft.span.added',
        replicaId: 'A',
        seq: 1,
        payload: { spanId: 's', anchor: anchor('a'), quote: 'a' },
      }),
      event({
        type: 'review-draft.span.removed',
        replicaId: 'A',
        seq: 2,
        deps: { A: 1 },
        payload: { spanId: 's' },
      }),
    ];
    const projection = projectReviewDraft('t', 'url', events);
    expect(projection.spans).toEqual([]);
    expect(projection.tombstones.spanIds).toEqual(['s']);
  });

  it('add-wins on concurrent add+remove: the remove did not observe the add', () => {
    const events: AcceptedEvent[] = [
      event({
        type: 'review-draft.span.added',
        replicaId: 'A',
        seq: 1,
        payload: { spanId: 's', anchor: anchor('a'), quote: 'a' },
      }),
      event({
        // Remove from peer B with no deps — concurrent.
        type: 'review-draft.span.removed',
        replicaId: 'B',
        seq: 1,
        payload: { spanId: 's' },
      }),
    ];
    const projection = projectReviewDraft('t', 'url', events);
    expect(projection.spans.map((s) => s.spanId)).toEqual(['s']);
    expect(projection.tombstones.spanIds).toEqual([]);
  });

  it('concurrent comment edits surface as a conflict in the projection', () => {
    const events: AcceptedEvent[] = [
      event({
        type: 'review-draft.span.added',
        replicaId: 'A',
        seq: 1,
        payload: { spanId: 's', anchor: anchor('a'), quote: 'a' },
      }),
      event({
        type: 'review-draft.comment.set',
        replicaId: 'A',
        seq: 2,
        deps: { A: 1 },
        payload: { spanId: 's', text: 'A wrote' },
      }),
      event({
        type: 'review-draft.comment.set',
        replicaId: 'B',
        seq: 1,
        deps: { A: 1 },
        payload: { spanId: 's', text: 'B wrote' },
      }),
    ];
    const projection = projectReviewDraft('t', 'url', events);
    expect(projection.spans[0]?.comment.status).toBe('conflict');
    if (projection.spans[0]?.comment.status === 'conflict') {
      expect(projection.spans[0].comment.candidates.map((c) => c.value).sort()).toEqual([
        'A wrote',
        'B wrote',
      ]);
    }
  });

  it('a manual-merge resolves the conflict when its deps cover both candidates', () => {
    const events: AcceptedEvent[] = [
      event({
        type: 'review-draft.span.added',
        replicaId: 'A',
        seq: 1,
        payload: { spanId: 's', anchor: anchor('a'), quote: 'a' },
      }),
      event({
        type: 'review-draft.comment.set',
        replicaId: 'A',
        seq: 2,
        deps: { A: 1 },
        payload: { spanId: 's', text: 'A wrote' },
      }),
      event({
        type: 'review-draft.comment.set',
        replicaId: 'B',
        seq: 1,
        deps: { A: 1 },
        payload: { spanId: 's', text: 'B wrote' },
      }),
      event({
        // User merges manually, observing both candidates.
        type: 'review-draft.comment.set',
        replicaId: 'B',
        seq: 2,
        deps: { A: 2, B: 1 },
        payload: { spanId: 's', text: 'A wrote; B wrote' },
      }),
    ];
    const projection = projectReviewDraft('t', 'url', events);
    expect(projection.spans[0]?.comment).toMatchObject({
      status: 'resolved',
      value: 'A wrote; B wrote',
    });
  });

  it('discard wipes only events it causally observed; concurrent later adds revive the draft', () => {
    const events: AcceptedEvent[] = [
      event({
        type: 'review-draft.span.added',
        replicaId: 'A',
        seq: 1,
        payload: { spanId: 's', anchor: anchor('a'), quote: 'a' },
      }),
      event({
        type: 'review-draft.discarded',
        replicaId: 'A',
        seq: 2,
        deps: { A: 1 },
        payload: {},
      }),
      // Concurrent add from peer B that did NOT observe the discard.
      event({
        type: 'review-draft.span.added',
        replicaId: 'B',
        seq: 1,
        payload: { spanId: 's-peer', anchor: anchor('b'), quote: 'b' },
      }),
    ];
    const projection = projectReviewDraft('t', 'url', events);
    expect(projection.spans.map((s) => s.spanId)).toEqual(['s-peer']);
    expect(projection.discarded).toBe(false);
  });

  it('vector is the union of every event\'s dot.seq', () => {
    const events: AcceptedEvent[] = [
      event({
        type: 'review-draft.span.added',
        replicaId: 'A',
        seq: 5,
        payload: { spanId: 's', anchor: anchor('a'), quote: 'a' },
      }),
      event({
        type: 'review-draft.comment.set',
        replicaId: 'B',
        seq: 7,
        payload: { spanId: 's', text: 'b' },
      }),
    ];
    const projection = projectReviewDraft('t', 'url', events);
    expect(projection.vector).toEqual({ A: 5, B: 7 });
  });
});

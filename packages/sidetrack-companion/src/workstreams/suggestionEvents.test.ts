import { describe, expect, it } from 'bun:test';

import {
  isSuggestionAcceptedPayload,
  isSuggestionDeclinedPayload,
  suggestionAggregateId,
} from './suggestionEvents.js';

describe('suggestion accept/decline payload guards', () => {
  it('accepts a well-formed accepted payload', () => {
    expect(
      isSuggestionAcceptedPayload({
        payloadVersion: 1,
        suggestionSource: 'workstream-split',
        subjectKind: 'canonical-url',
        subjectId: 'https://a.test/x',
        workstreamId: 'ws-2',
      }),
    ).toBe(true);
  });

  it('accepts a well-formed declined payload with an opportunity id', () => {
    expect(
      isSuggestionDeclinedPayload({
        payloadVersion: 1,
        suggestionSource: 'workstream-new-category',
        subjectKind: 'canonical-url',
        subjectId: 'https://a.test/x',
        workstreamId: 'ws-3',
        servedOpportunityId: `laneopp_${'a'.repeat(32)}`,
      }),
    ).toBe(true);
  });

  it('rejects an unknown suggestionSource', () => {
    expect(
      isSuggestionDeclinedPayload({
        payloadVersion: 1,
        suggestionSource: 'not-a-source',
        subjectKind: 'canonical-url',
        subjectId: 'https://a.test/x',
        workstreamId: 'ws-3',
      }),
    ).toBe(false);
  });

  it('rejects a malformed servedOpportunityId', () => {
    expect(
      isSuggestionAcceptedPayload({
        payloadVersion: 1,
        suggestionSource: 'workstream-split',
        subjectKind: 'canonical-url',
        subjectId: 'https://a.test/x',
        workstreamId: 'ws-3',
        servedOpportunityId: 'not-a-real-id',
      }),
    ).toBe(false);
  });
});

describe('suggestionAggregateId', () => {
  it('is stable and distinguishes source/subject/workstream', () => {
    const a = suggestionAggregateId('workstream-split', 'canonical-url', 'https://a.test/x', 'ws-1');
    const b = suggestionAggregateId('workstream-split', 'canonical-url', 'https://a.test/x', 'ws-2');
    expect(a).not.toBe(b);
    expect(suggestionAggregateId('workstream-split', 'canonical-url', 'https://a.test/x', 'ws-1')).toBe(a);
  });
});

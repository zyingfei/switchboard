import { describe, expect, it } from 'vitest';

import { CompanionRequestError } from '../../../src/companion/client';
import {
  classifyResolveFailure,
  resolveErrorForStatus,
  suggestionStateFrom,
} from '../../../src/sidepanel/tabsession/resolveOutcome';
import type { TabSessionResolutionResult } from '../../../src/sidepanel/tabsession/types';

const candidate = () => ({
  workstreamId: 'ws_a',
  rawFusionLogit: 1.0,
  dominantSource: 'ppr' as const,
  reasons: [],
});

const populated = (): Pick<TabSessionResolutionResult, 'fusedCandidates'> => ({
  fusedCandidates: [candidate()],
});
const empty = (): Pick<TabSessionResolutionResult, 'fusedCandidates'> => ({
  fusedCandidates: [],
});

describe('suggestionStateFrom — error !== empty !== pending !== populated', () => {
  it('nothing yet = pending', () => {
    expect(suggestionStateFrom({})).toBe('pending');
  });

  it('a fetched result with no candidates = empty', () => {
    expect(suggestionStateFrom({ suggestion: empty() })).toBe('empty');
  });

  it('a fetched result with candidates = populated', () => {
    expect(suggestionStateFrom({ suggestion: populated() })).toBe('populated');
  });

  it('an error with no result = error (NOT pending, NOT empty)', () => {
    expect(suggestionStateFrom({ error: { kind: 'busy' } })).toBe('error');
  });

  it('error outranks a stale empty result (the core falsehood we fix)', () => {
    // A page we failed to resolve must never read as "no signal".
    expect(suggestionStateFrom({ suggestion: empty(), error: { kind: 'busy' } })).toBe('error');
  });

  it('a populated result outranks an error (keep the last good answer)', () => {
    expect(suggestionStateFrom({ suggestion: populated(), error: { kind: 'error' } })).toBe(
      'populated',
    );
  });
});

describe('resolveErrorForStatus — HTTP status to busy/error', () => {
  it('classifies 5xx as busy (companion up but contended)', () => {
    expect(resolveErrorForStatus(500)).toEqual({ kind: 'busy' });
    expect(resolveErrorForStatus(503)).toEqual({ kind: 'busy' });
  });

  it('classifies 408/429 (timeout/overload) as busy', () => {
    expect(resolveErrorForStatus(408)).toEqual({ kind: 'busy' });
    expect(resolveErrorForStatus(429)).toEqual({ kind: 'busy' });
  });

  it('classifies other 4xx as error', () => {
    expect(resolveErrorForStatus(400)).toEqual({ kind: 'error' });
    expect(resolveErrorForStatus(404)).toEqual({ kind: 'error' });
  });
});

describe('classifyResolveFailure — caught error to busy/error', () => {
  it('CompanionRequestError timeout = busy; network = error', () => {
    expect(classifyResolveFailure(new CompanionRequestError('slow', 'timeout'))).toEqual({
      kind: 'busy',
    });
    expect(classifyResolveFailure(new CompanionRequestError('down', 'network'))).toEqual({
      kind: 'error',
    });
  });

  it('extracts a 5xx status from the raw-fetch error message = busy', () => {
    // The batch/fan-out loaders throw plain Errors like `... failed (503).`
    expect(classifyResolveFailure(new Error('Companion resolve failed (503).'))).toEqual({
      kind: 'busy',
    });
  });

  it('an error carrying a numeric status property is honoured', () => {
    const err = Object.assign(new Error('boom'), { status: 500 });
    expect(classifyResolveFailure(err)).toEqual({ kind: 'busy' });
  });

  it('an unclassifiable failure defaults to error', () => {
    expect(classifyResolveFailure(new Error('something odd'))).toEqual({ kind: 'error' });
    expect(classifyResolveFailure('not an error')).toEqual({ kind: 'error' });
  });
});

import { describe, expect, it } from 'vitest';

import { isChromeSessionsRestorePayload } from './section15Events.js';

describe('isChromeSessionsRestorePayload', () => {
  it('accepts a valid url-matched restore', () => {
    expect(
      isChromeSessionsRestorePayload({ payloadVersion: 1, sessionId: 's-1', matchedOn: 'url' }),
    ).toBe(true);
  });

  it('accepts a url+title match with an optional threadId', () => {
    expect(
      isChromeSessionsRestorePayload({
        payloadVersion: 1,
        sessionId: 's-2',
        matchedOn: 'url+title',
        threadId: 'thread-abc',
      }),
    ).toBe(true);
  });

  it('rejects a missing sessionId', () => {
    expect(isChromeSessionsRestorePayload({ payloadVersion: 1, matchedOn: 'url' })).toBe(false);
  });

  it('rejects an unknown matchedOn', () => {
    expect(
      isChromeSessionsRestorePayload({ payloadVersion: 1, sessionId: 's', matchedOn: 'fuzzy' }),
    ).toBe(false);
  });

  it('rejects a wrong payloadVersion', () => {
    expect(
      isChromeSessionsRestorePayload({ payloadVersion: 2, sessionId: 's', matchedOn: 'url' }),
    ).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isChromeSessionsRestorePayload(null)).toBe(false);
    expect(isChromeSessionsRestorePayload('nope')).toBe(false);
    expect(isChromeSessionsRestorePayload([])).toBe(false);
  });
});

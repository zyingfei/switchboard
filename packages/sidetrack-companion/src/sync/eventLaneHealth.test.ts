import { afterEach, describe, expect, it } from 'vitest';

import {
  getEventLaneHealth,
  incrementDotCollisions,
  incrementDuplicateCaptures,
  incrementSkippedMalformedLines,
  incrementStoreSkippedOutOfOrder,
  incrementUnreadableShards,
  resetEventLaneHealthForTests,
} from './eventLaneHealth.js';

describe('event-lane health module', () => {
  afterEach(() => {
    resetEventLaneHealthForTests();
  });

  it('getEventLaneHealth returns a zeroed snapshot after reset', () => {
    resetEventLaneHealthForTests();
    expect(getEventLaneHealth()).toEqual({
      skippedMalformedLines: 0,
      storeSkippedOutOfOrder: 0,
      dotCollisions: 0,
      duplicateCaptures: 0,
      unreadableShards: 0,
    });
  });

  it('each increment bumps exactly its own field', () => {
    resetEventLaneHealthForTests();
    incrementSkippedMalformedLines();
    incrementStoreSkippedOutOfOrder();
    incrementStoreSkippedOutOfOrder();
    incrementDotCollisions();
    incrementDuplicateCaptures();
    incrementUnreadableShards();
    expect(getEventLaneHealth()).toEqual({
      skippedMalformedLines: 1,
      storeSkippedOutOfOrder: 2,
      dotCollisions: 1,
      duplicateCaptures: 1,
      unreadableShards: 1,
    });
  });

  it('the returned snapshot is a copy — mutating it does not change the counters', () => {
    resetEventLaneHealthForTests();
    const snapshot = getEventLaneHealth();
    (snapshot as { skippedMalformedLines: number }).skippedMalformedLines = 999;
    expect(getEventLaneHealth().skippedMalformedLines).toBe(0);
  });
});

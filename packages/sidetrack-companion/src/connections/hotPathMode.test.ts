import { afterEach, describe, expect, it } from 'vitest';

import {
  HOT_SIMILARITY_ENV,
  HOT_TOPICS_ENV,
  hotSimilarityModeEnabled,
  hotTopicsModeEnabled,
} from './hotPathMode.js';

describe('hot-path default-on resolvers (U2)', () => {
  afterEach(() => {
    delete process.env[HOT_SIMILARITY_ENV];
    delete process.env[HOT_TOPICS_ENV];
  });

  it('default ON when unset (was strict opt-in)', () => {
    delete process.env[HOT_SIMILARITY_ENV];
    delete process.env[HOT_TOPICS_ENV];
    expect(hotSimilarityModeEnabled()).toBe(true);
    expect(hotTopicsModeEnabled()).toBe(true);
  });

  it('legacy explicit opt-in "1" still means ON', () => {
    process.env[HOT_SIMILARITY_ENV] = '1';
    process.env[HOT_TOPICS_ENV] = '1';
    expect(hotSimilarityModeEnabled()).toBe(true);
    expect(hotTopicsModeEnabled()).toBe(true);
  });

  it('disabled only by off/false/0/none (case-insensitive, trimmed)', () => {
    for (const value of ['off', 'FALSE', '0', 'None', ' off ']) {
      process.env[HOT_SIMILARITY_ENV] = value;
      process.env[HOT_TOPICS_ENV] = value;
      expect(hotSimilarityModeEnabled()).toBe(false);
      expect(hotTopicsModeEnabled()).toBe(false);
    }
  });

  it('any other value stays ON', () => {
    process.env[HOT_SIMILARITY_ENV] = 'yes';
    process.env[HOT_TOPICS_ENV] = 'enabled';
    expect(hotSimilarityModeEnabled()).toBe(true);
    expect(hotTopicsModeEnabled()).toBe(true);
  });
});

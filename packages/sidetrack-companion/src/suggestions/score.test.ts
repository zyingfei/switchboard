import { describe, expect, it } from 'vitest';

import { scoreSuggestions } from './score.js';

describe('scoreSuggestions', () => {
  it('returns sorted suggestions above threshold with breakdowns', () => {
    const suggestions = scoreSuggestions(
      {
        thread: { id: 'thread_1' },
        workstreams: [{ id: 'ws_a' }, { id: 'ws_b' }],
        signals: {
          lexical: { ws_a: 1, ws_b: 0 },
          vector: { ws_a: 0.5, ws_b: 1 },
          link: { ws_a: 0, ws_b: 1 },
        },
      },
      { threshold: 0.5 },
    );

    expect(suggestions.map((item) => item.workstreamId)).toEqual(['ws_b', 'ws_a']);
    expect(suggestions[0]?.breakdown).toEqual({ lexical: 0, vector: 1, link: 1 });
  });

  it('omits all below threshold', () => {
    expect(
      scoreSuggestions({
        thread: { id: 'thread_1' },
        workstreams: [{ id: 'ws_a' }],
        signals: { lexical: {}, vector: {}, link: {} },
      }),
    ).toEqual([]);
  });
});

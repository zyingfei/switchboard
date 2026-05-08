import { describe, expect, it } from 'vitest';

import cases from './__fixtures__/topic-label-cases.json';
import { topicLabel, type TopicLabelInput } from './topicLabel';

describe('topicLabel', () => {
  it('matches the documented label fixtures', () => {
    for (const item of cases as readonly (TopicLabelInput & {
      readonly name: string;
      readonly expectedLabel: string;
      readonly expectedTooltip: string;
    })[]) {
      const result = topicLabel(item);

      expect(result.label, item.name).toBe(item.expectedLabel);
      expect(result.tooltip, item.name).toBe(item.expectedTooltip);
    }
  });
});

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WORK_GRAPH_EVAL_EXPECTED } from './workGraphEval.js';

interface WorkGraphExpectedJson {
  readonly positivePairs: readonly (readonly string[])[];
  readonly negativePairs: readonly (readonly string[])[];
  readonly expectedTopics: readonly {
    readonly cluster: string;
    readonly minimumMembers: number;
  }[];
  readonly expectedContinuationPairs: readonly (readonly string[])[];
  readonly expectedFeedbackEffect: {
    readonly rejectedPair: readonly string[];
    readonly expected: string;
  };
}

const expectedJsonPath = fileURLToPath(
  new URL('../../../../../data/eval/work-graph/expected.json', import.meta.url),
);

const readExpectedJson = async (): Promise<WorkGraphExpectedJson> =>
  JSON.parse(await readFile(expectedJsonPath, 'utf8')) as WorkGraphExpectedJson;

describe('work graph eval fixture', () => {
  it('keeps the documented eval expectations in sync with the fixture contract', async () => {
    await expect(readExpectedJson()).resolves.toEqual({
      positivePairs: WORK_GRAPH_EVAL_EXPECTED.positivePairs,
      negativePairs: WORK_GRAPH_EVAL_EXPECTED.negativePairs,
      expectedTopics: WORK_GRAPH_EVAL_EXPECTED.expectedTopicClusters,
      expectedContinuationPairs: WORK_GRAPH_EVAL_EXPECTED.continuationPairs,
      expectedFeedbackEffect: WORK_GRAPH_EVAL_EXPECTED.feedbackEffect,
    });
  });
});

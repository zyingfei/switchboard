import { describe, expect, it } from 'vitest';

import { VECTOR_CORPUS_REVISION } from '../../recall/vectorCorpus.js';
import {
  readRecallVectorProjectionState,
  RECALL_VECTOR_CORPUS_REVISION_KEY,
  RECALL_VECTOR_CORPUS_STATE_KEY,
} from './backfill.js';

const metadataReader = (entries: Readonly<Record<string, string>>) => ({
  getRecallMetadata: (key: string): string | undefined => entries[key],
});

describe('recall vector projection read-back state', () => {
  it('keeps absent, initialized-empty, and measured distinct', () => {
    expect(readRecallVectorProjectionState(metadataReader({}))).toEqual({ kind: 'absent' });
    expect(
      readRecallVectorProjectionState(
        metadataReader({
          [RECALL_VECTOR_CORPUS_REVISION_KEY]: VECTOR_CORPUS_REVISION,
          [RECALL_VECTOR_CORPUS_STATE_KEY]: 'empty',
        }),
      ),
    ).toEqual({ kind: 'empty', revision: VECTOR_CORPUS_REVISION });
    expect(
      readRecallVectorProjectionState(
        metadataReader({
          [RECALL_VECTOR_CORPUS_REVISION_KEY]: VECTOR_CORPUS_REVISION,
          [RECALL_VECTOR_CORPUS_STATE_KEY]: 'measured:12',
        }),
      ),
    ).toEqual({ kind: 'measured', revision: VECTOR_CORPUS_REVISION, vectors: 12 });
  });
});

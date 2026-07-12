import { afterEach, describe, expect, it, vi } from 'vitest';

import { RECALL_MODEL } from './modelManifest.js';

// B4 regression: the HF revision pinned in modelManifest must
// actually flow through to transformers.js's pipeline() call so the
// runtime artifact matches the index's MODEL_ID identity.
//
// vi.doMock + a fresh embedder import per test ensures the lazy
// extractorPromise inside embedder.ts gets re-evaluated against our
// mock — module state is otherwise persistent across tests.

// vi.doMock/vi.resetModules are vitest-runner internals with no bun test
// equivalent, and pipeline() has no DI seam (external heavy dep). This
// suite therefore runs only under `test:vitest`; bun test skips it.
const itVitestOnly = process.versions['bun'] === undefined ? it : it.skip;

describe('embedder pipeline-load options', () => {
  afterEach(() => {
    vi.doUnmock('@huggingface/transformers');
    vi.resetModules();
  });

  itVitestOnly('passes the manifest revision to pipeline()', async () => {
    const seenOptions: unknown[] = [];
    vi.doMock('@huggingface/transformers', () => ({
      env: {},
      pipeline: async (
        _task: string,
        _model: string,
        options: { readonly revision?: string; readonly dtype?: string; readonly device?: string },
      ) => {
        seenOptions.push(options);
        // Return a fake feature extractor that produces a unit
        // vector — embed() normalizes so the actual values don't
        // matter beyond shape.
        return async (
          _text: string,
          _opts: { readonly pooling: 'mean'; readonly normalize: true },
        ) => ({ data: new Array(384).fill(0).map((_, i) => (i === 0 ? 1 : 0)) });
      },
    }));

    const { embed } = await import('./embedder.js');
    await embed(['warmup']);
    expect(seenOptions.length).toBeGreaterThan(0);
    const first = seenOptions[0] as { readonly revision?: string };
    expect(first.revision).toBe(RECALL_MODEL.revision);
  });
});

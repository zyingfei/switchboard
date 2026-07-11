// Deterministic embedder stub, installed through the production
// dependency-injection seam (`setEmbedderOverride`) rather than a
// module mock. The suites that need a stub embedder previously used
// `vi.mock('../recall/embedder.js', ...)`. Under `bun test` that path
// is doubly broken: `vi.importActual` is undefined, and — the sharper
// hazard — `vi.mock` replaces the module PROCESS-GLOBALLY (all test
// files share one process), so a mock in server.test.ts poisoned the
// real `embed` that ingestor.test.ts and embedder.test.ts depend on.
// `setEmbedderOverride` is the real hook the runtime uses to route
// embedding through the sidecar; it swaps only the embed function and
// is torn down per-test, so no cross-file leakage. It also exercises
// exactly the call path production takes.
import { setEmbedderOverride } from '../recall/embedder.js';

// Vector shape for the stub.
//   'unit-axis-0' — every text maps to the same unit vector (v[0]=1).
//     Matches the recall/sync-contract suites, whose index-content and
//     cache-reuse assertions predate the migration.
//   'per-text-axis' — the i-th text in a batch maps to a unit vector
//     along axis (i % 384). Matches the HTTP server suite, which relies
//     on each query getting a distinct axis so the lexical signal is
//     the tie-breaker.
export type StubVectorShape = 'unit-axis-0' | 'per-text-axis';

const makeVectors = (texts: readonly string[], shape: StubVectorShape): Float32Array[] =>
  texts.map((_text, index) => {
    const v = new Float32Array(384);
    v[shape === 'per-text-axis' ? index % 384 : 0] = 1;
    return v;
  });

export interface StubEmbedderHandle {
  // Every batch of texts handed to the embedder, in call order. Lets a
  // suite assert cache-reuse ("embedder NOT called for unchanged text")
  // by inspecting call count / contents.
  readonly calls: { texts: string[] }[];
  // Arm a one-shot rejection: the NEXT embed() call rejects with this
  // error, then the state clears itself (mirrors the removed mock's
  // consume-once `nextEmbedError`). Used to drive the
  // RECALL_MODEL_MISSING route path. Reading it back returns the
  // still-armed error (null once consumed).
  nextEmbedError: Error | null;
  // Reset the recorded calls without reinstalling the override — used
  // between phases of a single test (seed vs. upgrade).
  readonly reset: () => void;
  // Remove the override. Call in afterEach so a later suite in the same
  // process starts from the real embedder path.
  readonly restore: () => void;
}

// Install the deterministic embedder override and return a handle for
// call inspection + error injection + teardown. Call in beforeEach;
// call `restore()` in afterEach.
export const installStubEmbedder = (
  options?: { readonly shape?: StubVectorShape },
): StubEmbedderHandle => {
  const shape = options?.shape ?? 'unit-axis-0';
  const calls: { texts: string[] }[] = [];
  const handle: StubEmbedderHandle = {
    calls,
    nextEmbedError: null,
    reset: () => {
      calls.length = 0;
    },
    restore: () => {
      setEmbedderOverride(undefined);
    },
  };
  setEmbedderOverride(async (texts: readonly string[]) => {
    calls.push({ texts: [...texts] });
    if (handle.nextEmbedError !== null) {
      const err = handle.nextEmbedError;
      handle.nextEmbedError = null;
      throw err;
    }
    return makeVectors(texts, shape);
  });
  return handle;
};

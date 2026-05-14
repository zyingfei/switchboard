// child_process.fork entry — owns the ONNX/transformers.js stack.
//
// Design: the main companion process spawns this entry via
// `child_process.fork` and talks to it over IPC. The child loads
// transformers.js + ONNX, warms the embedder once, then services
// `embed` requests. The main thread NEVER touches ONNX — so a long
// inference, a model download, or a native crash here has zero
// impact on /v1/status (or any other HTTP route).
//
// IPC frames:
//   parent → child: { kind: 'ping' }
//   parent → child: { kind: 'embed', id, texts }
//   child → parent: { kind: 'ready' }                — once model warmed
//   child → parent: { kind: 'embed-ok', id, vectors }
//   child → parent: { kind: 'embed-err', id, error }
//   child → parent: { kind: 'state', state, detail? } — coarse lifecycle
//
// The child only depends on `./embedder.js` (the in-process
// implementation) so the same embed code is used everywhere; we
// just isolate the process boundary.

import { embed as inProcessEmbed } from './embedder.js';

type ParentMessage =
  | { readonly kind: 'ping' }
  | { readonly kind: 'embed'; readonly id: number; readonly texts: readonly string[] };

type ChildMessage =
  | { readonly kind: 'ready' }
  | { readonly kind: 'state'; readonly state: 'cold' | 'warming' | 'ready' | 'failed'; readonly detail?: string }
  | { readonly kind: 'embed-ok'; readonly id: number; readonly vectors: readonly number[][] }
  | { readonly kind: 'embed-err'; readonly id: number; readonly error: string };

const post = (msg: ChildMessage): void => {
  process.send?.(msg);
};

let warmed = false;

const ensureWarm = async (): Promise<void> => {
  if (warmed) return;
  post({ kind: 'state', state: 'warming' });
  // One-shot embedding to force the transformers.js + ONNX model
  // load. After this point, embed() calls are bounded by inference
  // latency, not load latency.
  await inProcessEmbed(['warmup']);
  warmed = true;
  post({ kind: 'state', state: 'ready' });
  post({ kind: 'ready' });
};

process.on('message', (raw: unknown) => {
  const msg = raw as ParentMessage;
  if (msg.kind === 'ping') {
    void ensureWarm().catch((err: unknown) => {
      post({
        kind: 'state',
        state: 'failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    });
    return;
  }
  if (msg.kind === 'embed') {
    void (async () => {
      try {
        await ensureWarm();
        const vectors = await inProcessEmbed(msg.texts);
        // structuredClone preserves Float32Array, but `process.send`
        // serialises to JSON — so we copy into plain arrays.
        post({
          kind: 'embed-ok',
          id: msg.id,
          vectors: vectors.map((v) => Array.from(v)),
        });
      } catch (err: unknown) {
        post({
          kind: 'embed-err',
          id: msg.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }
});

post({ kind: 'state', state: 'cold' });
// Kick off the warmup eagerly so the first user-facing query
// doesn't pay the model-load latency.
void ensureWarm().catch((err: unknown) => {
  post({
    kind: 'state',
    state: 'failed',
    detail: err instanceof Error ? err.message : String(err),
  });
});

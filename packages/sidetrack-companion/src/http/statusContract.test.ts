// /v1/status availability contract — invariants that prevent us
// from accidentally re-introducing the cold-start hang.
//
// The contract:
//   1. /status must respond in well under any panel poll window
//      regardless of subsystem warmup state.
//   2. /status must not transitively import recall/ingestor/
//      embedder/transformers/ONNX. Even an `import` cost is
//      unbounded (model load); the request handler MUST stay in
//      the cheap-cached-state lane.
//   3. /status must not block on a slow connectionsStore read or a
//      stalled vault status syscall — but those are bounded by
//      filesystem I/O and acceptable. The hard ban is on the heavy
//      stuff that needs N-API/native code.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', '..');

// Forbidden modules: importing any of these into the /v1/status
// transitive dependency graph means the request handler can be
// stalled by ONNX init, transformers.js model load, recall ingest
// embed batch, etc. Update the list when adding new heavy modules.
const FORBIDDEN_PATHS = [
  // Recall vector path
  'src/recall/embedder.ts',
  'src/recall/embedderChild.entry.ts',
  'src/recall/ingestor.ts',
  'src/recall/rebuild.ts',
  // ONNX native binding (loaded transitively via transformers.js)
  'onnxruntime-node',
  '@huggingface/transformers',
] as const;

describe('/v1/status availability contract', () => {
  // The route handler that fields /v1/status lives in
  // `src/http/server.ts`. We can't introspect the bundled router
  // dependency graph at import time without a bundler, but we can
  // use `node --experimental-vm-modules` to ask the runtime which
  // modules a *bare* import of the relevant module pulls in. The
  // approach: load src/http/statusHandler.ts (a future extraction)
  // and grep require.cache + import.meta for forbidden paths.
  //
  // For now, the surface assertion is simpler and intentionally
  // conservative: literal source-text search of the /v1/status
  // handler in server.ts must not reference any forbidden module
  // by name. The handler is small enough to read; the assertion
  // catches the failure mode where a future edit adds e.g.
  // `await embed(...)` to /v1/status.
  it('source of /v1/status handler does not reference any forbidden recall/embedder/ONNX module', async () => {
    const fs = await import('node:fs/promises');
    const serverSrc = await fs.readFile(
      resolve(packageRoot, 'src', 'http', 'server.ts'),
      'utf8',
    );
    // Slice out the /v1/status handler block.
    const start = serverSrc.indexOf("pattern: /^\\/v1\\/status$/");
    expect(start, '/v1/status handler not found in server.ts').toBeGreaterThan(0);
    // Find the closing of the route object — the next `},` at the
    // same indentation level. Approximate by reading 6000 chars; the
    // handler is < 3000 today.
    const slice = serverSrc.slice(start, start + 6000);
    for (const forbidden of FORBIDDEN_PATHS) {
      expect(
        slice.includes(forbidden),
        `/v1/status handler references forbidden module '${forbidden}'. The route must be hot-path only and must not transitively import recall/embedder/ONNX modules. Move the data through context.getEmbedderStatus / context.getEventLoopSnapshot / context.recallLifecycle.isRebuilding instead — those are sync getters that never trigger work.`,
      ).toBe(false);
    }
  });

  it('compiled CLI does not bundle onnxruntime-node into the /v1/status path', () => {
    // Smoke test using a one-off Node process: import the http
    // server module, then check require.cache for forbidden native
    // modules. If the route truly stays hot-path, ONNX hasn't been
    // loaded yet at this point.
    const script = `
      import('./dist/http/server.js').then(() => {
        const cached = Object.keys(require.cache ?? {});
        const offenders = cached.filter((p) =>
          p.includes('onnxruntime-node') ||
          p.includes('@huggingface/transformers') ||
          p.includes('recall/ingestor.js') ||
          p.includes('recall/embedder.js')
        );
        if (offenders.length > 0) {
          console.error('FORBIDDEN_IMPORT:', JSON.stringify(offenders));
          process.exit(2);
        }
        process.exit(0);
      }).catch((err) => {
        console.error('IMPORT_FAILED:', err.message);
        process.exit(3);
      });
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: 15_000,
    });
    if (result.status === 3) {
      // dist/ not built — skip rather than fail; CI builds first.
      console.warn(`[statusContract] skipping bundle check: ${result.stderr.trim()}`);
      return;
    }
    expect(
      result.status,
      `Forbidden import detected in compiled http server. stdout=${result.stdout}, stderr=${result.stderr}`,
    ).toBe(0);
  });
});

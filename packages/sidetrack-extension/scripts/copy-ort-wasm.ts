// Copy the onnxruntime-web WASM + JSEP glue that transformers.js needs for the
// WebGPU generation engine into public/ort/, so wxt emits them into the MV3
// bundle and the extension loads them from its OWN origin (chrome-extension://…
// /ort/) — never from a CDN. This preserves the zero-outbound guarantee: the
// only network the WebGPU path touches is the LOCAL companion model host.
//
// transformers.js's WebGPU device uses the JSEP backend; at load time
// engine.ts sets env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('ort/')
// so ORT fetches ort-wasm-simd-threaded.jsep.{mjs,wasm} from here. We copy the
// base + jsep artifacts (the two the JSEP/WebGPU path resolves).
//
// The source is nested under transformers' own node_modules because
// onnxruntime-web is transformers' pinned transitive dep — this pins the wasm
// to the exact ORT build transformers expects (mismatched ORT wasm was the
// numeric-abort failure mode the PoC hit with 3.8.1). Idempotent; run from
// wxt.config.ts before every build/dev.

import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

// The files ORT's JSEP/WebGPU backend resolves at runtime. Base wasm is the
// fallback proxy; jsep.{mjs,wasm} is the WebGPU-capable build.
const ORT_FILES = [
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
];

const candidateDirs = [
  // transformers' pinned transitive onnxruntime-web (preferred — exact match).
  join(pkgRoot, 'node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist'),
  // hoisted onnxruntime-web, if the resolver hoisted it.
  join(pkgRoot, 'node_modules/onnxruntime-web/dist'),
];

// Probe for the base wasm to decide which candidate dir holds the ORT dist.
const PROBE_FILE = 'ort-wasm-simd-threaded.mjs';
const srcDir = candidateDirs.find((dir) => existsSync(join(dir, PROBE_FILE)));
const destDir = join(pkgRoot, 'public/ort');

export const copyOrtWasm = () => {
  if (srcDir === undefined) {
    // Non-fatal: the build still succeeds, but the WebGPU engine will fail to
    // load at runtime. Surface it loudly so a missing install is obvious.
    console.warn(
      '[copy-ort-wasm] onnxruntime-web dist not found; WebGPU engine assets NOT bundled. ' +
        'Run `bun add @huggingface/transformers` to restore.',
    );
    return { copied: 0, destDir };
  }
  mkdirSync(destDir, { recursive: true });
  let copied = 0;
  for (const file of ORT_FILES) {
    const src = join(srcDir, file);
    if (!existsSync(src)) continue;
    const dest = join(destDir, file);
    // Skip if already present with the same size (idempotent, fast on rebuilds).
    if (existsSync(dest) && statSync(dest).size === statSync(src).size) {
      copied += 1;
      continue;
    }
    copyFileSync(src, dest);
    copied += 1;
  }
  return { copied, destDir };
};

// Allow direct CLI use: `node scripts/copy-ort-wasm.ts` (or via a runner).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { copied, destDir: dir } = copyOrtWasm();
  console.log(`[copy-ort-wasm] ${String(copied)} ORT file(s) ready in ${dir}`);
}

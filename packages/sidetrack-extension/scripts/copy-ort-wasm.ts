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

import { existsSync, mkdirSync, copyFileSync, statSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

// Which ORT glue/wasm files to bundle. ORT-web picks ONE build variant at
// runtime from the capabilities it detects — jsep (WebGPU), jspi (JS Promise
// Integration), asyncify (single-thread/proxy fallback), or the base build —
// and dynamically imports the matching `ort-wasm-simd-threaded.<variant>.mjs`
// (which in turn fetches its `.wasm`). Shipping only the jsep pair looked
// right in the PoC (an http page), but the REAL extension load fell through
// to the asyncify variant and 404'd on a module we had not copied
// (chrome-extension://…/ort/ort-wasm-simd-threaded.asyncify.mjs — live MV3,
// 2026-07-27). So copy the WHOLE `ort-wasm-simd-threaded.*` family (8 small
// files) by prefix; ORT then finds whichever variant it resolves, all from
// our own origin, and a new ORT variant on upgrade is picked up automatically.
const ORT_FILE_PREFIX = 'ort-wasm-simd-threaded.';
const ORT_FILE_SUFFIXES = ['.mjs', '.wasm'];
const isOrtRuntimeFile = (name: string): boolean =>
  name.startsWith(ORT_FILE_PREFIX) && ORT_FILE_SUFFIXES.some((s) => name.endsWith(s));

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
  const files = readdirSync(srcDir).filter(isOrtRuntimeFile);
  for (const file of files) {
    const src = join(srcDir, file);
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

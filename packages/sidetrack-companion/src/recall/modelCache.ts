import { access, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { RECALL_MODEL } from './modelManifest.js';

// Sidetrack-managed model cache. Embedding models live under a
// product-owned directory so we can: prewarm them in a packaged
// release, point at them from an offline-mode launch, and surface
// "model present / verified" on /v1/system/health without poking
// inside HF's default cache layout.
//
// Default location follows OS conventions:
//   macOS    ~/Library/Application Support/Sidetrack/models
//   Linux    ~/.local/share/sidetrack/models
//   Windows  %LOCALAPPDATA%/Sidetrack/models
//
// Override with SIDETRACK_MODELS_DIR env or --models-dir CLI flag.
// Set SIDETRACK_OFFLINE_MODELS=1 (or pass --offline-models) to
// disable remote fetches; recall queries 503 with code
// RECALL_MODEL_MISSING when the cache is empty in that mode.

export interface ModelCacheStatus {
  readonly modelId: string;
  readonly revision: string;
  readonly cacheDir: string;
  readonly present: boolean;
  // Whether a checksum / sha verification matched the manifest. When
  // the manifest doesn't yet pin a real sha we fall through to a
  // presence-only check and report `verified: false` so the side
  // panel can surface the "unpinned model" signal without breaking
  // the recall path.
  readonly verified: boolean;
  readonly offline: boolean;
}

export interface ModelCacheOptions {
  readonly modelsDir?: string;
  readonly offline?: boolean;
}

const platformDefaultModelsDir = (): string => {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Sidetrack', 'models');
  }
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA'];
    if (typeof local === 'string' && local.length > 0) {
      return join(local, 'Sidetrack', 'models');
    }
    return join(homedir(), 'AppData', 'Local', 'Sidetrack', 'models');
  }
  // Linux / other Unix
  const xdgDataHome = process.env['XDG_DATA_HOME'];
  const dataHome =
    typeof xdgDataHome === 'string' && xdgDataHome.length > 0
      ? xdgDataHome
      : join(homedir(), '.local', 'share');
  return join(dataHome, 'sidetrack', 'models');
};

export const resolveModelsDir = (options: ModelCacheOptions = {}): string => {
  if (typeof options.modelsDir === 'string' && options.modelsDir.length > 0) {
    return resolve(options.modelsDir);
  }
  const env = process.env['SIDETRACK_MODELS_DIR'];
  if (typeof env === 'string' && env.length > 0) {
    return resolve(env);
  }
  return platformDefaultModelsDir();
};

export const isOfflineMode = (options: ModelCacheOptions = {}): boolean => {
  if (typeof options.offline === 'boolean') return options.offline;
  const env = process.env['SIDETRACK_OFFLINE_MODELS'];
  return env === '1' || env === 'true';
};

// HF transformers caches under <root>/<modelOrg>/<modelName>/...
// The modelId `Xenova/multilingual-e5-small` becomes the directory
// `Xenova/multilingual-e5-small`. We don't pin the exact internal
// layout (the HF lib reshapes it across releases); presence of any
// .onnx file under the model dir is the practical signal that the
// download landed.
const modelDir = (cacheDir: string, modelId: string): string => {
  const parts = modelId.split('/');
  return join(cacheDir, ...parts);
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

// Look for the cached HF revision token. transformers.js writes a
// `<modelDir>/refs/main` (or similarly-named ref file) containing
// the commit sha when it pulls the model. Probing for the exact
// path is brittle across HF / transformers.js versions, so we walk
// looking for ANY 40-char hex blob and treat it as a candidate
// revision marker.
const findCachedRevision = async (root: string): Promise<string | null> => {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) return null;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      // Common patterns: 'refs/main', 'refs/<branch>', files named
      // '<sha>.json' / '<sha>'. Also pick up any small text file
      // whose CONTENT is a 40-char hex string.
      if (/^[0-9a-f]{40}$/i.test(name)) return name.toLowerCase();
      if (name === 'main' || /^refs?$/.test(name) === false) {
        // Cheap probe: read short files only.
        try {
          const buf = await readFile(full, { encoding: 'utf8' });
          const trimmed = buf.trim();
          if (/^[0-9a-f]{40}$/i.test(trimmed)) return trimmed.toLowerCase();
        } catch {
          // Not a regular file or not readable; fall through.
        }
      }
      if (!name.includes('.') && !name.endsWith('.onnx')) {
        stack.push(full);
      }
    }
  }
  return null;
};

const findOnnxFile = async (root: string): Promise<string | null> => {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) return null;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      if (name.endsWith('.onnx') || name.endsWith('.onnx_data')) {
        return full;
      }
      // Recurse into subdirs without following symlinks. readdir w/
      // withFileTypes would be cleaner, but the lookup is cheap and
      // this avoids the extra fs.stat calls for what's typically a
      // 2-3 level tree (`<root>/<org>/<repo>/onnx/model_quantized.onnx`).
      if (!name.includes('.')) {
        stack.push(full);
      }
    }
  }
  return null;
};

export const getModelCacheStatus = async (
  options: ModelCacheOptions = {},
): Promise<ModelCacheStatus> => {
  const cacheDir = resolveModelsDir(options);
  const offline = isOfflineMode(options);
  const dir = modelDir(cacheDir, RECALL_MODEL.modelId);
  const present = await exists(dir).then(async (ok) =>
    ok ? (await findOnnxFile(dir)) !== null : false,
  );
  // When the cache holds a HF refs token whose sha matches the
  // pinned manifest revision, mark the model verified. Mismatch (or
  // absent token) → verified: false, which the side panel surfaces
  // as "model present but not pinned-sha-verified" so the user
  // knows whether a re-fetch is needed after a manifest bump.
  const cachedRevision = present ? await findCachedRevision(dir) : null;
  const verified =
    cachedRevision !== null &&
    cachedRevision.toLowerCase() === RECALL_MODEL.revision.toLowerCase();
  return {
    modelId: RECALL_MODEL.modelId,
    revision: RECALL_MODEL.revision,
    cacheDir,
    present,
    verified,
    offline,
  };
};

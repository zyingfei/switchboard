// Build-time provenance for the running companion.
//
// A companion runs as an invisible detached daemon; the sole reliable
// "which build is this" signal today is `codePath` (the entry script
// path). That catches a wrong-checkout swap but NOT a stale dist: the
// same `dist/cli.js` path can hold code compiled from an old commit
// hours ago (a real dogfood foot-gun — a 42h-old process ran
// unnoticed). BUILD_INFO.json closes that gap: the build step stamps
// the git short-sha + timestamp + branch into dist, and this reader
// surfaces them on /v1/version so `buildSha` can be diffed against the
// current checkout.
//
// The file is written by scripts/stamp-build.mjs after tsc. It sits at
// the dist root (dist/BUILD_INFO.json), the same directory as this
// module's compiled output (dist/build-info.js), so we resolve it
// relative to import.meta.url — no dependence on cwd or argv.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The additive fields exposed on /v1/version. Every field is nullable:
// a companion launched from an un-stamped dist (e.g. a raw
// `tsc`-only build, or a unit test importing the module directly) must
// degrade to nulls, never crash.
export interface BuildInfo {
  readonly buildSha: string | null;
  readonly buildTime: string | null;
  readonly buildBranch: string | null;
}

const EMPTY_BUILD_INFO: BuildInfo = {
  buildSha: null,
  buildTime: null,
  buildBranch: null,
};

// Shape of the on-disk artifact. Fields are validated defensively:
// a malformed or partial file yields nulls for the bad fields rather
// than propagating a wrong-typed value onto the API surface.
interface BuildInfoFile {
  readonly sha?: unknown;
  readonly builtAt?: unknown;
  readonly branch?: unknown;
}

const asStringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

// Resolve dist/BUILD_INFO.json relative to this module's location.
// In production this module compiles to dist/build-info.js, so the
// sibling is dist/BUILD_INFO.json. When run from src via ts tooling
// the sibling won't exist — that path just yields nulls.
const resolveBuildInfoPath = (): string => {
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), 'BUILD_INFO.json');
};

let cached: BuildInfo | undefined;

// Read build provenance from disk. Cached after the first call: the
// artifact is immutable for a given dist, so re-reading per request
// would be wasted I/O on a hot endpoint. Any failure (missing file,
// bad JSON) resolves to EMPTY_BUILD_INFO and is cached too, so a
// missing file costs one stat, not one per /v1/version poll.
//
// `overridePath` exists only for tests: it points the reader at a
// fixture file and bypasses the cache, so one process can exercise
// both the present-file and absent-file branches deterministically.
// Production callers pass nothing.
export const readBuildInfo = (overridePath?: string): BuildInfo => {
  if (overridePath === undefined && cached !== undefined) {
    return cached;
  }
  let value: BuildInfo;
  try {
    const raw = readFileSync(overridePath ?? resolveBuildInfoPath(), 'utf8');
    const parsed = JSON.parse(raw) as BuildInfoFile;
    value = {
      buildSha: asStringOrNull(parsed.sha),
      buildTime: asStringOrNull(parsed.builtAt),
      buildBranch: asStringOrNull(parsed.branch),
    };
  } catch {
    value = EMPTY_BUILD_INFO;
  }
  if (overridePath === undefined) {
    cached = value;
  }
  return value;
};

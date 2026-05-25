// Recall v2 — shadow-query dev mode.
//
// When `SIDETRACK_RECALL_SHADOW=1` is set on the companion, every
// /v2/recall call ALSO runs N alternate pipelines and logs all diffs
// to `/tmp/sidetrack-recall-shadow.log`. Shadow variants:
//   - sqlite-vs-minisearch — SQLite FTS5 (primary) vs MiniSearch fallback
//   - rerank-on-vs-off     — primary off vs same-call rerank applied
//   - vec-on-vs-off        — sqlite-vec primary vs JSON-sidecar fallback
//                            (currently always falls back due to Bun
//                            sqlite-vec extension load blocker)
//
// Implementation is FIRE-AND-FORGET — shadows run after the primary
// response is returned, so they never block the user. Errors are
// swallowed; this is dev-only telemetry.

import { appendFile } from 'node:fs/promises';

import type { RecallCandidate, RecallRequest, RecallResponse } from './types.js';

const SHADOW_LOG_PATH = '/tmp/sidetrack-recall-shadow.log';

export const shadowQueryEnabled = (): boolean =>
  process.env['SIDETRACK_RECALL_SHADOW'] === '1';

/** Which shadow comparisons to run when shadow mode is active. */
export interface ShadowVariants {
  readonly comparePrimaryToFallback: boolean; // SQLite vs MiniSearch
  readonly compareRerankOnOff: boolean;
  readonly compareVecOnOff: boolean;
}

export const shadowVariantsFromEnv = (): ShadowVariants => ({
  comparePrimaryToFallback: process.env['SIDETRACK_SHADOW_SQLITE_VS_LEGACY'] !== '0',
  compareRerankOnOff: process.env['SIDETRACK_SHADOW_RERANK'] === '1',
  compareVecOnOff: process.env['SIDETRACK_SHADOW_VEC'] === '1',
});

const topKUrls = (results: readonly RecallCandidate[], k: number): string[] =>
  results
    .slice(0, k)
    .map((r) => r.canonicalUrl ?? r.entityId)
    .filter((s): s is string => typeof s === 'string');

const diffLists = (primary: readonly string[], shadow: readonly string[]): string => {
  const set = new Set(primary);
  const both = shadow.filter((u) => set.has(u));
  const onlyPrimary = primary.filter((u) => !shadow.includes(u));
  const onlyShadow = shadow.filter((u) => !primary.includes(u));
  return JSON.stringify(
    {
      both,
      onlyPrimary,
      onlyShadow,
      primary,
      shadow,
    },
    null,
    2,
  );
};

/** Log a single (primary, shadow, label) comparison. */
export const logShadowDiff = async (
  req: RecallRequest,
  primary: RecallResponse,
  shadow: RecallResponse,
  variant = 'sqlite-vs-minisearch',
): Promise<void> => {
  try {
    const k = req.limit ?? 12;
    const primaryUrls = topKUrls(primary.results, k);
    const shadowUrls = topKUrls(shadow.results, k);
    const entry = `
========================================
${new Date().toISOString()}  variant=${variant}
q: ${req.q}
diff (primary vs shadow):
${diffLists(primaryUrls, shadowUrls)}
`;
    await appendFile(SHADOW_LOG_PATH, entry, 'utf8');
  } catch {
    // Dev-only telemetry; never break the request path.
  }
};

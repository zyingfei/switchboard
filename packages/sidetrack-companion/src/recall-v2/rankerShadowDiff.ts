// Ranker gate enforcement — shadow-diff measurement.
//
// The LightGBM lambdamart-v6 impression ranker can PASS its ship gate
// (workGraph `shipGateV2.status === 'pass'`) while serving still uses the
// RRF + cross-encoder + hand-tiering order — i.e. the earned pass is inert
// (`servingGateEnforced: false`). Before flipping enforcement on a live
// vault, we need to KNOW how different the v6 order actually is from what
// we serve today. That is what this module measures.
//
// Per served /v2 recall request, when a warm + ship-gate-passed v6 model is
// available, `recordRankerShadowDiff` compares the SERVED order against the
// v6-reranked order over the SAME candidate set and records two cheap,
// read-only divergence metrics into a per-vault rolling window:
//   - topKOverlap  — |served[:k] ∩ v6[:k]| / k. Membership churn in the
//                    band the user actually sees; 1.0 = identical top-k set.
//   - kendallTau   — rank-correlation over the shared entities (−1..1);
//                    1.0 = identical order, 0 = uncorrelated, <0 = inverted.
// Both are O(N log N) over the served candidate list (N ~= the served
// limit, ~20), and the v6 order itself is produced from the already-warm
// FeatureModel + booster (the heavy buildFeatureModel is amortized in the
// background TTL cache in learnedRerank.ts) — so the added per-request cost
// is the featurize+predict loop already paid when enforcement is ON. No
// second model build, no full-log read on the hot path.
//
// This is DEFAULT-ON (read-only measurement is cheap and wanted broadly)
// with an env kill switch `SIDETRACK_RANKER_SHADOW_DIFF=0` (explicit-disable
// convention, matching servedFeatureCaptureEnabled). The accumulator is
// surfaced through the health workGraph `ranker.shipGateV2.shadowDiff`
// section by folding the live snapshot onto the report at the health
// serving seam (server.ts), so it reflects request-driven measurement even
// when the base report is served from the drain-time artifact.

const DEFAULT_TOP_K = 10;
const DEFAULT_WINDOW = 200;

/** Divergence snapshot surfaced on the health workGraph. */
export interface RankerShadowDiffSnapshot {
  /** Number of requests contributing to the rolling window. */
  readonly requests: number;
  /** Mean top-k overlap across the window (0..1); 1.0 = served == v6 top-k set. */
  readonly meanTopKOverlap: number;
  /** Mean Kendall-tau across the window (−1..1); 1.0 = identical order. */
  readonly meanKendallTau: number;
  /** The k used for the top-k overlap metric. */
  readonly topK: number;
  /** ISO timestamp of the most recent recorded request, or null when empty. */
  readonly lastComputedAt: string | null;
}

interface WindowEntry {
  readonly topKOverlap: number;
  readonly kendallTau: number;
  readonly atMs: number;
}

interface VaultWindow {
  readonly entries: WindowEntry[];
  lastAtMs: number;
}

// Process-global rolling window, keyed by vaultRoot (one companion == one
// vault, but keep isolation for multi-vault test setups — same convention
// as learnedRerank.ts / servedFeatureModel.ts).
const windowByVault = new Map<string, VaultWindow>();

/** Read the kill switch at call time so an operator/test flip takes effect
 *  without a restart. Default ON; disable with `SIDETRACK_RANKER_SHADOW_DIFF=0`
 *  (or "off"). */
export const rankerShadowDiffEnabled = (): boolean => {
  const raw = process.env['SIDETRACK_RANKER_SHADOW_DIFF'];
  return raw !== '0' && raw !== 'off';
};

const windowSize = (): number => {
  const raw = Number(process.env['SIDETRACK_RANKER_SHADOW_DIFF_WINDOW']);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_WINDOW;
};

const topK = (): number => {
  const raw = Number(process.env['SIDETRACK_RANKER_SHADOW_DIFF_TOP_K']);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_TOP_K;
};

// Test-only: clear the rolling window so counts start fresh.
export const __resetRankerShadowDiffForTests = (): void => {
  windowByVault.clear();
};

/** |a[:k] ∩ b[:k]| / k. When either list is shorter than k the denominator
 *  is the smaller of (k, both lengths) so a short-but-identical result reads
 *  as 1.0 rather than being penalised for missing slots. */
export const topKOverlap = (
  served: readonly string[],
  v6: readonly string[],
  k: number,
): number => {
  const denom = Math.min(k, Math.max(served.length, v6.length));
  if (denom === 0) return 1;
  const servedTop = new Set(served.slice(0, k));
  let shared = 0;
  for (const id of v6.slice(0, k)) if (servedTop.has(id)) shared += 1;
  return shared / denom;
};

/** Kendall-tau rank correlation over the entities present in BOTH orders.
 *  Concordant−discordant pairs normalised by the pair count. Returns 1 when
 *  fewer than two shared entities exist (nothing to disagree about). */
export const kendallTau = (served: readonly string[], v6: readonly string[]): number => {
  const rankInV6 = new Map<string, number>();
  v6.forEach((id, index) => {
    if (!rankInV6.has(id)) rankInV6.set(id, index);
  });
  const shared: number[] = [];
  const seen = new Set<string>();
  for (const id of served) {
    const r = rankInV6.get(id);
    if (r !== undefined && !seen.has(id)) {
      shared.push(r);
      seen.add(id);
    }
  }
  const n = shared.length;
  if (n < 2) return 1;
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      // served order is i<j by construction; compare their v6 ranks.
      const left = shared[i];
      const right = shared[j];
      if (left === undefined || right === undefined) continue;
      if (left < right) concordant += 1;
      else if (left > right) discordant += 1;
    }
  }
  const pairs = (n * (n - 1)) / 2;
  if (pairs === 0) return 1;
  return (concordant - discordant) / pairs;
};

/** Record one served-vs-v6 divergence sample for `vaultRoot`. Pure metric
 *  math + a bounded push onto the rolling window; no I/O, no model work
 *  (the caller supplies both already-computed orders). Cheap enough to run
 *  inline on the /v2 hot path. No-op when the kill switch is off. */
export const recordRankerShadowDiff = (
  vaultRoot: string,
  servedOrder: readonly string[],
  v6Order: readonly string[],
  nowMs: number,
): void => {
  if (!rankerShadowDiffEnabled()) return;
  const k = topK();
  const entry: WindowEntry = {
    topKOverlap: topKOverlap(servedOrder, v6Order, k),
    kendallTau: kendallTau(servedOrder, v6Order),
    atMs: nowMs,
  };
  let window = windowByVault.get(vaultRoot);
  if (window === undefined) {
    window = { entries: [], lastAtMs: nowMs };
    windowByVault.set(vaultRoot, window);
  }
  window.entries.push(entry);
  window.lastAtMs = nowMs;
  const cap = windowSize();
  while (window.entries.length > cap) window.entries.shift();
};

/** Snapshot the rolling divergence window for `vaultRoot`, or null when no
 *  request has recorded a sample yet (shadow off, cold model, or no traffic).
 *  Read-only — used by the health serving seam to fold live measurement onto
 *  the workGraph report. */
export const peekRankerShadowDiff = (vaultRoot: string): RankerShadowDiffSnapshot | null => {
  const window = windowByVault.get(vaultRoot);
  if (window === undefined || window.entries.length === 0) return null;
  const requests = window.entries.length;
  let overlapSum = 0;
  let tauSum = 0;
  for (const entry of window.entries) {
    overlapSum += entry.topKOverlap;
    tauSum += entry.kendallTau;
  }
  return {
    requests,
    meanTopKOverlap: overlapSum / requests,
    meanKendallTau: tauSum / requests,
    topK: topK(),
    lastComputedAt: new Date(window.lastAtMs).toISOString(),
  };
};

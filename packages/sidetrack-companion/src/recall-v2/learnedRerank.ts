// P3 — /v2 learned re-rank. Apply the impression-trained, ship-gate-
// passed LightGBM ranker as a re-rank stage on /v2 results, AFTER the
// cross-encoder. Training surface = serving surface: the model's labels
// come from /v2 served impressions, so this is the only place its
// learned order can actually be served.
//
// Serve-on-PASS-only. This is a strict no-op unless the ACTIVE ranker is
//   (a) trained from impressions (manifest.trainedFromImpressions),
//   (b) a serveable lightgbm_lambdamart artifact, and
//   (c) its impression ship gate PASSED (learned order already beat the
//       RRF + cross-encoder baseline on labeled impressions).
// That ship gate IS the serve guard the plan calls for — the impression
// trainer computes "learned-order vs served-order over labeled
// impressions" and only an active+passing model reaches here.
//
// Train/serve feature parity (the chosen design): features are extracted
// with the SAME full context the trainer used — the connections snapshot
// + merged log — via `extractFeaturesWithModel`. The catch is
// `buildFeatureModel` is heavy (it's why the materializer runs it in a
// child). So it is built ONCE per TTL in the BACKGROUND and reused across
// requests; a /v2 request NEVER blocks on it. While no model is built
// yet (cold) or a refresh is in flight, the request serves the
// cross-encoder order unchanged. This keeps the hot path free of the
// full-log read / model-build that is this codebase's documented freeze
// cause, while preserving exact feature parity once warm.
//
// Flag-gated: `SIDETRACK_RECALL_LEARNED_RERANK` (default OFF). TTL via
// `SIDETRACK_RECALL_LEARNED_RERANK_TTL_MS` (default 120s).

import type { ConnectionsSnapshot } from '../connections/snapshot.js';
import {
  buildFeatureModel,
  extractFeaturesWithModel,
  type FeatureModel,
} from '../ranker/features.js';
import {
  type ActiveRankerHandle,
  loadActiveRanker,
  predictActive,
} from '../ranker/predict.js';
import {
  candidateSourceFor,
  retrievalContextForCandidates,
  servedCandidateFromRecallCandidate,
} from '../ranker/retrain-impressions.js';
import { selectActiveRanker } from '../ranker/select.js';
import type { Candidate } from '../ranker/types.js';
import {
  readActiveClosestVisitRankerRevisionManifest,
  readClosestVisitRankerRevision,
} from '../producers/closest-visit-revision.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { RecallCandidate } from './types.js';

const DEFAULT_TTL_MS = 120_000;

export const recallLearnedRerankEnabled = (): boolean =>
  process.env['SIDETRACK_RECALL_LEARNED_RERANK'] === '1';

const ttlMs = (): number => {
  const raw = Number(process.env['SIDETRACK_RECALL_LEARNED_RERANK_TTL_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
};

export interface LearnedRerankContext {
  readonly snapshot: ConnectionsSnapshot;
  // The feature-relevant merged window (nav / timeline / snippet /
  // engagement / flow events). NOT the full readMerged — see the wiring.
  readonly merged: readonly AcceptedEvent[];
}

export interface LearnedRerankDeps {
  readonly vaultRoot: string;
  // Reads the snapshot + merged window for the background model build.
  // Called at most once per TTL (on refresh), never inline per request.
  readonly loadContext: () => Promise<LearnedRerankContext | null>;
  readonly now?: () => number;
}

export type LearnedRerankReason =
  | 'applied'
  | 'cold'
  | 'building'
  | 'not-serveable'
  | 'too-few'
  | 'disabled';

export interface LearnedRerankResult {
  readonly results: readonly RecallCandidate[];
  readonly applied: boolean;
  readonly revisionId: string | null;
  readonly reason: LearnedRerankReason;
}

interface ServeableModel {
  readonly revisionId: string;
  readonly handle: ActiveRankerHandle;
  readonly model: FeatureModel;
  readonly builtAtMs: number;
}

interface GateMark {
  readonly atMs: number;
  readonly serveable: boolean;
  readonly revisionId: string | null;
}

// One companion process == one vault, but key by vaultRoot so multi-vault
// test setups stay isolated.
const modelByVault = new Map<string, ServeableModel>();
const gateByVault = new Map<string, GateMark>();
const refreshing = new Set<string>();

const disposeModel = (vaultRoot: string): void => {
  const existing = modelByVault.get(vaultRoot);
  if (existing !== undefined) {
    existing.handle.dispose();
    modelByVault.delete(vaultRoot);
  }
};

// Test-only: clear all cached state so a flag/TTL change takes effect.
export const __resetLearnedRerankCacheForTests = (): void => {
  for (const vaultRoot of modelByVault.keys()) disposeModel(vaultRoot);
  modelByVault.clear();
  gateByVault.clear();
  refreshing.clear();
};

// Background refresh: re-check the gate and (when serveable) rebuild the
// FeatureModel + booster handle. Never awaited by a request.
const refresh = async (deps: LearnedRerankDeps, nowMs: number): Promise<void> => {
  if (refreshing.has(deps.vaultRoot)) return;
  refreshing.add(deps.vaultRoot);
  try {
    const manifest = await readActiveClosestVisitRankerRevisionManifest(deps.vaultRoot);
    const markNotServeable = (revisionId: string | null): void => {
      disposeModel(deps.vaultRoot);
      gateByVault.set(deps.vaultRoot, { atMs: nowMs, serveable: false, revisionId });
    };
    if (manifest === null || manifest.trainedFromImpressions !== true) {
      markNotServeable(manifest?.revisionId ?? null);
      return;
    }
    const revision = await readClosestVisitRankerRevision(deps.vaultRoot, manifest.revisionId);
    if (revision === null) {
      markNotServeable(manifest.revisionId);
      return;
    }
    const selection = selectActiveRanker(revision);
    // Serve only a LEARNED artifact (not the deterministic graph_baseline)
    // whose impression ship gate PASSED. That gate already compared the
    // learned order against the RRF + cross-encoder baseline over labeled
    // impressions, so a passing model is one that beat today's serve order.
    if (selection.selectedKind === 'graph_baseline' || selection.shipGateStatus !== 'pass') {
      markNotServeable(manifest.revisionId);
      return;
    }
    const context = await deps.loadContext();
    if (context === null) {
      // Can't build right now — keep any prior good model; just refresh
      // the gate mark so we retry next TTL.
      gateByVault.set(deps.vaultRoot, { atMs: nowMs, serveable: true, revisionId: manifest.revisionId });
      return;
    }
    const model = buildFeatureModel(context.merged, context.snapshot);
    const handle = await loadActiveRanker(revision);
    const previous = modelByVault.get(deps.vaultRoot);
    modelByVault.set(deps.vaultRoot, {
      revisionId: manifest.revisionId,
      handle,
      model,
      builtAtMs: nowMs,
    });
    if (previous !== undefined && previous.handle !== handle) previous.handle.dispose();
    gateByVault.set(deps.vaultRoot, { atMs: nowMs, serveable: true, revisionId: manifest.revisionId });
  } catch (err) {
    console.warn('[recall-v2] learned-rerank refresh failed:', err);
  } finally {
    refreshing.delete(deps.vaultRoot);
  }
};

// Re-order `results` by the learned model's score over the SAME feature
// builders the trainer used (servedCandidate snapshot → retrievalContext;
// candidate {from: anchor, to, sources} → extractFeaturesWithModel). Pure
// given (model, handle); exported for unit tests.
export const reorderByLearnedScore = (
  anchorId: string,
  results: readonly RecallCandidate[],
  rankDeltaByEntity: ReadonlyMap<string, number>,
  model: FeatureModel,
  handle: ActiveRankerHandle,
  nowMs: number,
): readonly RecallCandidate[] => {
  const snapshots = results.map((candidate, position) =>
    servedCandidateFromRecallCandidate(candidate, position),
  );
  const retrievalContext = retrievalContextForCandidates(anchorId, snapshots, rankDeltaByEntity);
  const scored = results.map((candidate, position) => {
    const toVisitId = candidate.canonicalUrl ?? candidate.entityId;
    const pair: Candidate = {
      fromVisitId: anchorId,
      toVisitId,
      sources: [candidateSourceFor(candidate.sourceKind)],
      generatedAt: nowMs,
    };
    const features = extractFeaturesWithModel(pair, model, retrievalContext);
    const { score } = predictActive(features, handle);
    return { candidate, score, position };
  });
  // Stable sort: learned score desc, ties keep the cross-encoder order.
  return [...scored]
    .sort((left, right) => right.score - left.score || left.position - right.position)
    .map((entry) => entry.candidate);
};

// Re-rank `results` (post cross-encoder) with the learned model when one
// is warm + serveable. Never blocks on the model build — kicks a
// background refresh when stale and serves the existing order meanwhile.
export const applyLearnedRerank = async (
  deps: LearnedRerankDeps,
  anchorId: string,
  results: readonly RecallCandidate[],
  rankDeltaByEntity: ReadonlyMap<string, number>,
): Promise<LearnedRerankResult> => {
  const nowMs = (deps.now ?? Date.now)();
  if (results.length <= 1) {
    return { results, applied: false, revisionId: null, reason: 'too-few' };
  }

  const cached = modelByVault.get(deps.vaultRoot);
  const gate = gateByVault.get(deps.vaultRoot);
  const modelStale = cached === undefined || nowMs - cached.builtAtMs >= ttlMs();
  const gateStale = gate === undefined || nowMs - gate.atMs >= ttlMs();
  if (modelStale || gateStale) void refresh(deps, nowMs);

  if (cached === undefined) {
    if (gate?.serveable === false) {
      return { results, applied: false, revisionId: gate.revisionId, reason: 'not-serveable' };
    }
    return {
      results,
      applied: false,
      revisionId: null,
      reason: refreshing.has(deps.vaultRoot) ? 'building' : 'cold',
    };
  }

  const reordered = reorderByLearnedScore(
    anchorId,
    results,
    rankDeltaByEntity,
    cached.model,
    cached.handle,
    nowMs,
  );
  return { results: reordered, applied: true, revisionId: cached.revisionId, reason: 'applied' };
};

/**
 * Peek the learned-rerank warm FeatureModel (built by `refresh` over the
 * SAME LearnedRerankContext the served-feature warmer would build from),
 * or null when none is cached / it is older than `maxAgeMs`. Purely a
 * cache read — it NEVER triggers a build and NEVER blocks the caller.
 *
 * Used by servedFeatureModel.ts to REUSE this model instead of building a
 * second, byte-identical FeatureModel per TTL when the learned reranker is
 * active (`SIDETRACK_RECALL_LEARNED_RERANK=1` + a ship-gate-passed model):
 * both consumers need the same buildFeatureModel(context) output, and that
 * build is this codebase's documented CPU-runaway cause, so it must run at
 * most once per TTL across all consumers. When the reranker is off (the
 * default) nothing is cached here and the warmer builds its own.
 */
export const peekLearnedRerankFeatureModel = (
  vaultRoot: string,
  nowMs: number,
  maxAgeMs: number,
): FeatureModel | null => {
  const cached = modelByVault.get(vaultRoot);
  if (cached === undefined) return null;
  if (nowMs - cached.builtAtMs >= maxAgeMs) return null;
  return cached.model;
};

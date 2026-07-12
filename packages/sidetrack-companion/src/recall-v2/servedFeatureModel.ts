// Move 1 — served-feature-model warmer.
//
// To log the POINT-IN-TIME ranker feature vector into every recall.served
// impression (recall/events.ts), the pipeline needs the SAME FeatureModel
// the trainer builds — but buildFeatureModel is heavy (the documented
// freeze cause for this codebase's CPU runaways), so it MUST NOT run inline
// on the /v2 request path.
//
// This module mirrors the learnedRerank.ts background-refresh discipline:
// build the FeatureModel at most once per TTL in the BACKGROUND from the
// connections snapshot + feature-relevant merged window, cache it per
// vault, and let the capture path PEEK the warm model (never build). While
// the model is cold or a refresh is in flight, features are simply not
// captured for that impression and the trainer falls back to
// reconstruction — no correctness loss, only a warm-up window.
//
// This is deliberately INDEPENDENT of SIDETRACK_RECALL_LEARNED_RERANK: the
// learned reranker is a serving change (gated behind the freeze / its own
// flag), whereas feature LOGGING is freeze-safe and wanted broadly. The
// warmer is O(labels) per TTL off the hot path, so it respects the CPU
// regime regardless of whether the reranker serves.
//
// buildFeatureModel is this codebase's documented CPU-runaway cause, so it
// must run AT MOST ONCE per TTL across all consumers. When the learned
// reranker IS active it already builds this exact model over the SAME
// LearnedRerankContext; this warmer REUSES that model via
// peekLearnedRerankFeatureModel instead of building a second byte-identical
// copy — one build per TTL whether one or both consumers are on. When the
// reranker is off (the default) nothing is cached there and this warmer
// owns the single build.
//
// Env:
// - SIDETRACK_RECALL_SERVED_FEATURE_CAPTURE — collection defaults ON; set
//   to "0" or "off" to disable (explicit-disable convention, matching
//   recallEmitTrainableActions). When off, peek always returns null and the
//   snapshot carries no features (legacy reconstruction path).
// - SIDETRACK_RECALL_SERVED_FEATURE_TTL_MS — background rebuild cadence in
//   ms (default 120000); shared as the max-age both for our own cache and
//   for accepting a learned-rerank model to reuse.

import { buildFeatureModel, type FeatureModel } from '../ranker/features.js';
import {
  type LearnedRerankContext,
  peekLearnedRerankFeatureModel,
} from './learnedRerank.js';

const DEFAULT_TTL_MS = 120_000;

/**
 * Collection gate. Defaults ON; opt out with SIDETRACK_RECALL_SERVED_FEATURE_CAPTURE=0
 * (or "off"). Read at call time so a test / operator flip takes effect
 * without a restart.
 */
export const servedFeatureCaptureEnabled = (): boolean => {
  const raw = process.env['SIDETRACK_RECALL_SERVED_FEATURE_CAPTURE'];
  return raw !== '0' && raw !== 'off';
};

const ttlMs = (): number => {
  const raw = Number(process.env['SIDETRACK_RECALL_SERVED_FEATURE_TTL_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
};

interface WarmModel {
  readonly model: FeatureModel;
  readonly builtAtMs: number;
}

// One companion process == one vault, but key by vaultRoot so multi-vault
// test setups stay isolated (same convention as learnedRerank).
const modelByVault = new Map<string, WarmModel>();
const refreshing = new Set<string>();

// Test-only: clear cached state so a TTL / flag change takes effect.
export const __resetServedFeatureModelCacheForTests = (): void => {
  modelByVault.clear();
  refreshing.clear();
};

export interface ServedFeatureModelDeps {
  readonly vaultRoot: string;
  // Reads the snapshot + merged window for the background model build.
  // Called at most once per TTL (on refresh), never inline per request.
  readonly loadContext: () => Promise<LearnedRerankContext | null>;
  readonly now?: () => number;
}

const refresh = async (deps: ServedFeatureModelDeps, nowMs: number): Promise<void> => {
  if (refreshing.has(deps.vaultRoot)) return;
  refreshing.add(deps.vaultRoot);
  try {
    // Reuse the learned reranker's warm model when it built one this TTL —
    // it is buildFeatureModel over the SAME LearnedRerankContext, so a
    // second build here would be pure redundant CPU. Skips loadContext +
    // buildFeatureModel entirely in that case. Null when the reranker is
    // off (default) or its model is cold/stale, in which case we build.
    const shared = peekLearnedRerankFeatureModel(deps.vaultRoot, nowMs, ttlMs());
    if (shared !== null) {
      modelByVault.set(deps.vaultRoot, { model: shared, builtAtMs: nowMs });
      return;
    }
    const context = await deps.loadContext();
    if (context === null) return; // keep any prior good model; retry next TTL
    const model = buildFeatureModel(context.merged, context.snapshot);
    modelByVault.set(deps.vaultRoot, { model, builtAtMs: nowMs });
  } catch (err) {
    console.warn('[recall-v2] served-feature-model refresh failed:', err);
  } finally {
    refreshing.delete(deps.vaultRoot);
  }
};

/**
 * Return the warm FeatureModel for `deps.vaultRoot` (or null when cold /
 * disabled), kicking a BACKGROUND refresh when the cached model is stale or
 * missing. NEVER builds inline — a caller that gets null this turn will get
 * a warm model on a later request once the background build finishes.
 */
export const peekServedFeatureModel = (deps: ServedFeatureModelDeps): FeatureModel | null => {
  if (!servedFeatureCaptureEnabled()) return null;
  const nowMs = (deps.now ?? Date.now)();
  const cached = modelByVault.get(deps.vaultRoot);
  const stale = cached === undefined || nowMs - cached.builtAtMs >= ttlMs();
  if (stale) void refresh(deps, nowMs);
  return cached?.model ?? null;
};

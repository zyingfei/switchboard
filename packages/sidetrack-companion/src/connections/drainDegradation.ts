// Drain-degradation counters — make a SILENT slow path loud.
//
// WHY THIS EXISTS (live incident, 2026-07-27). The user reported "server
// non-response most of the time". Sampling the busy process showed
// connectionsReconcileChild at ~100% CPU for 11+ minutes inside
// libonnxruntime. The mechanism: the similarity build normally takes the
// HNSW path, which embeds only NEW entries (a delta). When that path
// THROWS, the materializer silently falls back to buildVisitSimilarity,
// which re-embeds the ENTIRE eligible corpus twice (passage + query
// prefixes) — minutes of full-core ONNX work that starves the parent
// process serving the panel, pushing resolve p95 past the extension's 15s
// client timeout.
//
// The fallback was invisible: it only emits a phase `mark`, and phase marks
// are console-logged solely when the phase-logs flag is on (off by
// default). So a drain could degrade from "delta, seconds" to "full
// re-embed, minutes" with NOTHING in health saying so — the same
// invisible-degradation class as the similarity-corpus flapping and the
// engagement-aggregate starvation before it.
//
// This module is deliberately tiny and dependency-free: process-lifetime
// counters plus the last error, surfaced through health so the degradation
// reports itself. It records; it never decides. Absent == zero.

export interface DrainDegradationSnapshot {
  /**
   * Times the HNSW (delta-embedding) similarity path threw and the drain
   * fell back to the full-corpus re-embed. Non-zero means at least one
   * drain paid minutes of ONNX instead of seconds — the P0-A cost driver.
   */
  readonly similarityFullRebuildFallbacks: number;
  /** Message of the most recent fallback-triggering error, truncated. */
  readonly lastFallbackError: string | undefined;
  /** Epoch ms of the most recent fallback, or undefined if none. */
  readonly lastFallbackAtMs: number | undefined;
}

const MAX_ERROR_CHARS = 240;

const state = {
  similarityFullRebuildFallbacks: 0,
  lastFallbackError: undefined as string | undefined,
  lastFallbackAtMs: undefined as number | undefined,
};

/**
 * Record that the HNSW similarity path failed and the drain is about to
 * re-embed the whole corpus. Called from the materializer's catch, beside
 * the existing phase mark, so the two never disagree.
 */
export const recordSimilarityFullRebuildFallback = (
  error: unknown,
  nowMs: number = Date.now(),
): void => {
  state.similarityFullRebuildFallbacks += 1;
  const message = error instanceof Error ? error.message : String(error);
  state.lastFallbackError = message.slice(0, MAX_ERROR_CHARS);
  state.lastFallbackAtMs = nowMs;
};

export const getDrainDegradation = (): DrainDegradationSnapshot => ({
  similarityFullRebuildFallbacks: state.similarityFullRebuildFallbacks,
  lastFallbackError: state.lastFallbackError,
  lastFallbackAtMs: state.lastFallbackAtMs,
});

/** Test seam — reset counters between cases. */
export const resetDrainDegradation = (): void => {
  state.similarityFullRebuildFallbacks = 0;
  state.lastFallbackError = undefined;
  state.lastFallbackAtMs = undefined;
};

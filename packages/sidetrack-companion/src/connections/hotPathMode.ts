// U2 — the incremental "hot path" for visit-similarity and topics is
// now ON by default. It REPLACES the expensive legacy full rebuild
// with the amortised incremental index / accumulator, so activating
// it can only reduce (never increase) per-drain CPU — the property
// promised when turning these dormant fast paths on. It is still
// gated at runtime: hot-similarity only embeds on the hot path when
// the embedder is warm + the corpus is within budget
// (decideHotPathEmbed); otherwise it falls back to exactly the legacy
// behaviour. Set the env var to off/false/0/none to force the legacy
// path. The legacy explicit opt-in value '1' still means ON.

const DISABLED_VALUES = new Set(['off', 'false', '0', 'none']);

const enabledByDefault = (name: string): boolean => {
  const raw = process.env[name];
  if (raw === undefined) return true;
  return !DISABLED_VALUES.has(raw.trim().toLowerCase());
};

export const HOT_SIMILARITY_ENV = 'SIDETRACK_CONNECTIONS_HOT_SIMILARITY';
export const HOT_TOPICS_ENV = 'SIDETRACK_CONNECTIONS_HOT_TOPICS';

export const hotSimilarityModeEnabled = (): boolean => enabledByDefault(HOT_SIMILARITY_ENV);
export const hotTopicsModeEnabled = (): boolean => enabledByDefault(HOT_TOPICS_ENV);

// Decision + cheap, already-computed counters for the hot paths.
// Deliberately NOT a baseline-vs-candidate diff: re-running the legacy
// baseline every drain purely for an A/B would re-introduce the exact
// per-drain rebuild cost the connections CPU work removed. Every field
// here is a local the drain already had — no extra compute.
export interface HotPathDiagnostics {
  readonly similarity: {
    readonly enabled: boolean;
    // decideHotPathEmbed outcome this drain.
    readonly shouldEmbedOnHotPath: boolean;
    readonly reason: string | null;
    // Did the drain actually take the incremental branch (vs cache /
    // legacy fallback)?
    readonly usedHotPath: boolean;
    readonly corpusSize: number;
    readonly newEmbedded: number | null;
    readonly edgeCount: number;
    readonly runtimeMs: number;
  };
  readonly topics: {
    readonly enabled: boolean;
    // buildTopicRevisionFromAccumulator is test-asserted byte-equal to
    // the legacy builder (modulo producedAt), so there is no output
    // A/B to show — the signal is which path ran + what it saved.
    readonly usedFastPath: boolean;
    readonly cacheHit: boolean;
    readonly componentCount: number | null;
    readonly topicCount: number;
    readonly runtimeMs: number;
  };
}

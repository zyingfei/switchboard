// Recall v2 — unified retrieval subsystem types.
//
// Mirrors the contract from the 2026-05-24 deep-research report
// (~/Downloads/deep-research-report-dejavu-hybrid-search.md).
// One server endpoint owns query analysis, candidate generation,
// fusion, dedupe, suppression, optional rerank, and explanation
// assembly. The extension renders results and filter UI only.
//
// Phase 1 lands the types + the v1.5 delegate pipeline behind them
// so the eval harness has something concrete to drive. Later phases
// swap each candidate generator's body to read from the SQLite
// retrieval backend (Phase 3) and rewire fusion/suppression server-
// side (Phase 5) without touching this contract.

/** The kinds of retrieval sources Recall v2 understands. */
export type RecallSourceKind =
  | 'page_content'
  | 'timeline_visit'
  | 'chat_turn'
  | 'semantic_query'
  | 'graph_neighbor'
  | 'current_session'
  // `focus` — direct graph lookup from `session.currentUrl`. Returns
  // the page itself plus its 1-hop graph neighbors (related visits,
  // threads attached to the URL, etc.). Distinct from
  // `graph_neighbor`, which expands from candidates already found by
  // OTHER sources. focus answers "what is THIS page connected to";
  // graph_neighbor answers "what is connected to what I already
  // found." Both can run in the same request.
  | 'focus';

/** The kinds of retrievers that can produce evidence on a candidate. */
export type RecallRetriever =
  | 'bm25'
  | 'fts5'
  | 'dense'
  | 'sparse'
  | 'rrf'
  | 'rerank'
  | 'fts5-local';

/** Per-source evidence record carried alongside a candidate. */
export interface RecallEvidence {
  readonly retriever: RecallRetriever;
  readonly sourceKind: RecallSourceKind;
  /** Raw score from the source (BM25, cosine, etc.). Scale varies; do
   *  not mix with rawScores from other sources without normalization. */
  readonly rawScore?: number;
  /** Normalized to [0,1] when the source supports it. Optional. */
  readonly normalizedScore?: number;
  /** 1-based rank within the source ranker's own output. */
  readonly rank?: number;
  readonly matchedFields?: readonly string[];
  readonly matchedTerms?: readonly string[];
  /** Cosine DISTANCE (not similarity) for vector retrievers. 0 = identical. */
  readonly vectorDistance?: number;
  /** Free-form engine explanation when available. */
  readonly explain?: string;
}

/** A single retrieval result. Evidence-rich; dedupe-aware. */
export interface RecallCandidate {
  /** Unique to this result row. Stable across one response. */
  readonly candidateId: string;
  /** Stable dedupe key across sources (e.g. canonical-URL hash, or
   *  thread id for chat hits). Two candidates with the same entityId
   *  represent the same underlying entity from different sources. */
  readonly entityId: string;
  /** The PRIMARY source — the highest-ranked or first-arriving one.
   *  All contributing sources live in `evidence[]`. */
  readonly sourceKind: RecallSourceKind;

  readonly canonicalUrl?: string;
  readonly title?: string;
  readonly snippet?: string;
  readonly contentId?: string;
  readonly threadId?: string;

  readonly firstSeenAt?: string;
  readonly lastSeenAt?: string;
  readonly visitCount?: number;

  /** Final fused score after RRF / weighted RRF / score normalization. */
  readonly fusedScore: number;
  /** Cross-encoder rerank score when `strategy.rerankTopK` was used. */
  readonly rerankScore?: number;

  /** All sources that contributed to this candidate (1+ entries).
   *  Powers the per-row "Why?" expander in the UI. */
  readonly evidence: readonly RecallEvidence[];

  /** Reasons this candidate was suppressed (only present on rows in
   *  `meta.debug.droppedExplanations`, not in `results[]`). */
  readonly suppressedReasons?: readonly string[];

  readonly debug?: Record<string, unknown>;
}

/** Server-side suppression policy. Sensible defaults applied when omitted. */
export interface SuppressionPolicy {
  /** Drop the current page from results.
   *  - 'always'           — strict; today's v1.5 behavior
   *  - 'never'            — keep it (e.g. user explicitly invoked Déjà-vu)
   *  - 'unless-discussion' — keep when the current page is a discussion-
   *     site source (HN/Reddit/Lobste.rs style); generic detection via
   *     URL structure, NOT a hardcoded host list */
  readonly suppressCurrentPage?: 'always' | 'never' | 'unless-discussion';
  /** Bac_ids of chats the user is actively in / just created. These
   *  never surface as "déjà-vu" (fixes the AI 不应做架构师 case). */
  readonly suppressActiveChatBacIds?: readonly string[];
  /** Drop chats marked as Ask-AI artifacts (user typed in the popover
   *  and got an answer; not a "prior" by any meaningful definition). */
  readonly suppressAskAiArtifacts?: boolean;
  /** Drop hits whose capturedAt is younger than this (ms). Default 5min. */
  readonly minHitAgeMs?: number;
  /** Caller-explicit exclude list (entityIds the caller already knows). */
  readonly excludeEntityIds?: readonly string[];
  /** When true, suppressed current-session items appear as a separate
   *  facet instead of being silently dropped. */
  readonly surfaceCurrentSessionAsFacet?: boolean;
}

/** Per-request fusion + rerank + debug strategy. */
export interface RecallStrategy {
  readonly fusion?: 'rrf' | 'weighted_rrf' | 'normalized_score';
  /** When > 0, rerank the top-N candidates via cross-encoder. Off (0) by default. */
  readonly rerankTopK?: number;
  /** Attach lightweight per-result Explanation (default true). */
  readonly explain?: boolean;
  /** Attach debug payload (timings, dropped explanations). Off by default. */
  readonly debug?: boolean;
}

/** Named retrieval intents. Each intent picks a default source
 *  profile + suppression posture; explicit `sources` / `suppression`
 *  fields on the request still override. Intent is also recorded in
 *  the response meta so consumers can attribute behaviour.
 *
 *  - `dejavu` — user selected text on a page; want prior captures of
 *    the SAME topic. Default sources: all five (page_content,
 *    timeline_visit, chat_turn, semantic_query, graph_neighbor).
 *    Default suppression: suppress the current page + active-chat /
 *    Ask-AI artifacts so the user doesn't see their own fresh chat
 *    surface as déjà-vu.
 *  - `search` — user typed a global query in the Search tab; no
 *    current-page context. Default sources: page_content,
 *    timeline_visit, chat_turn, semantic_query (graph_neighbor stays
 *    a future opt-in). Default suppression: NONE (`suppressCurrentPage
 *    = 'never'`) so the user can find what they're looking at.
 *  - `focus` — Now card for the active page. Default sources:
 *    focus, timeline_visit, graph_neighbor. Query string is usually
 *    empty (`q: ''`); ranking blends graph distance + recency. */
export type RecallIntent = 'dejavu' | 'search' | 'focus';

/** Request body for POST /v2/recall. */
export interface RecallRequest {
  readonly q: string;
  readonly limit?: number;
  readonly perSourceLimit?: number;

  /** Intent profile — picks defaults for `sources` and `suppression`
   *  when those fields are omitted. Defaults to `dejavu` for backwards
   *  compatibility with the original Phase 2 contract. */
  readonly intent?: RecallIntent;

  /** Which sources to query. Defaults follow the chosen `intent`. */
  readonly sources?: readonly RecallSourceKind[];

  /** Session/context the server needs for suppression + current-page
   *  handling. The extension passes these from its own state. */
  readonly session?: {
    readonly sessionId?: string;
    readonly currentUrl?: string;
    readonly currentThreadId?: string;
    readonly activeChatBacIds?: readonly string[];
    readonly excludeEntityIds?: readonly string[];
  };

  readonly filters?: {
    readonly hosts?: readonly string[];
    readonly sourceKinds?: readonly RecallSourceKind[];
    readonly timeFrom?: string;
    readonly timeTo?: string;
    readonly workstreamId?: string;
  };

  readonly suppression?: SuppressionPolicy;
  readonly strategy?: RecallStrategy;
}

/** Response body for POST /v2/recall. */
export interface RecallResponse {
  readonly query: {
    readonly text: string;
    readonly normalizedText?: string;
    readonly embeddingModel?: string;
  };

  readonly results: readonly RecallCandidate[];

  readonly meta: {
    /** The intent the server resolved this request as — useful for the
     *  extension's debug overlay and for shadow comparisons. */
    readonly intent: RecallIntent;
    readonly fusion: {
      readonly strategy: string;
      readonly perSourceCounts: Readonly<Record<RecallSourceKind, number>>;
      readonly k?: number;
    };
    readonly timingsMs: Readonly<Record<string, number>>;
    readonly flags: Readonly<Record<string, boolean>>;
    /** Stable impression identity — present when the server appended a
     *  `recall.served` event for this response. The extension echoes
     *  it back in recall.action so the ranker trainer can join served ×
     *  action records by impression. */
    readonly servedContextId?: string;
    /** Cross-encoder rerank diagnostics. Present when rerank fired. */
    readonly rerank?: {
      readonly enabled: boolean;
      readonly rerankTopK: number;
      readonly rerankedCount: number;
      readonly latencyMs: number;
      /** Per-candidate rank movement (pre-rerank rank − post-rerank rank). */
      readonly rankMovement?: readonly { readonly entityId: string; readonly delta: number }[];
    };
    readonly debug?: {
      readonly droppedExplanations?: readonly RecallCandidate[];
    };
  };
}

/** Internal candidate-generator output (one source's hits before fusion). */
export interface CandidateGeneratorOutput {
  readonly sourceKind: RecallSourceKind;
  readonly candidates: readonly RecallCandidate[];
  /** Cumulative timing for this generator (ms). */
  readonly elapsedMs: number;
}

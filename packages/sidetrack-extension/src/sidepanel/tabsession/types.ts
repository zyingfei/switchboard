export const TAB_SESSION_DRAG_MIME = 'application/x-sidetrack-tab-session-id';

export interface TabSessionAttribution {
  readonly workstreamId: string | null;
  // Stage 5 follow-up — 'thread' shows up via the URL projection's
  // adapter (UrlVisitRecord → TabSessionRecord). The companion's
  // tab-session projection never emits 'thread', but the extension
  // re-uses TabSessionRecord as the canonical InboxCard prop, so
  // the type union must accept it for the adapter pass-through.
  readonly source:
    | 'user_asserted'
    | 'tab-group-pull-in'
    | 'tab-group-pull-out'
    | 'inferred'
    | 'thread';
  readonly observedAt: string;
  readonly clientEventId: string;
}

// Stage 5 polish — URL-level "user dismissed this as noise" state.
// Distinct from `currentAttribution.workstreamId = null` (which says
// "meaningful but no workstream"). Surfaces as the `ignored` badge
// variant and the "Ignore" overflow action. Only set on the URL→
// TabSessionRecord adapter path (the tab-session projection itself
// has no ignored state).
export interface TabSessionIgnoredState {
  readonly reason: 'noise' | 'duplicate' | 'private';
  readonly observedAt: string;
  readonly clientEventId: string;
}

export interface TabSessionPageEvidenceVectorSummary {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly dimensions: number;
}

export interface TabSessionPageEvidenceSummary {
  readonly tier: string;
  readonly evidenceRevision?: string;
  readonly semanticFeatureRevision?: string;
  readonly updatedAt?: string;
  readonly termCount?: number;
  readonly keyphraseCount?: number;
  readonly entityCount?: number;
  readonly quality?: string;
  readonly vector?: TabSessionPageEvidenceVectorSummary;
}

export interface TabSessionRecord {
  readonly tabSessionId: string;
  readonly openedAt: string;
  readonly lastActivityAt: string;
  readonly closedAt?: string;
  readonly tabIdHash?: string;
  readonly openerTabSessionId?: string;
  readonly latestUrl?: string;
  readonly latestTitle?: string;
  readonly provider?: string;
  readonly currentAttribution?: TabSessionAttribution;
  readonly currentIgnored?: TabSessionIgnoredState;
  readonly attributionHistory: readonly TabSessionAttribution[];
  readonly pageEvidence?: TabSessionPageEvidenceSummary;
}

export interface TabSessionProjection {
  readonly schemaVersion: 1;
  readonly bySessionId: Record<string, TabSessionRecord>;
  readonly openSessionsByTabId: Record<string, string>;
}

export interface TabSessionInboxData {
  readonly items: readonly TabSessionRecord[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface TabSessionWorkstreamOption {
  readonly bac_id: string;
  readonly path: string;
}

// Sync Contract v1 / read-response (NOT a sync event) — the resolver
// returns reasons[].anchors. As of payload schemaVersion 2, anchors
// may be either bare node-id strings (legacy) or enriched objects
// carrying { id, kind, label } drawn from the resolver's evidence
// graph. The frontend reader (formatAnchorDisplay / upgradeAnchor in
// entityDisplay/format.ts) accepts both forms so the companion and
// extension can deploy independently.
export interface AttributionAnchor {
  readonly id: string;
  readonly kind?: string;
  readonly label?: string;
}

// Guess-lanes (feat/guess-lanes) — the companion now returns each
// individual resolver lane's own ranked guess on EVERY resolve, not just
// the fused decision. The panel surfaces them behind a disclosure so the
// user can see what each signal thought even when the fused decision
// abstained. Additive on the wire: ABSENT on older companions, so every
// reader must treat `lanes === undefined` as "old companion, keep legacy
// behavior" (never reject the whole result over a missing/malformed lanes).
//
// The six lanes and their human labels are the resolver's independent
// arms; the fused decision is a weighted combination of them.
export type GuessLane = 'graph' | 'similarity' | 'topic' | 'title' | 'domain' | 'recency';

export interface GuessLaneCandidate {
  readonly workstreamId: string;
  // Lane-native score in [0, 1] — NOT the fusion logit. Each lane scores in
  // its own units (cosine, plurality share, recency decay), so this is a
  // rough within-lane rank signal, not a calibrated cross-lane probability.
  readonly score: number;
  // One-line human reason the lane produced this guess (companion-authored).
  readonly why: string;
}

export interface GuessLaneResult {
  readonly lane: GuessLane;
  // Descending by score, max 3. Empty iff the lane had nothing to say
  // (then `emptyReason` explains why).
  readonly candidates: readonly GuessLaneCandidate[];
  // Present iff `candidates` is empty — the lane's own honest "nothing here
  // because …" (e.g. "no similar pages", "domain unseen"). Surfaced as the
  // muted empty-lane row so all six lanes always account for themselves.
  readonly emptyReason?: string;
}

export interface TabSessionResolverCandidate {
  readonly workstreamId: string;
  readonly rawFusionLogit: number;
  // 'vote' (M6): the servable vote arm's decision (title/domain/recency
  // plurality), distinct from 'cluster' so provenance copy is honest.
  readonly dominantSource: 'ppr' | 'similarity' | 'cluster' | 'vote' | 'none';
  readonly reasons: readonly {
    readonly source: 'ppr' | 'similarity' | 'cluster' | 'vote';
    readonly summary: string;
    readonly anchors: readonly (string | AttributionAnchor)[];
  }[];
}

export interface TabSessionResolutionResult {
  readonly tabSessionId: string;
  readonly dryRun: true;
  readonly decision: {
    readonly action: 'auto-apply' | 'suggest' | 'inbox';
    readonly workstreamId?: string;
    readonly margin: number;
  };
  readonly fusedCandidates: readonly TabSessionResolverCandidate[];
  // Guess-lanes — always all 6 lanes when present, in the fixed order
  // graph, similarity, topic, title, domain, recency. Absent on older
  // companions (see GuessLaneResult); a lenient client parse drops it
  // entirely rather than reject the result when it's malformed.
  readonly lanes?: readonly GuessLaneResult[];
}

// A resolve REQUEST failed (500 / timeout / network) — NOT an empty
// result. The panel must render these distinctly from a genuinely-empty
// resolution ("No signal yet"): during a heavy companion drain the
// batch-resolve route can 500 with "database is locked" for 20+ seconds,
// and rendering that as a confident empty card is a falsehood for a page
// the user has visited repeatedly. `kind` mirrors the down-vs-busy split
// used elsewhere (CompanionRequestError): 'busy' = the companion is up but
// contended (a slow/locked resolve — retry recovers it); 'error' = any
// other failure. Both surface as a soft "companion is busy — retrying"
// state, never as "first time seeing this URL".
export interface ResolveOutcomeError {
  readonly kind: 'busy' | 'error';
}

// -- Per-canonical-URL attribution (Phase B — the URL is the
// attribution unit; tabs are just transport) ----------------------

export interface UrlAttribution {
  readonly workstreamId: string | null;
  // Stage 5 follow-up — 'thread' is the companion-derived source for
  // canonical URLs whose matching chat thread was user-attributed to
  // a workstream. Treated as user-driven by the panel + ranker.
  readonly source:
    | 'user_asserted'
    | 'tab-group-pull-in'
    | 'tab-group-pull-out'
    | 'inferred'
    | 'thread';
  readonly observedAt: string;
  readonly clientEventId: string;
}

export interface UrlIgnoredState {
  readonly reason: 'noise' | 'duplicate' | 'private';
  readonly observedAt: string;
  readonly clientEventId: string;
}

export interface UrlVisitRecord {
  readonly canonicalUrl: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly visitCount: number;
  readonly tabSessionIds: readonly string[];
  readonly latestUrl?: string;
  readonly latestTitle?: string;
  readonly provider?: string;
  readonly host?: string;
  readonly currentAttribution?: UrlAttribution;
  readonly currentIgnored?: UrlIgnoredState;
  readonly attributionHistory: readonly UrlAttribution[];
  readonly pageEvidence?: TabSessionPageEvidenceSummary;
}

export interface UrlProjection {
  readonly schemaVersion: 1;
  readonly byCanonicalUrl: Record<string, UrlVisitRecord>;
}

export interface UrlInboxData {
  readonly items: readonly UrlVisitRecord[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface UrlResolutionResult {
  readonly canonicalUrl: string;
  readonly dryRun: true;
  readonly decision: {
    readonly action: 'auto-apply' | 'suggest' | 'inbox';
    readonly workstreamId?: string;
    readonly margin: number;
  };
  readonly fusedCandidates: readonly TabSessionResolverCandidate[];
  // Guess-lanes — see TabSessionResolutionResult.lanes. Same additive,
  // may-be-absent contract on the URL-batch resolve wire shape.
  readonly lanes?: readonly GuessLaneResult[];
}

// ---- Guess-lanes parse (lenient) ----------------------------------------
//
// `lanes` is additive on every resolve wire shape AND on the top-level
// /v1/suggestions/thread response. It may be absent (old companion) or —
// under a partial deploy / a bug on the companion — malformed. The panel's
// rule is: parse leniently, and on ANY structural surprise treat lanes as
// ABSENT (return undefined) rather than reject the whole resolution. A
// missing `lanes` and a malformed `lanes` are indistinguishable to the UI
// (both fall back to the legacy no-lanes behavior), which is the honest
// degradation — we never fabricate lane rows from garbage.
//
// A single bad lane doesn't poison the rest: malformed lane entries are
// dropped and the surviving well-formed lanes still render. Only a
// non-array `lanes` (or every entry malformed → nothing to show) collapses
// to undefined.

const VALID_LANES: ReadonlySet<GuessLane> = new Set<GuessLane>([
  'graph',
  'similarity',
  'topic',
  'title',
  'domain',
  'recency',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseGuessLaneCandidate = (value: unknown): GuessLaneCandidate | null => {
  if (!isRecord(value)) return null;
  const { workstreamId, score, why } = value;
  if (typeof workstreamId !== 'string' || workstreamId.length === 0) return null;
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  if (typeof why !== 'string') return null;
  return { workstreamId, score, why };
};

const parseGuessLaneResult = (value: unknown): GuessLaneResult | null => {
  if (!isRecord(value)) return null;
  const { lane, candidates, emptyReason } = value;
  if (typeof lane !== 'string' || !VALID_LANES.has(lane as GuessLane)) return null;
  if (!Array.isArray(candidates)) return null;
  // Drop malformed candidates rather than the whole lane — a good lane with
  // one junk candidate still shows its good ones. Cap at 3 (the contract).
  const parsed: GuessLaneCandidate[] = [];
  for (const raw of candidates) {
    const candidate = parseGuessLaneCandidate(raw);
    if (candidate !== null) parsed.push(candidate);
    if (parsed.length >= 3) break;
  }
  return {
    lane: lane as GuessLane,
    candidates: parsed,
    ...(typeof emptyReason === 'string' && emptyReason.length > 0
      ? { emptyReason }
      : {}),
  };
};

/** Lenient parse of a wire `lanes` field. Returns the well-formed lanes, or
 * undefined when the field is absent or so malformed that nothing survives —
 * the caller then behaves exactly as a pre-lanes companion (legacy path). */
export const parseGuessLanes = (value: unknown): readonly GuessLaneResult[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return undefined;
  const lanes: GuessLaneResult[] = [];
  for (const raw of value) {
    const lane = parseGuessLaneResult(raw);
    if (lane !== null) lanes.push(lane);
  }
  return lanes.length > 0 ? lanes : undefined;
};

/** Total candidate count across all lanes — the discriminant for the
 * "abstained but lanes have signal" headline. Zero when every lane is empty
 * (or lanes are absent). */
export const guessLaneSignalCount = (
  lanes: readonly GuessLaneResult[] | undefined,
): number => {
  if (lanes === undefined) return 0;
  let count = 0;
  for (const lane of lanes) count += lane.candidates.length;
  return count;
};

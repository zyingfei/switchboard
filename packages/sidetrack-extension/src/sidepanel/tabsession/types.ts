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

// Multi-membership UI-visibility phase (docs/plans/2026-08-16-category-
// flexibility-hyde.md — companion PR #376 shipped the write paths and the
// `workstream.membership.set`/`.removed` fold; this is the read shape the
// panel renders as chips). A row's `role` is 'primary' only for a subject's
// SINGLE most-recent primary SET (fold-time invariant, mirrored from the
// companion's `foldWorkstreamMembership`) — everything else is
// 'secondary'. IMPORTANT: today `currentAttribution` (the pre-existing
// single-primary field above) and `memberships` are two INDEPENDENT
// sources until a one-time backfill runs — a page filed via the older
// `/attribute` route will show a `currentAttribution` but may have ZERO
// rows here. Readers must treat `currentAttribution` as the authoritative
// primary and render `memberships` only for chips ADDITIONAL to it (filter
// out any row whose workstreamId already equals the primary's).
export const MEMBERSHIP_ROLES = ['primary', 'secondary'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export interface UrlMembershipRow {
  readonly workstreamId: string;
  readonly role: MembershipRole;
  readonly provenance: string;
  readonly acceptedAtMs: number;
  readonly sourceOpportunityId?: string;
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
  readonly memberships?: readonly UrlMembershipRow[];
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
// The lanes and their human labels are the resolver's independent arms; the
// fused decision is a weighted combination of them. 'content' (feat/content-
// lane) is the 7th, appended AFTER 'recency' — it arrives on newer companions
// and is ABSENT on older ones, so like the whole `lanes` field it is additive
// on the wire: a reader that renders lanes in array order picks it up
// automatically, and one that doesn't send it stays at six.
export type GuessLane =
  | 'graph'
  | 'similarity'
  | 'topic'
  | 'title'
  | 'domain'
  | 'recency'
  | 'content'
  // Lane 8 — the AI lane: the same query-time retrieval as 'content', asked
  // with the on-device gist ALONE. Present only when a gist exists.
  | 'ai'
  // Lane 9 — the prototype lane: cosine match against offline-generated
  // workstream prototypes (Apple FM, PR #377). Observe-only disclosure.
  | 'prototype';

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

// Pipeline strip (feat/pipeline-strip) — the resolver now reports WHY the
// fused decision landed where it did as a compact { reason, detail } gate,
// so the panel can show a one-line verdict ("→ held: top 0.82 < 1.2 suggest
// bar") instead of leaving the user to infer it from the raw margin. Additive
// on the wire, nested under `decision`: ABSENT on older companions, and a
// lenient parse (parseGuessGate) drops it entirely on any malformed shape —
// the strip then falls back to a candidate-count-derived verdict. The six
// reasons cover the resolver's gate ladder: no-candidates (nothing fused),
// corroboration / below-suggest / margin-tie / regret-budget (fused but held
// to inbox), cleared-suggest (surfaced as a suggestion), cleared-auto
// (auto-filed).
export type GuessGateReason =
  | 'no-candidates'
  | 'corroboration'
  | 'below-suggest'
  | 'margin-tie'
  | 'regret-budget'
  | 'cleared-suggest'
  | 'cleared-auto';

export interface GuessGate {
  readonly reason: GuessGateReason;
  // Human one-liner carrying the numbers, e.g. "top 0.82 < 1.2 suggest bar".
  // Rendered verbatim in the held-verdict line — the companion owns the copy.
  readonly detail: string;
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

// New-workstream hint (docs/plans/2026-08-16-category-flexibility-hyde.md
// §9 addendum) — an additive field on the batch-resolve result, present ONLY
// when the page has keywords but no existing workstream is a confident
// match. `name` is a suggested title; `keywords` are the terms behind it
// (shown nowhere yet, but kept for a future "why" tooltip). Absent on older
// companions and on any resolve where the companion had nothing to suggest —
// callers must treat a missing/malformed hint as "render nothing", never
// synthesize one client-side.
export interface NewLabelHint {
  readonly name: string;
  readonly keywords: readonly string[];
}

export interface TabSessionResolutionResult {
  readonly tabSessionId: string;
  readonly dryRun: true;
  readonly decision: {
    readonly action: 'auto-apply' | 'suggest' | 'inbox';
    readonly workstreamId?: string;
    readonly margin: number;
    // Pipeline-strip gate (see GuessGate). Absent on older companions; a
    // lenient parse drops it on any malformed shape → the strip verdict
    // falls back to a candidate-count read.
    readonly gate?: GuessGate;
  };
  readonly fusedCandidates: readonly TabSessionResolverCandidate[];
  // Guess-lanes — the resolver arms in the fixed wire order graph, similarity,
  // topic, title, domain, recency, with 'content' appended as an optional 7th
  // on newer companions (feat/content-lane). Absent on older companions (see
  // GuessLaneResult); a lenient client parse drops it entirely rather than
  // reject the result when it's malformed. Readers render in array order.
  readonly lanes?: readonly GuessLaneResult[];
  // See NewLabelHint. Additive, may be absent.
  readonly newLabelHint?: NewLabelHint;
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
  readonly memberships?: readonly UrlMembershipRow[];
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
  /** Opaque ID echoed on an explicit attribution reaction; absent on abstention/old companions. */
  readonly servedOpportunityId?: string;
  readonly decision: {
    readonly action: 'auto-apply' | 'suggest' | 'inbox';
    readonly workstreamId?: string;
    readonly margin: number;
    // Pipeline-strip gate — see TabSessionResolutionResult.decision.gate.
    // Same additive, may-be-absent, lenient-parse contract on the URL wire.
    readonly gate?: GuessGate;
  };
  readonly fusedCandidates: readonly TabSessionResolverCandidate[];
  // Guess-lanes — see TabSessionResolutionResult.lanes. Same additive,
  // may-be-absent contract on the URL-batch resolve wire shape.
  readonly lanes?: readonly GuessLaneResult[];
  // See NewLabelHint. Same additive, may-be-absent contract.
  readonly newLabelHint?: NewLabelHint;
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
  'content',
  // Lane 8 — 'ai'. This set is the parse WHITELIST: parseGuessLaneResult drops
  // any lane whose name is not in it, before any renderer ever sees the entry.
  // Omitting 'ai' here is what made a live 8-lane payload render as seven dots
  // — the companion sent the lane, the client silently deleted it, and both the
  // strip and the array-order disclosure were handed a 7-lane array with no
  // trace of the loss. Every lane added to the GuessLane union MUST be added
  // here in the same change.
  'ai',
  // Lane 9 — 'prototype' (PR #377). The companion disclosed this lane for a
  // build before it was added here, and the panel silently dropped it —
  // the exact 'ai'-lane failure mode the comment above documents.
  'prototype',
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

// ---- Pipeline-strip gate parse (lenient) --------------------------------
//
// `decision.gate` is additive on every resolve wire shape. It may be absent
// (old companion) or malformed (partial deploy / companion bug). Same rule as
// `lanes`: parse leniently, and on ANY structural surprise treat the gate as
// ABSENT (return undefined) rather than reject the whole resolution. The strip
// then derives its verdict from the fused-candidate count instead.

const VALID_GATE_REASONS: ReadonlySet<GuessGateReason> = new Set<GuessGateReason>([
  'no-candidates',
  'corroboration',
  'below-suggest',
  'margin-tie',
  'regret-budget',
  'cleared-suggest',
  'cleared-auto',
]);

/** Lenient parse of a wire `decision.gate` field. Returns the well-formed gate,
 * or undefined when absent or malformed — the caller then behaves exactly as a
 * pre-gate companion (verdict falls back to the fused-candidate count). */
export const parseGuessGate = (value: unknown): GuessGate | undefined => {
  if (!isRecord(value)) return undefined;
  const { reason, detail } = value;
  if (typeof reason !== 'string' || !VALID_GATE_REASONS.has(reason as GuessGateReason)) {
    return undefined;
  }
  if (typeof detail !== 'string') return undefined;
  return { reason: reason as GuessGateReason, detail };
};

// ---- New-label-hint parse (lenient) -------------------------------------
//
// `newLabelHint` is additive on every resolve wire shape. Same rule as
// `lanes`/`gate`: parse leniently, and on ANY structural surprise treat the
// hint as ABSENT (return undefined) — never render a hint synthesized from
// garbage, and never reject the whole resolution over it.

/** Lenient parse of a wire `newLabelHint` field. Returns the well-formed
 * hint, or undefined when absent or malformed (old companion / no hint this
 * resolve / a bug) — the caller then renders nothing, exactly as if the
 * field were never sent. */
export const parseNewLabelHint = (value: unknown): NewLabelHint | undefined => {
  if (!isRecord(value)) return undefined;
  const { name, keywords } = value;
  if (typeof name !== 'string' || name.trim().length === 0) return undefined;
  if (!Array.isArray(keywords) || !keywords.every((k) => typeof k === 'string')) {
    return undefined;
  }
  return { name, keywords };
};

// The verdict arrow-line rendered by the PipelineStrip. Derived from the gate
// when present; otherwise a fused-candidate-count fallback (old companion).
//
//   cleared-auto    → "→ auto-filed"  (the name is shown elsewhere on the card)
//   cleared-suggest → "→ suggested"
//   any inbox gate  → "→ held: {gate.detail}"  (detail carries the numbers)
//   gate absent     → fusedCount > 0 ? "→ held below the bar" : "→ nothing corroborated"
export const pipelineVerdictLine = (
  gate: GuessGate | undefined,
  fusedCount: number,
): string => {
  if (gate === undefined) {
    return fusedCount > 0 ? '→ held below the bar' : '→ nothing corroborated';
  }
  switch (gate.reason) {
    case 'cleared-auto':
      return '→ auto-filed';
    case 'cleared-suggest':
      return '→ suggested';
    default:
      // no-candidates / corroboration / below-suggest / margin-tie /
      // regret-budget — all held-to-inbox reasons; detail carries the numbers.
      return `→ held: ${gate.detail}`;
  }
};

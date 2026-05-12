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

export interface TabSessionResolverCandidate {
  readonly workstreamId: string;
  readonly rawFusionLogit: number;
  readonly dominantSource: 'ppr' | 'similarity' | 'cluster' | 'none';
  readonly reasons: readonly {
    readonly source: 'ppr' | 'similarity' | 'cluster';
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
}

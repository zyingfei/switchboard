export const TAB_SESSION_DRAG_MIME = 'application/x-sidetrack-tab-session-id';

export interface TabSessionAttribution {
  readonly workstreamId: string | null;
  readonly source: 'user_asserted';
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

export interface TabSessionResolverCandidate {
  readonly workstreamId: string;
  readonly rawFusionLogit: number;
  readonly dominantSource: 'ppr' | 'similarity' | 'cluster' | 'none';
  readonly reasons: readonly {
    readonly source: 'ppr' | 'similarity' | 'cluster';
    readonly summary: string;
    readonly anchors: readonly string[];
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

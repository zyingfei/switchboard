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

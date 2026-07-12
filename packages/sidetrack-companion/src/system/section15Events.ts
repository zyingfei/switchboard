// PRD §15 falsifiability — tab-recovery event.
//
// The §15 freeze-lift table (PRD.md §15, ADR-0011) requires "≥1 tab
// recovery" as an observable, event-log-sourced signal. The §13
// recovery flow (extension: sidepanel/tabsession/sessionRestore.ts +
// App.tsx restoreThreadSession) already restores a closed tab via
// chrome.sessions.restore, but until now it left NO durable trace — the
// restore happened in the extension's runtime and never reached the
// companion, so the counter was unfalsifiable.
//
// This is the minimal event the extension emits (POST
// /v1/system/tab-recovery) after a SUCCESSFUL chrome.sessions.restore,
// so the section-15 counter can read it by type from the event log with
// a typed (forEachChunkOfTypes) scan. It is observability-only: no
// serving consumer reads it, so it is freeze-safe (ADR-0011).

export const CHROME_SESSIONS_RESTORE = 'chrome.sessions.restore' as const;

export type Section15EventType = typeof CHROME_SESSIONS_RESTORE;

// Single append-only aggregate for tab-recovery events — like the
// `privacy` aggregate, these are a flat process-wide fact stream, not
// per-entity, so one aggregate id keeps the causal deps trivial.
export const TAB_RECOVERY_AGGREGATE_ID = 'section15:tab-recovery';

// Which restore handle matched (mirrors SessionRestoreMatch.matchedOn
// in the extension's pure matcher). Recorded for provenance only — the
// counter treats any successful restore as one recovery.
export const CHROME_SESSIONS_RESTORE_MATCHED_ON = ['url', 'url+title'] as const;

export type ChromeSessionsRestoreMatchedOn = (typeof CHROME_SESSIONS_RESTORE_MATCHED_ON)[number];

export interface ChromeSessionsRestorePayload {
  readonly payloadVersion: 1;
  // Chrome's restore handle. Opaque; kept for provenance/debugging.
  readonly sessionId: string;
  // How the extension's matcher identified the closed session.
  readonly matchedOn: ChromeSessionsRestoreMatchedOn;
  // Optional thread the recovery was initiated from, for cross-checking
  // against the §13 recovery surface. Never a URL/title (privacy: the
  // restored URL is already in the timeline).
  readonly threadId?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isMatchedOn = (value: unknown): value is ChromeSessionsRestoreMatchedOn =>
  value === 'url' || value === 'url+title';

export const isChromeSessionsRestorePayload = (
  value: unknown,
): value is ChromeSessionsRestorePayload => {
  if (!isRecord(value)) return false;
  return (
    value['payloadVersion'] === 1 &&
    isNonEmptyString(value['sessionId']) &&
    isMatchedOn(value['matchedOn']) &&
    (value['threadId'] === undefined || isNonEmptyString(value['threadId']))
  );
};

export const NAVIGATION_COMMITTED = 'navigation.committed' as const;

export type NavigationEventType = typeof NAVIGATION_COMMITTED;

export type NavigationTransitionType =
  | 'link'
  | 'typed'
  | 'auto_bookmark'
  | 'auto_subframe'
  | 'manual_subframe'
  | 'generated'
  | 'start_page'
  | 'form_submit'
  | 'reload'
  | 'keyword'
  | 'keyword_generated';

export type NavigationTransitionQualifier =
  | 'client_redirect'
  | 'server_redirect'
  | 'forward_back'
  | 'from_address_bar';

export interface NavigationCommittedPayload {
  readonly payloadVersion: 1;
  readonly visitId: string;
  readonly url: string;
  readonly canonicalUrl: string;
  readonly documentId: string;
  readonly parentDocumentId: string | null;
  readonly tabSessionIdHash: string;
  readonly windowSessionIdHash: string;
  readonly openerVisitId: string | null;
  readonly previousVisitId: string | null;
  readonly navigationSequence: number;
  readonly transitionType: NavigationTransitionType;
  readonly transitionQualifiers: readonly NavigationTransitionQualifier[];
  readonly commitTimestamp: number;
  readonly dimensions?: {
    readonly provenance?: Record<string, unknown>;
  };
}

const TRANSITION_TYPES: ReadonlySet<string> = new Set([
  'link',
  'typed',
  'auto_bookmark',
  'auto_subframe',
  'manual_subframe',
  'generated',
  'start_page',
  'form_submit',
  'reload',
  'keyword',
  'keyword_generated',
]);

const TRANSITION_QUALIFIERS: ReadonlySet<string> = new Set([
  'client_redirect',
  'server_redirect',
  'forward_back',
  'from_address_bar',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasAllowedDimensions = (value: Record<string, unknown>): boolean => {
  if (value['dimensions'] === undefined) return true;
  if (!isRecord(value['dimensions'])) return false;
  return Object.keys(value['dimensions']).every((key) => key === 'provenance');
};

export const isNavigationCommittedPayload = (
  value: unknown,
): value is NavigationCommittedPayload => {
  if (!isRecord(value)) return false;
  if (value['payloadVersion'] !== 1) return false;
  for (const key of [
    'visitId',
    'url',
    'canonicalUrl',
    'documentId',
    'tabSessionIdHash',
    'windowSessionIdHash',
  ]) {
    if (typeof value[key] !== 'string' || value[key].length === 0) return false;
  }
  if (value['parentDocumentId'] !== null && typeof value['parentDocumentId'] !== 'string') {
    return false;
  }
  if (value['openerVisitId'] !== null && typeof value['openerVisitId'] !== 'string') {
    return false;
  }
  if (value['previousVisitId'] !== null && typeof value['previousVisitId'] !== 'string') {
    return false;
  }
  if (typeof value['navigationSequence'] !== 'number' || value['navigationSequence'] < 1) {
    return false;
  }
  if (typeof value['commitTimestamp'] !== 'number' || !Number.isFinite(value['commitTimestamp'])) {
    return false;
  }
  if (
    typeof value['transitionType'] !== 'string' ||
    !TRANSITION_TYPES.has(value['transitionType'])
  ) {
    return false;
  }
  if (!Array.isArray(value['transitionQualifiers'])) return false;
  if (
    !value['transitionQualifiers'].every(
      (qualifier) => typeof qualifier === 'string' && TRANSITION_QUALIFIERS.has(qualifier),
    )
  ) {
    return false;
  }
  return hasAllowedDimensions(value);
};

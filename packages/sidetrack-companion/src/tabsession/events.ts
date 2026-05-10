export const TAB_SESSION_ATTRIBUTION_INFERRED = 'tabsession.attribution.inferred' as const;

export interface TabSessionAttributionInferredPayload {
  readonly payloadVersion: 1;
  readonly tabSessionId: string;
  readonly workstreamId: string;
  readonly policyMode: 'conservative' | 'balanced' | 'aggressive';
  readonly dominantSource: 'ppr' | 'similarity' | 'cluster';
  readonly rawFusionLogit: number;
  readonly margin: number;
  readonly corroborationCount: number;
  readonly modelRevision: string;
  readonly graphRevision: string;
  readonly evidenceHash: string;
  readonly resolverDependencyKey: string;
  readonly reasonSummary: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isPolicyMode = (
  value: unknown,
): value is TabSessionAttributionInferredPayload['policyMode'] =>
  value === 'conservative' || value === 'balanced' || value === 'aggressive';

const isDominantSource = (
  value: unknown,
): value is TabSessionAttributionInferredPayload['dominantSource'] =>
  value === 'ppr' || value === 'similarity' || value === 'cluster';

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const isTabSessionAttributionInferredPayload = (
  value: unknown,
): value is TabSessionAttributionInferredPayload => {
  if (!isRecord(value)) return false;
  const corroborationCount = value['corroborationCount'];
  return (
    value['payloadVersion'] === 1 &&
    isNonEmptyString(value['tabSessionId']) &&
    isNonEmptyString(value['workstreamId']) &&
    isPolicyMode(value['policyMode']) &&
    isDominantSource(value['dominantSource']) &&
    isFiniteNumber(value['rawFusionLogit']) &&
    isFiniteNumber(value['margin']) &&
    isNonEmptyString(value['modelRevision']) &&
    isNonEmptyString(value['graphRevision']) &&
    isNonEmptyString(value['evidenceHash']) &&
    isNonEmptyString(value['resolverDependencyKey']) &&
    isNonEmptyString(value['reasonSummary']) &&
    typeof corroborationCount === 'number' &&
    Number.isInteger(corroborationCount) &&
    corroborationCount >= 0
  );
};

// Per-canonical-URL attribution events.
//
// Explicit attribution is recorded via `user.organized.item` with
// `itemKind: 'canonical-url'` (itemId = the canonical URL string).
// Inferred (resolver-applied) attribution lives in this stream, parallel
// to `tabsession.attribution.inferred`. Keeping them separate lets
// projections distinguish "user said so" from "model said so" without
// ambiguity, exactly like the tab-session split.

export const URL_ATTRIBUTION_INFERRED = 'urls.attribution.inferred' as const;

export interface UrlAttributionInferredPayload {
  readonly payloadVersion: 1;
  readonly canonicalUrl: string;
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
): value is UrlAttributionInferredPayload['policyMode'] =>
  value === 'conservative' || value === 'balanced' || value === 'aggressive';

const isDominantSource = (
  value: unknown,
): value is UrlAttributionInferredPayload['dominantSource'] =>
  value === 'ppr' || value === 'similarity' || value === 'cluster';

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const isUrlAttributionInferredPayload = (
  value: unknown,
): value is UrlAttributionInferredPayload => {
  if (!isRecord(value)) return false;
  const corroborationCount = value['corroborationCount'];
  return (
    value['payloadVersion'] === 1 &&
    isNonEmptyString(value['canonicalUrl']) &&
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

import {
  PAGE_CONTENT_EXTRACTED,
  PAGE_CONTENT_TOMBSTONED,
  type PageContentExtractedPayload,
  type PageContentExtractionStrategy,
  type PageContentPolicyTrigger,
  type PageContentQuality,
  type PageContentQualitySignals,
  type PageContentTombstonedPayload,
} from './types.js';

const EXTRACTION_STRATEGIES: ReadonlySet<string> = new Set([
  'manual-selection',
  'reader-mode',
  'visible-dom',
]);
const POLICY_TRIGGERS: ReadonlySet<string> = new Set([
  'manual',
  'workstream-policy',
  'save-suggestion',
  'allowlist',
  'attention-gate',
  'bulk-open-tabs',
]);
const QUALITIES: ReadonlySet<string> = new Set(['high', 'medium', 'low']);
const TOMBSTONE_REASONS: ReadonlySet<string> = new Set([
  'user-delete',
  'policy-revoked',
  'retention-expired',
  'quality-reject',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));

const isUrlString = (value: unknown): value is string => {
  if (!isNonEmptyString(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const isExtractionStrategy = (value: unknown): value is PageContentExtractionStrategy =>
  typeof value === 'string' && EXTRACTION_STRATEGIES.has(value);

const isPolicyTrigger = (value: unknown): value is PageContentPolicyTrigger =>
  typeof value === 'string' && POLICY_TRIGGERS.has(value);

const isQuality = (value: unknown): value is PageContentQuality =>
  typeof value === 'string' && QUALITIES.has(value);

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isQualitySignals = (value: unknown): value is PageContentQualitySignals =>
  isRecord(value) &&
  Number.isInteger(value['extractedWordCount']) &&
  (value['extractedWordCount'] as number) >= 0 &&
  isFiniteNonNegative(value['contentToDomRatio']) &&
  isFiniteNonNegative(value['boilerplateFraction']) &&
  isExtractionStrategy(value['extractionStrategy']) &&
  (value['headingSignatureHash'] === undefined ||
    typeof value['headingSignatureHash'] === 'string');

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

export const isPageContentExtractedPayload = (
  value: unknown,
): value is PageContentExtractedPayload => {
  if (!isRecord(value)) return false;
  const policy = value['extractionPolicy'];
  const content = value['content'];
  const redaction = value['redaction'];
  return (
    value['payloadVersion'] === 1 &&
    isUrlString(value['canonicalUrl']) &&
    isUrlString(value['url']) &&
    (value['title'] === undefined || typeof value['title'] === 'string') &&
    (value['provider'] === undefined || typeof value['provider'] === 'string') &&
    isIsoDate(value['extractedAt']) &&
    isExtractionStrategy(value['extractionSource']) &&
    isRecord(policy) &&
    isPolicyTrigger(policy['trigger']) &&
    (policy['workstreamId'] === undefined || typeof policy['workstreamId'] === 'string') &&
    (policy['domainPolicyId'] === undefined || typeof policy['domainPolicyId'] === 'string') &&
    isQuality(value['quality']) &&
    isQualitySignals(value['qualitySignals']) &&
    isRecord(content) &&
    isNonEmptyString(content['text']) &&
    (content['markdown'] === undefined || typeof content['markdown'] === 'string') &&
    isNonEmptyString(content['contentHash']) &&
    Number.isInteger(content['charCount']) &&
    (content['charCount'] as number) >= 0 &&
    (redaction === undefined ||
      (isRecord(redaction) &&
        typeof redaction['applied'] === 'boolean' &&
        isStringArray(redaction['rules']))) &&
    (value['dimensions'] === undefined || isRecord(value['dimensions']))
  );
};

export const isPageContentTombstonedPayload = (
  value: unknown,
): value is PageContentTombstonedPayload =>
  isRecord(value) &&
  value['payloadVersion'] === 1 &&
  isUrlString(value['canonicalUrl']) &&
  isIsoDate(value['tombstonedAt']) &&
  typeof value['reason'] === 'string' &&
  TOMBSTONE_REASONS.has(value['reason']) &&
  (value['contentHash'] === undefined || typeof value['contentHash'] === 'string') &&
  (value['dimensions'] === undefined || isRecord(value['dimensions']));

export const isPageContentPayloadForType = (
  type: string,
  payload: unknown,
): payload is PageContentExtractedPayload | PageContentTombstonedPayload => {
  if (type === PAGE_CONTENT_EXTRACTED) return isPageContentExtractedPayload(payload);
  if (type === PAGE_CONTENT_TOMBSTONED) return isPageContentTombstonedPayload(payload);
  return false;
};

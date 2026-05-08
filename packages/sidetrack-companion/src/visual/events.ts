export const VISUAL_FINGERPRINT_OBSERVED = 'visual.fingerprint.observed' as const;

export type VisualEventType = typeof VISUAL_FINGERPRINT_OBSERVED;

export interface VisualFingerprintObservedPayload {
  readonly payloadVersion: 1;
  readonly visitId: string;
  readonly domHash: string;
  readonly observedAt: string;
}

const SHA256_HEX_RE = /^[a-f0-9]{64}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isVisualFingerprintObservedPayload = (
  value: unknown,
): value is VisualFingerprintObservedPayload =>
  isRecord(value) &&
  value['payloadVersion'] === 1 &&
  typeof value['visitId'] === 'string' &&
  value['visitId'].length > 0 &&
  typeof value['domHash'] === 'string' &&
  SHA256_HEX_RE.test(value['domHash']) &&
  typeof value['observedAt'] === 'string' &&
  value['observedAt'].length > 0 &&
  value['observedAt'].length <= 64 &&
  Number.isFinite(Date.parse(value['observedAt'])) &&
  value['pHash'] === undefined &&
  value['screenshot'] === undefined &&
  value['contents'] === undefined &&
  value['dimensions'] === undefined;

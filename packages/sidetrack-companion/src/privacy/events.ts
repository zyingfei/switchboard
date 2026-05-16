export const PRIVACY_GATE_FLIPPED = 'privacy.gate.flipped' as const;
export const PRIVACY_PERMISSION_GRANTED = 'privacy.permission.granted' as const;
export const PRIVACY_PERMISSION_REVOKED = 'privacy.permission.revoked' as const;

export type PrivacyEventType =
  | typeof PRIVACY_GATE_FLIPPED
  | typeof PRIVACY_PERMISSION_GRANTED
  | typeof PRIVACY_PERMISSION_REVOKED;

export type PrivacyGateState = 'open' | 'closed';
export type PrivacyActor = 'user' | 'system';

interface PayloadExtensionFields {
  readonly payloadVersion?: number;
  readonly dimensions?: Record<string, unknown>;
}

export interface PrivacyGateFlippedPayload extends PayloadExtensionFields {
  readonly gate: string;
  readonly state: PrivacyGateState;
  readonly actor: PrivacyActor;
  readonly reason?: string;
}

export interface PrivacyPermissionGrantedPayload extends PayloadExtensionFields {
  readonly permission: string;
  readonly scope: Record<string, unknown>;
}

export interface PrivacyPermissionRevokedPayload extends PayloadExtensionFields {
  readonly permission: string;
  readonly scope: Record<string, unknown>;
  readonly retroactiveMask: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasValidPayloadExtensionFields = (value: Record<string, unknown>): boolean =>
  (value['payloadVersion'] === undefined ||
    (typeof value['payloadVersion'] === 'number' && value['payloadVersion'] >= 1)) &&
  (value['dimensions'] === undefined || isRecord(value['dimensions']));

export const isPrivacyGateFlippedPayload = (value: unknown): value is PrivacyGateFlippedPayload =>
  isRecord(value) &&
  typeof value['gate'] === 'string' &&
  value['gate'].length > 0 &&
  (value['state'] === 'open' || value['state'] === 'closed') &&
  (value['actor'] === 'user' || value['actor'] === 'system') &&
  (value['reason'] === undefined || typeof value['reason'] === 'string') &&
  hasValidPayloadExtensionFields(value);

export const isPrivacyPermissionGrantedPayload = (
  value: unknown,
): value is PrivacyPermissionGrantedPayload =>
  isRecord(value) &&
  typeof value['permission'] === 'string' &&
  value['permission'].length > 0 &&
  isRecord(value['scope']) &&
  hasValidPayloadExtensionFields(value);

export const isPrivacyPermissionRevokedPayload = (
  value: unknown,
): value is PrivacyPermissionRevokedPayload =>
  isRecord(value) &&
  typeof value['permission'] === 'string' &&
  value['permission'].length > 0 &&
  isRecord(value['scope']) &&
  typeof value['retroactiveMask'] === 'boolean' &&
  hasValidPayloadExtensionFields(value);

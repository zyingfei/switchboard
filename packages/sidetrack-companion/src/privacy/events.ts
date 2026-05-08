export const PRIVACY_GATE_FLIPPED = 'privacy.gate.flipped' as const;
export const PRIVACY_PERMISSION_GRANTED = 'privacy.permission.granted' as const;
export const PRIVACY_PERMISSION_REVOKED = 'privacy.permission.revoked' as const;

export type PrivacyEventType =
  | typeof PRIVACY_GATE_FLIPPED
  | typeof PRIVACY_PERMISSION_GRANTED
  | typeof PRIVACY_PERMISSION_REVOKED;

export interface PrivacyGateFlippedPayload {
  readonly enabled: boolean;
  readonly reason?: 'user-toggle' | 'migration-shim';
}
export interface PrivacyPermissionGrantedPayload { readonly permission: string; }
export interface PrivacyPermissionRevokedPayload {
  readonly permission: string;
  readonly retroactiveMask?: boolean;
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
export const isPrivacyGateFlippedPayload = (value: unknown): value is PrivacyGateFlippedPayload =>
  isRecord(value) && typeof value['enabled'] === 'boolean' && (value['reason'] === undefined || value['reason'] === 'user-toggle' || value['reason'] === 'migration-shim');
export const isPrivacyPermissionGrantedPayload = (value: unknown): value is PrivacyPermissionGrantedPayload =>
  isRecord(value) && typeof value['permission'] === 'string' && (value['permission'] as string).length > 0;
export const isPrivacyPermissionRevokedPayload = (value: unknown): value is PrivacyPermissionRevokedPayload =>
  isRecord(value) && typeof value['permission'] === 'string' && (value['permission'] as string).length > 0 && (value['retroactiveMask'] === undefined || typeof value['retroactiveMask'] === 'boolean');

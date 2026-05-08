import type { AcceptedEvent } from '../sync/causal.js';
import {
  isPrivacyGateFlippedPayload,
  isPrivacyPermissionGrantedPayload,
  isPrivacyPermissionRevokedPayload,
  PRIVACY_GATE_FLIPPED,
  PRIVACY_PERMISSION_GRANTED,
  PRIVACY_PERMISSION_REVOKED,
} from './events.js';

export interface PrivacyProjection {
  readonly gateEnabled: boolean;
  readonly grantedPermissions: readonly string[];
  readonly maskedPermissions: readonly string[];
  readonly updatedAtMs: number;
}

export const projectPrivacy = (events: readonly AcceptedEvent[]): PrivacyProjection => {
  let gateEnabled = true;
  const granted = new Set<string>();
  const masked = new Set<string>();
  let updatedAtMs = 0;
  for (const event of events) {
    if (event.type === PRIVACY_GATE_FLIPPED && isPrivacyGateFlippedPayload(event.payload)) {
      gateEnabled = event.payload.enabled;
      updatedAtMs = Math.max(updatedAtMs, event.acceptedAtMs);
      continue;
    }
    if (event.type === PRIVACY_PERMISSION_GRANTED && isPrivacyPermissionGrantedPayload(event.payload)) {
      granted.add(event.payload.permission);
      masked.delete(event.payload.permission);
      updatedAtMs = Math.max(updatedAtMs, event.acceptedAtMs);
      continue;
    }
    if (event.type === PRIVACY_PERMISSION_REVOKED && isPrivacyPermissionRevokedPayload(event.payload)) {
      granted.delete(event.payload.permission);
      if (event.payload.retroactiveMask === true) masked.add(event.payload.permission);
      updatedAtMs = Math.max(updatedAtMs, event.acceptedAtMs);
    }
  }
  return { gateEnabled, grantedPermissions: [...granted].sort(), maskedPermissions: [...masked].sort(), updatedAtMs };
};

export const shouldEmitPrivacyGateMigrationEvent = (input: {
  readonly existingPrivacyEvents: readonly AcceptedEvent[];
  readonly legacyTimelineEnabled: boolean | undefined;
}): boolean => input.legacyTimelineEnabled !== undefined && !input.existingPrivacyEvents.some((event) =>
  event.type === PRIVACY_GATE_FLIPPED || event.type === PRIVACY_PERMISSION_GRANTED || event.type === PRIVACY_PERMISSION_REVOKED,
);

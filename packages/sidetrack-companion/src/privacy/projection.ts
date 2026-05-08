import type { AcceptedEvent } from '../sync/causal.js';
import {
  isPrivacyGateFlippedPayload,
  isPrivacyPermissionGrantedPayload,
  isPrivacyPermissionRevokedPayload,
  PRIVACY_GATE_FLIPPED,
  PRIVACY_PERMISSION_GRANTED,
  PRIVACY_PERMISSION_REVOKED,
  type PrivacyGateState,
} from './events.js';

export interface PrivacyPermissionState {
  readonly permission: string;
  readonly scope: Record<string, unknown>;
}

export interface PrivacyProjection {
  readonly gateStates: Readonly<Record<string, PrivacyGateState>>;
  readonly gateEventCount: number;
  readonly grantedPermissions: readonly PrivacyPermissionState[];
  readonly retroactiveMasks: readonly PrivacyPermissionState[];
  readonly updatedAtMs: number;
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const permissionKey = (permission: string, scope: Record<string, unknown>): string =>
  `${permission}\u0000${stableJson(scope)}`;

const permissionEntries = (
  values: ReadonlyMap<string, PrivacyPermissionState>,
): readonly PrivacyPermissionState[] =>
  [...values.values()].sort((left, right) => {
    const permissionOrder = left.permission.localeCompare(right.permission);
    if (permissionOrder !== 0) return permissionOrder;
    return stableJson(left.scope).localeCompare(stableJson(right.scope));
  });

export const projectPrivacy = (events: readonly AcceptedEvent[]): PrivacyProjection => {
  const gateStates: Record<string, PrivacyGateState> = {};
  const granted = new Map<string, PrivacyPermissionState>();
  const masks = new Map<string, PrivacyPermissionState>();
  let gateEventCount = 0;
  let updatedAtMs = 0;

  for (const event of events) {
    if (event.type === PRIVACY_GATE_FLIPPED && isPrivacyGateFlippedPayload(event.payload)) {
      gateStates[event.payload.gate] = event.payload.state;
      gateEventCount += 1;
      updatedAtMs = Math.max(updatedAtMs, event.acceptedAtMs);
      continue;
    }

    if (event.type === PRIVACY_PERMISSION_GRANTED && isPrivacyPermissionGrantedPayload(event.payload)) {
      const entry = { permission: event.payload.permission, scope: event.payload.scope };
      const key = permissionKey(entry.permission, entry.scope);
      granted.set(key, entry);
      masks.delete(key);
      updatedAtMs = Math.max(updatedAtMs, event.acceptedAtMs);
      continue;
    }

    if (event.type === PRIVACY_PERMISSION_REVOKED && isPrivacyPermissionRevokedPayload(event.payload)) {
      const entry = { permission: event.payload.permission, scope: event.payload.scope };
      const key = permissionKey(entry.permission, entry.scope);
      granted.delete(key);
      if (event.payload.retroactiveMask) masks.set(key, entry);
      updatedAtMs = Math.max(updatedAtMs, event.acceptedAtMs);
    }
  }

  return {
    gateStates,
    gateEventCount,
    grantedPermissions: permissionEntries(granted),
    retroactiveMasks: permissionEntries(masks),
    updatedAtMs,
  };
};

export const shouldEmitPrivacyGateMigrationEvent = (input: {
  readonly existingPrivacyEvents: readonly AcceptedEvent[];
  readonly legacyTimelineEnabled: boolean | undefined;
  readonly gate: string;
}): boolean =>
  input.legacyTimelineEnabled !== undefined &&
  !input.existingPrivacyEvents.some(
    (event) =>
      event.type === PRIVACY_GATE_FLIPPED &&
      isPrivacyGateFlippedPayload(event.payload) &&
      event.payload.gate === input.gate,
  );

import { describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import {
  PRIVACY_GATE_FLIPPED,
  PRIVACY_PERMISSION_GRANTED,
  PRIVACY_PERMISSION_REVOKED,
} from './events.js';
import { projectPrivacy, shouldEmitPrivacyGateMigrationEvent } from './projection.js';

const event = (partial: {
  readonly type: string;
  readonly replicaId: string;
  readonly seq: number;
  readonly payload: Record<string, unknown>;
  readonly acceptedAtMs?: number;
}): AcceptedEvent => ({
  clientEventId: `${partial.replicaId}.${String(partial.seq)}`,
  dot: { replicaId: partial.replicaId, seq: partial.seq },
  deps: {},
  aggregateId: 'privacy',
  type: partial.type,
  payload: partial.payload,
  acceptedAtMs: partial.acceptedAtMs ?? partial.seq,
});

describe('projectPrivacy', () => {
  it('replays events and tracks current gate state', () => {
    const projection = projectPrivacy([
      event({ type: PRIVACY_GATE_FLIPPED, replicaId: 'A', seq: 1, payload: { enabled: false } }),
      event({ type: PRIVACY_PERMISSION_GRANTED, replicaId: 'A', seq: 2, payload: { permission: 'timeline' } }),
      event({ type: PRIVACY_PERMISSION_REVOKED, replicaId: 'B', seq: 1, payload: { permission: 'timeline' } }),
    ]);
    expect(projection.gateEnabled).toBe(false);
    expect(projection.grantedPermissions).toEqual([]);
    expect(projection.maskedPermissions).toEqual([]);
  });

  it('revoke with retroactiveMask preserves masking across replicas', () => {
    const projection = projectPrivacy([
      event({ type: PRIVACY_PERMISSION_GRANTED, replicaId: 'A', seq: 1, payload: { permission: 'timeline' } }),
      event({ type: PRIVACY_PERMISSION_REVOKED, replicaId: 'B', seq: 1, payload: { permission: 'timeline', retroactiveMask: true } }),
    ]);
    expect(projection.grantedPermissions).toEqual([]);
    expect(projection.maskedPermissions).toEqual(['timeline']);
  });
});

describe('shouldEmitPrivacyGateMigrationEvent', () => {
  it('returns true when legacy toggle exists and privacy history is empty', () => {
    expect(shouldEmitPrivacyGateMigrationEvent({ existingPrivacyEvents: [], legacyTimelineEnabled: false })).toBe(true);
  });

  it('returns false once a privacy event exists', () => {
    expect(shouldEmitPrivacyGateMigrationEvent({
      existingPrivacyEvents: [event({ type: PRIVACY_GATE_FLIPPED, replicaId: 'A', seq: 1, payload: { enabled: true } })],
      legacyTimelineEnabled: true,
    })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import {
  isPrivacyGateFlippedPayload,
  isPrivacyPermissionGrantedPayload,
  isPrivacyPermissionRevokedPayload,
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

describe('privacy event predicates', () => {
  it('accept the Stage 1 payload shapes and extension slots', () => {
    expect(
      isPrivacyGateFlippedPayload({
        gate: 'timeline',
        state: 'open',
        actor: 'user',
        reason: 'user-toggle',
        payloadVersion: 1,
        dimensions: { surface: 'settings' },
      }),
    ).toBe(true);
    expect(
      isPrivacyPermissionGrantedPayload({
        permission: 'timeline.hostAccess',
        scope: { origins: ['https://*/*'] },
      }),
    ).toBe(true);
    expect(
      isPrivacyPermissionRevokedPayload({
        permission: 'timeline.hostAccess',
        scope: { origins: ['https://*/*'] },
        retroactiveMask: true,
      }),
    ).toBe(true);
  });
});

describe('projectPrivacy', () => {
  it('replays gate flips into current gate state', () => {
    const projection = projectPrivacy([
      event({
        type: PRIVACY_GATE_FLIPPED,
        replicaId: 'A',
        seq: 1,
        payload: { gate: 'timeline', state: 'closed', actor: 'system' },
      }),
      event({
        type: PRIVACY_GATE_FLIPPED,
        replicaId: 'A',
        seq: 2,
        payload: { gate: 'timeline', state: 'open', actor: 'user', reason: 'user-toggle' },
      }),
    ]);

    expect(projection.gateStates['timeline']).toBe('open');
    expect(projection.gateEventCount).toBe(2);
  });

  it('tracks permission grant and revoke by permission plus scope', () => {
    const scope = { origins: ['https://*/*', 'http://*/*'] };
    const projection = projectPrivacy([
      event({
        type: PRIVACY_PERMISSION_GRANTED,
        replicaId: 'A',
        seq: 1,
        payload: { permission: 'timeline.hostAccess', scope },
      }),
      event({
        type: PRIVACY_PERMISSION_REVOKED,
        replicaId: 'A',
        seq: 2,
        payload: { permission: 'timeline.hostAccess', scope, retroactiveMask: false },
      }),
    ]);

    expect(projection.grantedPermissions).toEqual([]);
    expect(projection.retroactiveMasks).toEqual([]);
  });

  it('preserves retroactive mask replay on revoke', () => {
    const scope = { gate: 'snippet.rawText' };
    const projection = projectPrivacy([
      event({
        type: PRIVACY_PERMISSION_GRANTED,
        replicaId: 'A',
        seq: 1,
        payload: { permission: 'snippet.rawText', scope },
      }),
      event({
        type: PRIVACY_PERMISSION_REVOKED,
        replicaId: 'A',
        seq: 2,
        payload: { permission: 'snippet.rawText', scope, retroactiveMask: true },
      }),
    ]);

    expect(projection.grantedPermissions).toEqual([]);
    expect(projection.retroactiveMasks).toEqual([{ permission: 'snippet.rawText', scope }]);
  });

  it('cross-replica revoke replays over a prior grant', () => {
    const scope = { origins: ['https://example.com/*'] };
    const projection = projectPrivacy([
      event({
        type: PRIVACY_PERMISSION_GRANTED,
        replicaId: 'A',
        seq: 1,
        payload: { permission: 'timeline.hostAccess', scope },
      }),
      event({
        type: PRIVACY_PERMISSION_REVOKED,
        replicaId: 'B',
        seq: 1,
        payload: { permission: 'timeline.hostAccess', scope, retroactiveMask: true },
      }),
    ]);

    expect(projection.grantedPermissions).toEqual([]);
    expect(projection.retroactiveMasks).toEqual([{ permission: 'timeline.hostAccess', scope }]);
  });
});

describe('shouldEmitPrivacyGateMigrationEvent', () => {
  it('returns true when the legacy toggle exists and the gate has no event history', () => {
    expect(
      shouldEmitPrivacyGateMigrationEvent({
        existingPrivacyEvents: [],
        legacyTimelineEnabled: false,
        gate: 'timeline',
      }),
    ).toBe(true);
  });

  it('returns false once that gate has a privacy event', () => {
    expect(
      shouldEmitPrivacyGateMigrationEvent({
        existingPrivacyEvents: [
          event({
            type: PRIVACY_GATE_FLIPPED,
            replicaId: 'A',
            seq: 1,
            payload: { gate: 'timeline', state: 'open', actor: 'system' },
          }),
        ],
        legacyTimelineEnabled: true,
        gate: 'timeline',
      }),
    ).toBe(false);
  });
});

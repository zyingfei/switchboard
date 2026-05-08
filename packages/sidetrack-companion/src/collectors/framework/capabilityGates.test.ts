import { describe, expect, it } from 'vitest';

import {
  PRIVACY_PERMISSION_GRANTED,
  PRIVACY_PERMISSION_REVOKED,
} from '../../privacy/events.js';
import { projectPrivacy } from '../../privacy/projection.js';
import type { AcceptedEvent } from '../../sync/causal.js';
import {
  allCapabilitiesGranted,
  gateStateForCollector,
  parsePermissionKey,
  permissionKeyFor,
} from './capabilityGates.js';

const grantEvent = (input: { readonly permission: string; readonly seq: number }): AcceptedEvent => ({
  clientEventId: `privacy.${String(input.seq)}`,
  dot: { replicaId: 'test', seq: input.seq },
  deps: {},
  aggregateId: 'privacy',
  type: PRIVACY_PERMISSION_GRANTED,
  payload: { permission: input.permission, scope: {} },
  acceptedAtMs: input.seq,
});

const revokeEvent = (input: {
  readonly permission: string;
  readonly seq: number;
}): AcceptedEvent => ({
  clientEventId: `privacy.${String(input.seq)}`,
  dot: { replicaId: 'test', seq: input.seq },
  deps: {},
  aggregateId: 'privacy',
  type: PRIVACY_PERMISSION_REVOKED,
  payload: { permission: input.permission, scope: {}, retroactiveMask: true },
  acceptedAtMs: input.seq,
});

describe('permissionKeyFor', () => {
  it('round-trips through parsePermissionKey', () => {
    expect(parsePermissionKey(permissionKeyFor('my-collector', 'reads-paths'))).toEqual({
      collectorId: 'my-collector',
      capability: 'reads-paths',
    });
  });
});

describe('parsePermissionKey', () => {
  it('returns null for non-collector permission strings', () => {
    expect(parsePermissionKey('not.a.collector.key')).toBeNull();
  });

  it('parses collector permission keys', () => {
    expect(parsePermissionKey('collector.my-collector.reads-paths')).toEqual({
      collectorId: 'my-collector',
      capability: 'reads-paths',
    });
  });
});

describe('gateStateForCollector', () => {
  it('returns granted for an empty projection when the capability is default-enabled', () => {
    expect(
      gateStateForCollector(projectPrivacy([]), 'my-collector', 'reads-paths', true),
    ).toBe('granted');
  });

  it('returns pending for an empty projection when the capability is default-disabled', () => {
    expect(
      gateStateForCollector(projectPrivacy([]), 'my-collector', 'reads-paths', false),
    ).toBe('pending');
  });

  it('returns granted when the privacy projection contains a grant event for the key', () => {
    const permission = permissionKeyFor('my-collector', 'reads-paths');
    const projection = projectPrivacy([grantEvent({ permission, seq: 1 })]);

    expect(gateStateForCollector(projection, 'my-collector', 'reads-paths', false)).toBe(
      'granted',
    );
  });

  it('returns revoked when a revoke follows a grant for the key', () => {
    const permission = permissionKeyFor('my-collector', 'reads-paths');
    const projection = projectPrivacy([
      grantEvent({ permission, seq: 1 }),
      revokeEvent({ permission, seq: 2 }),
    ]);

    expect(gateStateForCollector(projection, 'my-collector', 'reads-paths', true)).toBe(
      'revoked',
    );
  });
});

describe('allCapabilitiesGranted', () => {
  it('returns false when one required collector capability is not granted', () => {
    const projection = projectPrivacy([
      grantEvent({ permission: permissionKeyFor('my-collector', 'reads-paths'), seq: 1 }),
    ]);

    expect(
      allCapabilitiesGranted(projection, {
        id: 'my-collector',
        capabilities: {
          'reads-paths': ['/tmp/sidetrack'],
          'reads-env': ['SIDETRACK_HOME'],
          'default-enabled': false,
        },
      }),
    ).toBe(false);
  });
});

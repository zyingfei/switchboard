import type { PrivacyProjection } from '../../privacy/projection.js';

export type CollectorCapability = 'reads-paths' | 'reads-env' | 'reads-network';
export type GateState = 'granted' | 'revoked' | 'pending';

export interface ManifestForGateCheck {
  readonly id: string;
  readonly capabilities: {
    readonly 'reads-paths'?: readonly string[];
    readonly 'reads-env'?: readonly string[];
    readonly 'reads-network'?: boolean;
    readonly 'default-enabled'?: boolean;
  };
}

export const permissionKeyFor = (
  collectorId: string,
  capability: CollectorCapability,
): string => `collector.${collectorId}.${capability}`;

export const parsePermissionKey = (
  key: string,
): { readonly collectorId: string; readonly capability: string } | null => {
  const prefix = 'collector.';
  if (!key.startsWith(prefix)) return null;

  const body = key.slice(prefix.length);
  const capabilitySeparatorIndex = body.lastIndexOf('.');
  if (capabilitySeparatorIndex <= 0 || capabilitySeparatorIndex === body.length - 1) return null;

  return {
    collectorId: body.slice(0, capabilitySeparatorIndex),
    capability: body.slice(capabilitySeparatorIndex + 1),
  };
};

const hasPermission = (
  permissions: PrivacyProjection['grantedPermissions'] | PrivacyProjection['retroactiveMasks'],
  permission: string,
): boolean => permissions.some((entry) => entry.permission === permission);

export const gateStateForCollector = (
  privacyProjection: PrivacyProjection,
  collectorId: string,
  capability: CollectorCapability,
  defaultEnabled: boolean,
): GateState => {
  const permission = permissionKeyFor(collectorId, capability);

  if (hasPermission(privacyProjection.retroactiveMasks, permission)) return 'revoked';
  if (hasPermission(privacyProjection.grantedPermissions, permission)) return 'granted';

  return defaultEnabled ? 'granted' : 'pending';
};

export const allCapabilitiesGranted = (
  privacyProjection: PrivacyProjection,
  manifest: ManifestForGateCheck,
): boolean => {
  const defaultEnabled = manifest.capabilities['default-enabled'] ?? true;
  const requiredCapabilities: CollectorCapability[] = [];

  if ((manifest.capabilities['reads-paths']?.length ?? 0) > 0) {
    requiredCapabilities.push('reads-paths');
  }
  if ((manifest.capabilities['reads-env']?.length ?? 0) > 0) {
    requiredCapabilities.push('reads-env');
  }
  if (manifest.capabilities['reads-network'] === true) {
    requiredCapabilities.push('reads-network');
  }

  return requiredCapabilities.every(
    (capability) =>
      gateStateForCollector(privacyProjection, manifest.id, capability, defaultEnabled) ===
      'granted',
  );
};

export const quarantineReasonForGateDenial = (): 'privacy-gate-denied' =>
  'privacy-gate-denied';

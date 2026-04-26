import type { CapturedTurn, ProviderId } from '../../companion/model';

export type CaptureRole = CapturedTurn['role'];

export interface DirectTurnSourceConfig {
  readonly selector: string;
  readonly sourceSelector: string;
  readonly role: CaptureRole | 'infer';
  readonly roleAttributes?: readonly string[];
  readonly tagRoles?: Readonly<Record<string, CaptureRole>>;
  readonly alternatingRoles?: readonly [CaptureRole, CaptureRole];
  readonly filterNestedMatches?: boolean;
}

export interface HeadingRolePattern {
  readonly pattern: string;
  readonly role: CaptureRole;
}

export interface HeadingTurnSourceConfig {
  readonly selector: string;
  readonly sourceSelector: string;
  readonly rolePatterns: readonly HeadingRolePattern[];
  readonly maxAncestorChars?: number;
}

export interface EditableTurnSourceConfig {
  readonly selector: string;
  readonly sourceSelector: string;
  readonly role: CaptureRole;
  readonly minTextLength: number;
  readonly excludePattern?: string;
}

export interface ProviderExtractionConfig {
  readonly provider: ProviderId;
  readonly version: string;
  readonly mergeAdjacentSameRoleTurns?: boolean;
  readonly directSources: readonly DirectTurnSourceConfig[];
  readonly headingSources?: readonly HeadingTurnSourceConfig[];
  readonly editableSources?: readonly EditableTurnSourceConfig[];
}

export type ProviderConfigRegistry = Readonly<Record<ProviderId, ProviderExtractionConfig>>;

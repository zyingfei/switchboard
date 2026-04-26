import type { CaptureRole, ProviderId } from '../model';

export interface DirectTurnSourceConfig {
  selector: string;
  sourceSelector: string;
  role: CaptureRole | 'infer';
  roleAttributes?: string[];
  tagRoles?: Record<string, CaptureRole>;
  alternatingRoles?: [CaptureRole, CaptureRole];
  filterNestedMatches?: boolean;
}

export interface HeadingRolePattern {
  pattern: string;
  role: CaptureRole;
}

export interface HeadingTurnSourceConfig {
  selector: string;
  sourceSelector: string;
  rolePatterns: HeadingRolePattern[];
  maxAncestorChars?: number;
}

export interface EditableTurnSourceConfig {
  selector: string;
  sourceSelector: string;
  role: CaptureRole;
  minTextLength: number;
  excludePattern?: string;
}

export interface ProviderExtractionConfig {
  provider: ProviderId;
  version: string;
  mergeAdjacentSameRoleTurns?: boolean;
  directSources: DirectTurnSourceConfig[];
  headingSources?: HeadingTurnSourceConfig[];
  editableSources?: EditableTurnSourceConfig[];
}

export type ProviderConfigRegistry = Record<ProviderId, ProviderExtractionConfig>;

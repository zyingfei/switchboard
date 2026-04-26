export const supportedProviderIds = ['chatgpt', 'claude', 'gemini'] as const;

export type SupportedProviderId = (typeof supportedProviderIds)[number];

export type ProviderId = SupportedProviderId | 'unknown';

export type CaptureRole = 'user' | 'assistant' | 'system' | 'unknown';

export type SelectorCanary = 'passed' | 'fallback' | 'failed';

export type TrackedThreadStatus = 'active' | 'waiting_on_user' | 'waiting_on_ai' | 'stale' | 'fallback';

export type CaptureWarningCode =
  | 'possible_api_key'
  | 'email'
  | 'internal_url'
  | 'long_capture'
  | 'unsupported_provider';

export interface CapturedTurn {
  id: string;
  role: CaptureRole;
  text: string;
  formattedText?: string;
  ordinal: number;
  sourceSelector: string;
}

export type CaptureArtifactKind = 'report' | 'bundle' | 'document' | 'unknown';

export interface CapturedArtifactLink {
  id: string;
  label: string;
  url: string;
}

export interface CapturedArtifact {
  id: string;
  kind: CaptureArtifactKind;
  title: string;
  text: string;
  formattedText: string;
  sourceSelector: string;
  sourceUrl?: string;
  links: CapturedArtifactLink[];
}

export interface CaptureWarning {
  code: CaptureWarningCode;
  message: string;
  severity: 'info' | 'warning';
}

export interface ProviderCapture {
  id: string;
  provider: ProviderId;
  url: string;
  title: string;
  capturedAt: string;
  extractionConfigVersion?: string;
  selectorCanary: SelectorCanary;
  turns: CapturedTurn[];
  artifacts: CapturedArtifact[];
  warnings: CaptureWarning[];
  visibleTextCharCount: number;
}

export interface ActiveTabSummary {
  id?: number;
  provider: ProviderId;
  supported: boolean;
  title: string;
  url: string;
  trackedThreadStatus?: TrackedThreadStatus;
  captureCount?: number;
  lastTurnAt?: string;
  reason?: string;
  warning?: string;
}

export interface ProviderSelectorHealth {
  provider: SupportedProviderId;
  cleanLoads: number;
  recentLoads: number;
  fallbackLoads: number;
  failedLoads: number;
  latestStatus?: SelectorCanary;
  latestCheckedAt?: string;
}

export interface CaptureState {
  captures: ProviderCapture[];
  lastActiveTab: ActiveTabSummary | null;
  selectorHealth: ProviderSelectorHealth[];
  lastError: string | null;
  updatedAt: string;
}

export const providerLabels: Record<ProviderId, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  unknown: 'Unknown',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const normalizeProviderId = (value: unknown): ProviderId =>
  value === 'chatgpt' || value === 'claude' || value === 'gemini' || value === 'unknown' ? value : 'unknown';

const normalizeSelectorCanary = (value: unknown): SelectorCanary =>
  value === 'passed' || value === 'fallback' || value === 'failed' ? value : 'failed';

const normalizeTrackedThreadStatus = (value: unknown): TrackedThreadStatus =>
  value === 'active' ||
  value === 'waiting_on_user' ||
  value === 'waiting_on_ai' ||
  value === 'stale' ||
  value === 'fallback'
    ? value
    : 'active';

const normalizeCaptureRole = (value: unknown): CaptureRole =>
  value === 'user' || value === 'assistant' || value === 'system' || value === 'unknown' ? value : 'unknown';

const normalizeWarningCode = (value: unknown): CaptureWarningCode =>
  value === 'possible_api_key' ||
  value === 'email' ||
  value === 'internal_url' ||
  value === 'long_capture' ||
  value === 'unsupported_provider'
    ? value
    : 'unsupported_provider';

export const normalizeProviderCapture = (value: unknown): ProviderCapture => {
  const capture = isRecord(value) ? value : {};
  const turns = Array.isArray(capture.turns) ? capture.turns : [];
  const artifacts = Array.isArray(capture.artifacts) ? capture.artifacts : [];
  const warnings = Array.isArray(capture.warnings) ? capture.warnings : [];

  return {
    id: typeof capture.id === 'string' ? capture.id : 'capture-unknown',
    provider: normalizeProviderId(capture.provider),
    url: typeof capture.url === 'string' ? capture.url : '',
    title: typeof capture.title === 'string' ? capture.title : 'Untitled capture',
    capturedAt: typeof capture.capturedAt === 'string' ? capture.capturedAt : new Date(0).toISOString(),
    extractionConfigVersion:
      typeof capture.extractionConfigVersion === 'string' ? capture.extractionConfigVersion : undefined,
    selectorCanary: normalizeSelectorCanary(capture.selectorCanary),
    turns: turns.map((turn, index) => {
      const item = isRecord(turn) ? turn : {};
      const text = typeof item.text === 'string' ? item.text : '';
      return {
        id: typeof item.id === 'string' ? item.id : `turn-${index + 1}`,
        role: normalizeCaptureRole(item.role),
        text,
        formattedText: typeof item.formattedText === 'string' ? item.formattedText : text,
        ordinal: typeof item.ordinal === 'number' ? item.ordinal : index,
        sourceSelector: typeof item.sourceSelector === 'string' ? item.sourceSelector : 'unknown',
      };
    }),
    artifacts: artifacts.map((artifact, index) => {
      const item = isRecord(artifact) ? artifact : {};
      const text = typeof item.text === 'string' ? item.text : '';
      const links = Array.isArray(item.links) ? item.links : [];
      return {
        id: typeof item.id === 'string' ? item.id : `artifact-${index + 1}`,
        kind:
          item.kind === 'report' || item.kind === 'bundle' || item.kind === 'document' || item.kind === 'unknown'
            ? item.kind
            : 'unknown',
        title: typeof item.title === 'string' ? item.title : `Artifact ${index + 1}`,
        text,
        formattedText: typeof item.formattedText === 'string' ? item.formattedText : text,
        sourceSelector: typeof item.sourceSelector === 'string' ? item.sourceSelector : 'unknown',
        sourceUrl: typeof item.sourceUrl === 'string' ? item.sourceUrl : undefined,
        links: links.map((link, linkIndex) => {
          const linkItem = isRecord(link) ? link : {};
          return {
            id: typeof linkItem.id === 'string' ? linkItem.id : `artifact-${index + 1}-link-${linkIndex + 1}`,
            label: typeof linkItem.label === 'string' ? linkItem.label : `Link ${linkIndex + 1}`,
            url: typeof linkItem.url === 'string' ? linkItem.url : '',
          };
        }),
      };
    }),
    warnings: warnings.map((warning) => {
      const item = isRecord(warning) ? warning : {};
      return {
        code: normalizeWarningCode(item.code),
        message: typeof item.message === 'string' ? item.message : 'Capture contains unsupported content.',
        severity: item.severity === 'warning' || item.severity === 'info' ? item.severity : 'info',
      };
    }),
    visibleTextCharCount:
      typeof capture.visibleTextCharCount === 'number'
        ? capture.visibleTextCharCount
        : turns
            .map((turn) => (isRecord(turn) && typeof turn.text === 'string' ? turn.text : ''))
            .join('\n\n').length,
  };
};

export const normalizeCaptureState = (value: unknown): CaptureState => {
  const state = isRecord(value) ? value : {};
  const captures = Array.isArray(state.captures) ? state.captures.map(normalizeProviderCapture) : [];
  const activeTab = isRecord(state.lastActiveTab) ? state.lastActiveTab : null;
  const selectorHealth = Array.isArray(state.selectorHealth) ? state.selectorHealth : [];

  return {
    captures,
    lastActiveTab: activeTab
      ? {
          id: typeof activeTab.id === 'number' ? activeTab.id : undefined,
          provider: normalizeProviderId(activeTab.provider),
          supported: typeof activeTab.supported === 'boolean' ? activeTab.supported : false,
          title: typeof activeTab.title === 'string' ? activeTab.title : 'Untitled page',
          url: typeof activeTab.url === 'string' ? activeTab.url : '',
          trackedThreadStatus:
            typeof activeTab.trackedThreadStatus === 'string'
              ? normalizeTrackedThreadStatus(activeTab.trackedThreadStatus)
              : undefined,
          captureCount: typeof activeTab.captureCount === 'number' ? activeTab.captureCount : undefined,
          lastTurnAt: typeof activeTab.lastTurnAt === 'string' ? activeTab.lastTurnAt : undefined,
          reason: typeof activeTab.reason === 'string' ? activeTab.reason : undefined,
          warning: typeof activeTab.warning === 'string' ? activeTab.warning : undefined,
        }
      : null,
    selectorHealth: selectorHealth
      .map((entry) => (isRecord(entry) ? entry : {}))
      .filter(
        (entry): entry is Record<string, unknown> =>
          entry.provider === 'chatgpt' || entry.provider === 'claude' || entry.provider === 'gemini',
      )
      .map((entry) => ({
        provider: entry.provider as SupportedProviderId,
        cleanLoads: typeof entry.cleanLoads === 'number' ? entry.cleanLoads : 0,
        recentLoads: typeof entry.recentLoads === 'number' ? entry.recentLoads : 0,
        fallbackLoads: typeof entry.fallbackLoads === 'number' ? entry.fallbackLoads : 0,
        failedLoads: typeof entry.failedLoads === 'number' ? entry.failedLoads : 0,
        latestStatus:
          entry.latestStatus === 'passed' || entry.latestStatus === 'fallback' || entry.latestStatus === 'failed'
            ? entry.latestStatus
            : undefined,
        latestCheckedAt: typeof entry.latestCheckedAt === 'string' ? entry.latestCheckedAt : undefined,
      })),
    lastError: typeof state.lastError === 'string' ? state.lastError : null,
    updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : new Date(0).toISOString(),
  };
};

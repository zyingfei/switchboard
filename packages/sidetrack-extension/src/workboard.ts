import type {
  CaptureEvent,
  ChecklistItem,
  CompanionSettings,
  ProviderId,
  TabSnapshot,
} from './companion/model';

export type CompanionStatus = 'connected' | 'disconnected' | 'vault-error' | 'local-only';
export type TrackingMode = 'auto' | 'manual' | 'stopped' | 'removed' | 'archived';
export type PrivacyMode = 'private' | 'shared' | 'public';

export interface WorkboardSection {
  readonly id:
    | 'current-tab'
    | 'active-work'
    | 'queued'
    | 'inbound'
    | 'needs-organize'
    | 'recent-search';
  readonly label: string;
  readonly emptyText: string;
}

export interface TrackedThread {
  readonly bac_id: string;
  readonly provider: ProviderId;
  readonly threadId?: string;
  readonly threadUrl: string;
  readonly title: string;
  readonly lastSeenAt: string;
  readonly status:
    | 'active'
    | 'tracked'
    | 'queued'
    | 'needs_organize'
    | 'closed'
    | 'restorable'
    | 'archived'
    | 'removed';
  readonly trackingMode: TrackingMode;
  readonly primaryWorkstreamId?: string;
  readonly tags: readonly string[];
  readonly selectorCanary?: NonNullable<CaptureEvent['selectorCanary']>;
  readonly tabSnapshot?: TabSnapshot;
}

export interface WorkstreamNode {
  readonly bac_id: string;
  readonly revision: string;
  readonly title: string;
  readonly parentId?: string;
  readonly children: readonly string[];
  readonly tags: readonly string[];
  readonly checklist: readonly ChecklistItem[];
  readonly privacy: PrivacyMode;
  readonly updatedAt: string;
}

export interface QueueItem {
  readonly bac_id: string;
  readonly text: string;
  readonly scope: 'thread' | 'workstream' | 'global';
  readonly targetId?: string;
  readonly status: 'pending' | 'done' | 'dismissed';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InboundReminder {
  readonly bac_id: string;
  readonly revision?: string;
  readonly threadId: string;
  readonly provider: ProviderId;
  readonly detectedAt: string;
  readonly status: 'new' | 'seen' | 'relevant' | 'dismissed';
}

export interface SelectorHealth {
  readonly provider: Exclude<ProviderId, 'unknown'>;
  readonly latestStatus: NonNullable<CaptureEvent['selectorCanary']>;
  readonly latestCheckedAt: string;
  readonly warning?: string;
}

export interface UiSettings {
  readonly companion: CompanionSettings;
  readonly autoTrack: boolean;
  readonly siteToggles: Readonly<Record<Exclude<ProviderId, 'unknown'>, boolean>>;
}

export type CodingTool = 'claude_code' | 'codex' | 'cursor' | 'other';

export interface CodingSession {
  readonly bac_id: string;
  readonly workstreamId?: string;
  readonly tool: CodingTool;
  readonly cwd: string;
  readonly branch: string;
  readonly sessionId: string;
  readonly name: string;
  readonly resumeCommand?: string;
  readonly attachedAt: string;
  readonly lastSeenAt: string;
  readonly status: 'attached' | 'detached';
}

export interface WorkboardState {
  readonly companionStatus: CompanionStatus;
  readonly vaultPath?: string;
  readonly queuedCaptureCount: number;
  readonly droppedCaptureCount: number;
  readonly settings: UiSettings;
  readonly currentTab?: TrackedThread;
  readonly threads: readonly TrackedThread[];
  readonly workstreams: readonly WorkstreamNode[];
  readonly queueItems: readonly QueueItem[];
  readonly reminders: readonly InboundReminder[];
  readonly selectorHealth: readonly SelectorHealth[];
  readonly collapsedSections: readonly WorkboardSection['id'][];
  readonly codingSessions: readonly CodingSession[];
  readonly lastError?: string;
  readonly updatedAt: string;
}

export const initialWorkboardSections: readonly WorkboardSection[] = [
  {
    id: 'current-tab',
    label: 'Current Tab',
    emptyText: 'Open an AI thread or track the current page.',
  },
  {
    id: 'active-work',
    label: 'Active Work',
    emptyText: 'Tracked threads will appear here once you start capturing.',
  },
  {
    id: 'queued',
    label: 'Queued',
    emptyText: 'Follow-ups you park for later will collect here.',
  },
  {
    id: 'inbound',
    label: 'Inbound',
    emptyText: 'Replies from tracked threads will surface here.',
  },
  {
    id: 'needs-organize',
    label: 'Needs Organize',
    emptyText: 'Unplaced tracked work starts here before you move it.',
  },
  {
    id: 'recent-search',
    label: 'Recent / Search',
    emptyText: 'Recently touched work and lexical search land in this section.',
  },
];

export const companionStatusLabel = (status: CompanionStatus): string => {
  if (status === 'connected') {
    return 'vault: synced';
  }

  if (status === 'vault-error') {
    return 'vault: unreachable';
  }

  if (status === 'local-only') {
    return 'local-only';
  }

  return 'vault: disconnected';
};

export const maskTitleForPrivacy = (
  thread: TrackedThread,
  workstreams: readonly WorkstreamNode[],
): string => {
  const workstream = workstreams.find(
    (candidate) => candidate.bac_id === thread.primaryWorkstreamId,
  );
  return workstream?.privacy === 'private' ? '[private]' : thread.title;
};

export const defaultSettings: UiSettings = {
  companion: {
    port: 17_373,
    bridgeKey: '',
  },
  autoTrack: true,
  siteToggles: {
    chatgpt: true,
    claude: true,
    gemini: true,
  },
};

export const createEmptyWorkboardState = (
  overrides: Partial<WorkboardState> = {},
): WorkboardState => ({
  companionStatus: 'disconnected',
  queuedCaptureCount: 0,
  droppedCaptureCount: 0,
  settings: defaultSettings,
  threads: [],
  workstreams: [],
  queueItems: [],
  reminders: [],
  selectorHealth: [],
  collapsedSections: [],
  codingSessions: [],
  updatedAt: new Date().toISOString(),
  ...overrides,
});

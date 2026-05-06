import type {
  CaptureEvent,
  ChecklistItem,
  CompanionSettings,
  ProviderId,
  TabSnapshot,
} from './companion/model';
import type { DispatchEventRecord } from './dispatch/types';
import type { ReviewDraft } from './review/types';

export type CompanionStatus = 'connected' | 'disconnected' | 'vault-error' | 'local-only';
export type TrackingMode = 'auto' | 'manual' | 'stopped' | 'removed' | 'archived';
export type PrivacyMode = 'private' | 'shared' | 'public';
export type AllThreadsBucket = 'unread' | 'ungrouped' | 'waiting' | 'stale' | 'normal';

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
  // Set when the provider DOM exposed a "branched from" / "forked from"
  // hint that we matched to an already-tracked thread. parentTitle is a
  // soft fallback when the parent isn't tracked yet.
  readonly parentThreadId?: string;
  readonly parentTitle?: string;
  // Role of the most-recent captured turn — drives the lifecycle pill
  // (Waiting on AI vs You replied last vs Unread reply).
  readonly lastTurnRole?: 'user' | 'assistant' | 'system' | 'unknown';
  // Per-thread auto-send opt-in. When true AND
  // settings.autoSendOptIn[provider] is true, queued follow-ups for
  // this thread are eligible for auto-paste-and-send into the chat
  // composer (one at a time, waiting for the AI to finish replying
  // before sending the next). The actual drain implementation lives
  // behind the §24.10 safety chain in M2; this flag is the contract.
  readonly autoSendEnabled?: boolean;
  // Last observed model the user had picked in the chat (e.g. "Pro",
  // "Thinking", "GPT-5.1 Pro"). Best-effort; surfaced in the dispatch
  // confirm header so the user sees which model their context came
  // from. Provider-specific scraping; absent means we couldn't read
  // the picker (icon-only buttons, dynamic loading, etc).
  readonly selectedModel?: string;
  // Mode of the most recent assistant turn's research surface (Deep
  // Research on ChatGPT, Gemini Deep Research). Sourced from the
  // per-turn `researchReport.mode` enrichment on the most recent
  // assistant turn at capture time. Drives the side-panel mode chip
  // and the markdown sidecar frontmatter; absent for ordinary threads.
  readonly lastResearchMode?: 'deep-research' | 'gemini-deep-research' | 'unknown';
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
  readonly screenShareSensitive?: boolean;
  readonly updatedAt: string;
  // User-curated free-form description. Flows through to the
  // companion's suggester (`buildSignals` reads `${title} {description}`)
  // for both lexical token match and cold-start vector centroid.
  // Surfaced in the workstream-detail panel as a multi-line field.
  readonly description?: string;
}

export interface QueueItem {
  readonly bac_id: string;
  readonly text: string;
  readonly scope: 'thread' | 'workstream' | 'global';
  readonly targetId?: string;
  readonly status: 'pending' | 'done' | 'dismissed';
  readonly createdAt: string;
  readonly updatedAt: string;
  // Set when the auto-send drain tried to ship this item and bailed.
  // Item stays 'pending' so the user can retry once they've fixed the
  // root cause (e.g. open the chat tab, opt the provider in). Cleared
  // on the next successful drain pass.
  readonly lastError?: string;
  readonly progress?: 'typing' | 'waiting';
  // Drag-reorder rank. Stamped per-thread when the user moves rows;
  // sort prefers this over createdAt for items that have it. Items
  // created before reorder shipped (or never reordered) fall back to
  // createdAt — the comparator handles the mixed case.
  readonly sortOrder?: number;
}

export const compareQueueItems = (a: QueueItem, b: QueueItem): number => {
  if (a.sortOrder !== undefined && b.sortOrder !== undefined) {
    return a.sortOrder - b.sortOrder;
  }
  if (a.sortOrder !== undefined) return -1;
  if (b.sortOrder !== undefined) return 1;
  return a.createdAt.localeCompare(b.createdAt);
};

export interface InboundReminder {
  readonly bac_id: string;
  readonly revision?: string;
  readonly threadId: string;
  readonly provider: ProviderId;
  readonly detectedAt: string;
  readonly status: 'new' | 'seen' | 'relevant' | 'dismissed';
  // Ordinal of the assistant turn that triggered this reminder.
  // Stable across re-captures of the same chat — re-injection of the
  // content script (extension reload) replays captures with new
  // capturedAt timestamps, but the assistant turn's ordinal stays
  // pinned to that specific reply. Used by createLocalReminder to
  // dedup: if any existing reminder for this thread already records
  // an ordinal >= the new one, the user has already seen this reply.
  readonly lastAssistantTurnOrdinal?: number;
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
  // Fire a chrome.notifications toast when the auto-send drain
  // finishes shipping the last item for a thread. Default on — the
  // whole point of auto-send is so the user can context-switch
  // away and come back when it's done.
  readonly notifyOnQueueComplete: boolean;
}

// Manual notes the user types in the side panel (and, later, Obsidian /
// external imports). These render in the Captures section, scoped to a
// workstream when one is selected. Distinct from CaptureEvent (which is
// the AI-thread capture log).
export type NoteKind = 'manual' | 'obsidian' | 'external';

export interface CaptureNote {
  readonly bac_id: string;
  readonly kind: NoteKind;
  readonly text: string;
  readonly workstreamId?: string;
  // When set, the note is anchored to a specific tracked thread and
  // renders inline under that thread row as part of its history. The
  // workstream-level captures rail filters these out so notes don't
  // double-render. A note can have both a threadId and a workstreamId
  // (the thread's home workstream); only the inline render fires.
  readonly threadId?: string;
  readonly source?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DispatchDiagnostic {
  readonly capturedAt: string;
  readonly provider: ProviderId;
  readonly matched: boolean;
  readonly reason?:
    | 'window-expired'
    | 'provider-mismatch'
    | 'no-prefix-match'
    | 'tiny-prefix'
    | 'already-linked';
  readonly candidatesConsidered: number;
  readonly bestPrefixMatchLen: number;
  readonly dispatchId?: string;
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
  readonly screenShareMode: boolean;
  readonly activeTabUrl?: string;
  readonly currentTab?: TrackedThread;
  readonly threads: readonly TrackedThread[];
  readonly workstreams: readonly WorkstreamNode[];
  readonly queueItems: readonly QueueItem[];
  readonly reminders: readonly InboundReminder[];
  readonly selectorHealth: readonly SelectorHealth[];
  readonly collapsedSections: readonly WorkboardSection['id'][];
  readonly collapsedBuckets: readonly AllThreadsBucket[];
  readonly codingSessions: readonly CodingSession[];
  readonly captureNotes: readonly CaptureNote[];
  readonly recentDispatches: readonly DispatchEventRecord[];
  // Map of dispatchId → linked destination threadId. Populated by
  // the auto-link matcher in src/companion/dispatchLinking.ts when a
  // freshly captured thread's first user turn matches a recent
  // dispatch's body prefix. Lives in chrome.storage; not part of the
  // companion vault schema.
  readonly dispatchLinks: Readonly<Partial<Record<string, string>>>;
  // Map of dispatchId → unredacted body (the body the user copied).
  // Local-only; the companion stores the redacted form. Used by the
  // auto-link matcher and surfaced to the dispatch viewer modal so
  // the user can see what they actually shipped, not the vault copy.
  readonly dispatchOriginals: Readonly<Partial<Record<string, string>>>;
  readonly dispatchDiagnostics: readonly DispatchDiagnostic[];
  // Map threadId → SendToTarget id of the last dispatch the user
  // fired against that thread. Drives the "Recent" row in the
  // SendToDropdown so a repeat send is one click.
  readonly lastDispatchTargetByThread: Readonly<Partial<Record<string, string>>>;
  // Per-thread inline-review drafts staged by the user via on-page
  // selection in the chat tab. Drives the "Review draft (N)" chip on
  // the thread row; cleared when the user sends-as-follow-up, saves
  // to vault, or discards.
  readonly reviewDrafts: Readonly<Partial<Record<string, ReviewDraft>>>;
  // Number of review-draft mutations queued for the companion that
  // haven't drained yet. Drives the "n unsynced" pill so the user
  // sees when a comment they made is still local-only.
  readonly queuedReviewDraftCount: number;
  readonly droppedReviewDraftCount: number;
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
  screenShareMode = false,
): string => {
  const workstream = workstreams.find(
    (candidate) => candidate.bac_id === thread.primaryWorkstreamId,
  );
  return workstream?.privacy === 'private' ||
    (screenShareMode && workstream?.screenShareSensitive === true)
    ? '[private]'
    : thread.title;
};

export const defaultSettings: UiSettings = {
  companion: {
    port: 17_373,
    bridgeKey: '',
  },
  // Default = manual per spec. Known-provider captures still land in
  // Open threads, but the user owns the choice to keep tracking them.
  // Toggle on in Settings to auto-track every detected AI thread.
  autoTrack: false,
  siteToggles: {
    chatgpt: true,
    claude: true,
    gemini: true,
    codex: true,
  },
  notifyOnQueueComplete: true,
};

export const createEmptyWorkboardState = (
  overrides: Partial<WorkboardState> = {},
): WorkboardState => ({
  companionStatus: 'disconnected',
  queuedCaptureCount: 0,
  droppedCaptureCount: 0,
  settings: defaultSettings,
  screenShareMode: false,
  threads: [],
  workstreams: [],
  queueItems: [],
  reminders: [],
  selectorHealth: [],
  collapsedSections: [],
  collapsedBuckets: ['stale'],
  codingSessions: [],
  captureNotes: [],
  recentDispatches: [],
  dispatchLinks: {},
  dispatchOriginals: {},
  dispatchDiagnostics: [],
  lastDispatchTargetByThread: {},
  reviewDrafts: {},
  queuedReviewDraftCount: 0,
  droppedReviewDraftCount: 0,
  updatedAt: new Date().toISOString(),
  ...overrides,
});

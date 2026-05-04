export type ProviderId = 'chatgpt' | 'claude' | 'gemini' | 'codex' | 'unknown';
export type SelectorCanary = 'ok' | 'warning' | 'failed';

export interface CompanionSettings {
  readonly port: number;
  readonly bridgeKey: string;
}

export interface CapturedTurn {
  readonly role: 'user' | 'assistant' | 'system' | 'unknown';
  readonly text: string;
  readonly formattedText?: string;
  readonly ordinal: number;
  readonly capturedAt: string;
  readonly sourceSelector?: string;
}

export interface CaptureWarning {
  readonly code:
    | 'possible_api_key'
    | 'email'
    | 'internal_url'
    | 'long_capture'
    | 'unsupported_provider';
  readonly message: string;
  readonly severity: 'info' | 'warning';
}

export interface TabSnapshot {
  readonly tabId?: number;
  readonly windowId?: number;
  readonly url: string;
  readonly title: string;
  readonly favIconUrl?: string;
  readonly capturedAt: string;
}

export interface CaptureEvent {
  readonly provider: ProviderId;
  readonly threadId?: string;
  readonly threadUrl: string;
  readonly title?: string;
  readonly capturedAt: string;
  readonly selectorCanary?: SelectorCanary;
  readonly extractionConfigVersion?: string;
  readonly visibleTextCharCount?: number;
  readonly warnings?: readonly CaptureWarning[];
  readonly tabSnapshot?: TabSnapshot;
  readonly turns: readonly CapturedTurn[];
  // Provider-side hint that this thread was branched / forked from a
  // previously-tracked one. The background resolves these to a
  // parentThreadId by URL match (preferred) or title match (fallback).
  readonly forkedFromUrl?: string;
  readonly forkedFromTitle?: string;
  // Active model the user picked in the chat UI when this snapshot was
  // captured (e.g. "Thinking", "GPT-5.1 Pro", "Sonnet 4.6"). Best-
  // effort string scraped from the provider's model picker — used
  // only for display in the dispatch confirm header so the user sees
  // which model their context came from. Never used for routing.
  readonly selectedModel?: string;
}

export interface ThreadUpsert {
  readonly bac_id?: string;
  readonly provider: ProviderId;
  readonly threadId?: string;
  readonly threadUrl: string;
  readonly title: string;
  readonly lastSeenAt: string;
  readonly status?:
    | 'active'
    | 'tracked'
    | 'queued'
    | 'needs_organize'
    | 'closed'
    | 'restorable'
    | 'archived'
    | 'removed';
  readonly primaryWorkstreamId?: string;
  readonly tags?: readonly string[];
  readonly trackingMode?: 'auto' | 'manual' | 'stopped' | 'removed' | 'archived';
  readonly tabSnapshot?: TabSnapshot;
  readonly parentThreadId?: string;
  readonly parentTitle?: string;
  readonly lastTurnRole?: 'user' | 'assistant' | 'system' | 'unknown';
  readonly selectedModel?: string;
}

export interface CaptureNoteCreate {
  readonly text: string;
  readonly kind?: 'manual' | 'obsidian' | 'external';
  readonly workstreamId?: string;
  // When set, the note attaches to a specific thread and renders
  // inline as part of that thread's history.
  readonly threadId?: string;
  readonly source?: string;
}

export interface CaptureNoteUpdate {
  readonly text?: string;
  readonly workstreamId?: string;
}

export interface WorkstreamCreate {
  readonly title: string;
  readonly parentId?: string;
  readonly privacy?: 'private' | 'shared' | 'public';
  readonly screenShareSensitive?: boolean;
  readonly tags?: readonly string[];
}

export interface ChecklistItem {
  readonly id: string;
  readonly text: string;
  readonly checked: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkstreamUpdate {
  readonly revision: string;
  readonly title?: string;
  readonly parentId?: string;
  readonly privacy?: 'private' | 'shared' | 'public';
  readonly screenShareSensitive?: boolean;
  readonly tags?: readonly string[];
  readonly children?: readonly string[];
  readonly checklist?: readonly ChecklistItem[];
}

export interface QueueCreate {
  readonly text: string;
  readonly scope: 'thread' | 'workstream' | 'global';
  readonly targetId?: string;
  readonly status?: 'pending' | 'done' | 'dismissed';
}

export interface QueueUpdate {
  readonly status?: 'pending' | 'done' | 'dismissed';
  readonly text?: string;
  // Pass null to clear; pass a string to set; omit to leave unchanged.
  readonly lastError?: string | null;
  // Pass null to clear; pass a value to set; omit to leave unchanged.
  readonly progress?: 'typing' | 'waiting' | null;
}

export interface CodingAttachTokenCreate {
  readonly workstreamId?: string;
}

export interface CodingAttachTokenRecord {
  readonly token: string;
  readonly workstreamId?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface CodingSessionListQuery {
  readonly token?: string;
  readonly workstreamId?: string;
}

export interface ReminderCreate {
  readonly threadId: string;
  readonly provider: ProviderId;
  readonly detectedAt: string;
  readonly status?: 'new' | 'seen' | 'relevant' | 'dismissed';
}

export interface ReminderUpdate {
  readonly revision?: string;
  readonly status?: 'new' | 'seen' | 'relevant' | 'dismissed';
}

export interface CompanionStatus {
  readonly companion: 'running';
  readonly vault: 'connected' | 'unreachable';
  readonly requestId: string;
}

export interface MutationResult {
  readonly bac_id: string;
  readonly revision: string;
  readonly requestId: string;
}

export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly correlationId: string;
  readonly detail?: string;
}

export type ProviderId = 'chatgpt' | 'claude' | 'gemini' | 'codex' | 'unknown';
export type SelectorCanary = 'ok' | 'warning' | 'failed';

export interface CompanionSettings {
  readonly port: number;
  readonly bridgeKey: string;
}

export interface CapturedAttachment {
  // 'image' = inline / response image, 'upload' = attachment the user
  // dropped into the composer, 'artifact' = Claude artifact, 'tool'
  // = code-interpreter / tool output. We capture the URL only — the
  // bytes stay with the provider unless a future phase elects to
  // mirror them into the vault.
  readonly kind: 'image' | 'upload' | 'artifact' | 'tool';
  readonly url?: string;
  readonly alt?: string;
  readonly mimeType?: string;
}

export interface CapturedCitation {
  // Per-citation surface scraped from the response. Source is the
  // raw text label the provider shows (e.g. "janestreet.com+1");
  // url is the destination if we can resolve it from a wrapping
  // anchor.
  readonly source: string;
  readonly url?: string;
}

export interface CapturedResearchReport {
  // Marker for an enhanced response — Deep Research (ChatGPT) or the
  // Gemini Deep Research output. `mode` is the provider's own name
  // for this surface; `citations` are the inline reference pills.
  // Sections are optional and only populated when the response had
  // recognizable structural headings.
  readonly mode: 'deep-research' | 'gemini-deep-research' | 'unknown';
  readonly citations?: readonly CapturedCitation[];
  readonly sections?: readonly string[];
}

export interface CapturedTurn {
  readonly role: 'user' | 'assistant' | 'system' | 'unknown';
  // Plain-text body (existing field). Stripped of markdown markers
  // so recall index search continues to work against natural language.
  readonly text: string;
  // Pre-existing optional formatted form; kept for back-compat.
  readonly formattedText?: string;
  readonly ordinal: number;
  readonly capturedAt: string;
  readonly sourceSelector?: string;
  // Phase-1: which model generated THIS turn. For user turns the
  // model is the one selected in the picker AT submit time (best
  // effort — providers don't always expose it). For assistant turns
  // it's the model that produced the response (or the picker label
  // when no per-turn signal is available).
  readonly modelName?: string;
  // Phase-2: GFM markdown converted from the rendered DOM. Preserves
  // headers, lists, code blocks, links, blockquotes — what the
  // user actually sees rather than the flattened text body. Stored
  // alongside `text` so callers can pick depending on need.
  readonly markdown?: string;
  // Phase-3: reasoning / thinking trace if the provider exposes one
  // (Gemini "Show thinking" prefix; Claude reasoning toggle; OpenAI
  // o-series thoughts when revealed). Not concatenated into `text`
  // so recall search stays focused on the user-facing answer.
  readonly reasoning?: string;
  // Phase-4: attachments + response images.
  readonly attachments?: readonly CapturedAttachment[];
  // Phase-5: research report metadata (Deep Research, etc.).
  readonly researchReport?: CapturedResearchReport;
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
  // Mode of the most recent assistant turn that carried a research
  // surface (Deep Research on ChatGPT, Gemini Deep Research). Bubbled
  // up from the per-turn `researchReport.mode` enrichment so the
  // tracked-thread record + md sidecar can render the active mode
  // without re-walking captured turns.
  readonly lastResearchMode?: 'deep-research' | 'gemini-deep-research' | 'unknown';
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
  // Free-form description the user can curate; flows through to the
  // companion's suggester via buildSignals (lexical match against
  // thread tokens + cold-start centroid embedding). Useful for
  // cross-language hints — e.g. add `"travel hotel hiking 旅游 旅行"`
  // so a Chinese thread gets matched into the english-named ws.
  readonly description?: string;
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
  readonly description?: string;
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
  // Optional dedup key — see InboundReminder.lastAssistantTurnOrdinal.
  // The local-only path uses this to skip duplicate reminders when
  // re-captures replay an already-seen assistant turn.
  readonly lastAssistantTurnOrdinal?: number;
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

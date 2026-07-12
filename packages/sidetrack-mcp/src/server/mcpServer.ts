import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type {
  CodingSessionRecord,
  DispatchReadOptions,
  DispatchReadResult,
  LiveVaultSnapshot,
  ReviewReadOptions,
  ReviewReadResult,
  TurnsReadOptions,
  TurnsReadResult,
} from '../vault/liveVaultReader.js';
import { searchIndex } from '../vault/searchIndex.js';
import { registerAnnotationTools } from './annotationTools.js';
import type { ContextPackAuditSink } from './contextPackAudit.js';
import { registerDispatchTools } from './dispatchTools.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerSessionTools } from './sessionTools.js';

export type RequestDispatchTargetProvider = 'chatgpt' | 'claude' | 'gemini';
export type RequestDispatchMode = 'paste' | 'auto-send';

export interface SerializedAnchor {
  readonly textQuote: {
    readonly exact: string;
    readonly prefix: string;
    readonly suffix: string;
  };
  readonly textPosition: {
    readonly start: number;
    readonly end: number;
  };
  readonly cssSelector: string;
}

export interface CodingSessionRegisterResult {
  readonly bac_id: string;
  readonly workstreamId?: string | undefined;
  readonly tool?: 'claude_code' | 'codex' | 'cursor' | 'other' | undefined;
  readonly cwd?: string | undefined;
  readonly branch?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly name?: string | undefined;
  readonly resumeCommand?: string | undefined;
  readonly attachedAt?: string | undefined;
  readonly lastSeenAt?: string | undefined;
  readonly status?: 'attached' | 'detached' | undefined;
}

export interface CompanionWriteClient {
  readonly registerCodingSession: (input: {
    readonly token: string;
    readonly tool: 'claude_code' | 'codex' | 'cursor' | 'other';
    readonly cwd: string;
    readonly branch: string;
    readonly sessionId: string;
    readonly name: string;
    readonly resumeCommand?: string;
  }) => Promise<CodingSessionRegisterResult>;
  readonly requestDispatch?: (input: {
    readonly codingSessionId: string;
    readonly targetProvider: RequestDispatchTargetProvider;
    readonly title: string;
    readonly body: string;
    readonly mode: RequestDispatchMode;
    readonly workstreamId?: string;
    readonly sourceThreadId?: string;
  }) => Promise<{
    readonly dispatchId: string;
    readonly approval: 'auto-approved';
    readonly status: string;
    readonly requestedAt: string;
  }>;
  // Move a tracked thread into a workstream (or out of any workstream
  // when workstreamId is omitted). Maps to POST /v1/threads (upsert
  // with primaryWorkstreamId set/cleared).
  readonly moveThread?: (input: {
    readonly threadId: string;
    readonly workstreamId?: string;
  }) => Promise<{ readonly bac_id: string; readonly revision: string }>;
  // Park a follow-up question. Scope = thread/workstream/global; targetId
  // identifies the thread or workstream when scope != global. Maps to
  // POST /v1/queue.
  readonly createQueueItem?: (input: {
    readonly text: string;
    readonly scope: 'thread' | 'workstream' | 'global';
    readonly targetId?: string;
  }) => Promise<{ readonly bac_id: string; readonly revision: string }>;
  // Term-form annotation create. The agent provides intent
  // (term + optional selectionHint) and the companion builds the
  // anchor from the thread's stored turn text, mirroring how the
  // in-DOM extension paths already work and avoiding markdown↔DOM
  // offset divergence on the read side.
  //
  // Contract (post-PR-92-review):
  //   - threadId-first. url/pageTitle are optional shortcuts the
  //     companion fills in from the thread record.
  //   - Returns a structured result: created → annotationId, anchor
  //     failures → reason + suggestedSelectionHints. Per-batch retry
  //     logic lives in the create_batch tool.
  readonly createAnnotation?: (input: {
    readonly term: string;
    readonly note: string;
    readonly threadId?: string;
    readonly url?: string;
    readonly pageTitle?: string;
    readonly selectionHint?: string;
    readonly sourceTurn?: 'assistant_latest' | 'assistant_all' | { readonly ordinal: number };
    readonly anchorPolicy?: {
      readonly repeatedTerm?: 'first' | 'require_hint';
      readonly shortTermMinLength?: number;
    };
  }) => Promise<
    | {
        readonly status: 'created';
        readonly annotationId: string;
        readonly occurrenceCount: number;
        readonly annotation: Record<string, unknown>;
        readonly totalForUrl?: number;
      }
    | {
        readonly status: 'anchor_failed' | 'validation_failed';
        readonly reason:
          | 'term_not_found'
          | 'short_term_requires_selection_hint'
          | 'ambiguous_term_requires_selection_hint'
          | 'invalid_ordinal'
          | 'selection_hint_no_match'
          | 'thread_not_found'
          | 'thread_url_unresolved'
          | 'no_assistant_turns';
        readonly message: string;
        readonly occurrenceCount: number;
        readonly suggestedSelectionHints?: readonly string[];
      }
  >;
  readonly updateAnnotation?: (input: {
    readonly bac_id: string;
    readonly note: string;
  }) => Promise<Record<string, unknown>>;
  readonly deleteAnnotation?: (input: {
    readonly bac_id: string;
  }) => Promise<Record<string, unknown>>;
  readonly bumpWorkstream?: (input: {
    readonly bac_id: string;
  }) => Promise<{ readonly bac_id: string; readonly revision: string }>;
  readonly archiveThread?: (input: {
    readonly bac_id: string;
  }) => Promise<{ readonly bac_id: string; readonly revision: string }>;
  readonly unarchiveThread?: (input: {
    readonly bac_id: string;
  }) => Promise<{ readonly bac_id: string; readonly revision: string }>;
  // F32 — create a workstream (new_cluster). parentId nests it; kind is a
  // free-form label persisted as a tag hint. Routed through the same
  // trust+audit path as the other write tools.
  readonly createWorkstream?: (input: {
    readonly title: string;
    readonly parentId?: string;
    readonly kind?: string;
  }) => Promise<{ readonly bac_id: string; readonly revision: string }>;
  readonly listDispatches?: (input: {
    readonly limit?: number;
    readonly since?: string;
  }) => Promise<readonly unknown[]>;
  readonly listAuditEvents?: (input: {
    readonly limit?: number;
    readonly since?: string;
  }) => Promise<readonly unknown[]>;
  readonly listWorkstreamNotes?: (input: {
    readonly workstreamId: string;
  }) => Promise<readonly unknown[]>;
  readonly listAnnotations?: (input: {
    readonly url?: string;
    readonly limit?: number;
  }) => Promise<readonly unknown[]>;
  readonly readThreadMarkdown?: (input: {
    readonly bac_id: string;
  }) => Promise<Record<string, unknown>>;
  readonly readWorkstreamMarkdown?: (input: {
    readonly bac_id: string;
  }) => Promise<Record<string, unknown>>;
  readonly listBuckets?: () => Promise<readonly unknown[]>;
  readonly systemHealth?: () => Promise<Record<string, unknown>>;
  readonly recall?: (input: {
    readonly query: string;
    readonly limit?: number;
    readonly workstreamId?: string;
  }) => Promise<readonly unknown[]>;
  readonly suggestWorkstream?: (input: {
    readonly threadId: string;
    readonly limit?: number;
  }) => Promise<readonly unknown[]>;
  readonly exportSettings?: () => Promise<Record<string, unknown>>;
  readonly systemUpdateCheck?: () => Promise<Record<string, unknown>>;
  // Phase 3 dispatch correlation. Long-poll on the companion's
  // `GET /v1/dispatches/:bacId/await-capture` endpoint; resolves
  // when the link table has a record, or returns matched=false when
  // the timeout expires.
  //
  // P0-review update (Phase-5 follow-up): the companion now returns
  // a structured `thread` block, a `resources` URI map, and the
  // latest assistant turn so the agent can stop polling /v1/turns
  // after capture.
  readonly awaitCaptureForDispatch?: (input: {
    readonly dispatchId: string;
    readonly timeoutMs?: number;
    readonly includeLatestAssistantTurn?: boolean;
  }) => Promise<{
    readonly dispatchId: string;
    readonly matched: boolean;
    readonly linkedAt?: string;
    readonly thread?: {
      readonly threadId: string;
      readonly threadUrl?: string;
      readonly title?: string;
      readonly provider?: 'chatgpt' | 'claude' | 'gemini';
    };
    readonly resources?: {
      readonly dispatch: string;
      readonly thread: string;
      readonly turns: string;
      readonly markdown: string;
      readonly annotations: string;
    };
    readonly latestAssistantTurn?: {
      readonly ordinal: number;
      readonly text: string;
      readonly capturedAt: string;
    };
    readonly reason?: 'matched' | 'timeout';
  }>;
}

export interface SidetrackMcpReader {
  readonly readSnapshot: () => Promise<LiveVaultSnapshot>;
  readonly readCodingSessions: (options?: {
    readonly workstreamId?: string;
    readonly status?: 'attached' | 'detached';
  }) => Promise<readonly CodingSessionRecord[]>;
  readonly readDispatches: (options?: DispatchReadOptions) => Promise<DispatchReadResult>;
  readonly readReviews: (options?: ReviewReadOptions) => Promise<ReviewReadResult>;
  readonly readTurns: (options: TurnsReadOptions) => Promise<TurnsReadResult>;
  // Companion-projected Connections graph snapshot. Returns null
  // when the materializer hasn't run (no `_BAC/connections/current.json`
  // file yet); the connections tools surface that as
  // `note: 'No connections snapshot yet — the materializer has not run.'`.
  // Optional so older reader stubs (e.g. test fixtures) keep
  // working — when omitted, connections tools behave as if there's
  // no snapshot.
  readonly readConnectionsSnapshot?: () => Promise<unknown | null>;
}

const toolText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const asStructuredContent = (value: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: toolText(value) }],
  structuredContent: value,
});

const buildContextPack = (
  snapshot: LiveVaultSnapshot,
  workstreamId: string | undefined,
  includeQueueItems: boolean,
): string => {
  const workstreams =
    workstreamId === undefined
      ? snapshot.workstreams
      : snapshot.workstreams.filter((workstream) => workstream.bac_id === workstreamId);
  const threads = snapshot.threads.filter(
    (thread) => workstreamId === undefined || thread.primaryWorkstreamId === workstreamId,
  );
  const queueItems = includeQueueItems
    ? snapshot.queueItems.filter(
        (item) => workstreamId === undefined || item.targetId === workstreamId,
      )
    : [];
  const threadLines = threads.map(
    (thread) => `- ${thread.title ?? thread.threadUrl ?? thread.bac_id}`,
  );
  const queueLines = queueItems.map((item) => `- ${item.text ?? item.bac_id}`);
  const checklistLines = workstreams.flatMap((workstream) =>
    (workstream.checklist ?? []).map((item, index) => {
      const record =
        typeof item === 'object' && item !== null
          ? (item as { readonly text?: unknown; readonly checked?: unknown })
          : {};
      const marker = record.checked === true ? 'x' : ' ';
      const text =
        typeof record.text === 'string' ? record.text : `Checklist item ${String(index + 1)}`;
      return `- [${marker}] ${text}`;
    }),
  );

  return [
    '# Sidetrack Context Pack',
    '',
    '## Workstreams',
    ...workstreams.map((workstream) => `- ${workstream.title ?? workstream.bac_id}`),
    '',
    '## Checklist',
    ...checklistLines,
    '',
    '## Threads',
    ...threadLines,
    '',
    '## Queued Asks',
    ...queueLines,
    '',
    `Generated at ${snapshot.generatedAt}`,
  ].join('\n');
};

export interface SidetrackMcpServerOptions {
  // PRD §15 criterion 5. When set, each context_pack call appends an
  // audit line (tool=sidetrack.workstreams.context_pack) to the vault's
  // _BAC/audit log so the freeze-lift counter can observe it. Best-effort:
  // the tool never fails on an audit-write error. Omitted for stdio/test
  // wiring that has no vault-write surface. FREEZE-SAFE (ADR-0011):
  // observability only — no serving consumer reads this line.
  readonly contextPackAuditSink?: ContextPackAuditSink;
}

export const createSidetrackMcpServer = (
  reader: SidetrackMcpReader,
  companionClient?: CompanionWriteClient,
  options: SidetrackMcpServerOptions = {},
): McpServer => {
  const server = new McpServer({
    name: 'sidetrack-mcp',
    version: '0.0.0',
  });

  // Typed dispatch tool surface — registered first so it shows ahead
  // of the legacy bac.* equivalents in tools/list. The legacy entries
  // remain registered through this commit for compatibility; later
  // sub-commits in Phase 1 delete bac.request_dispatch.
  registerDispatchTools(server, reader, companionClient);
  registerSessionTools(server, companionClient);
  registerAnnotationTools(server, companionClient);
  registerResources(server, reader, companionClient);
  registerPrompts(server);

  server.registerTool(
    'sidetrack.threads.list',
    {
      description: 'Return tracked threads sorted by lastSeenAt from the live Sidetrack vault.',
      inputSchema: { limit: z.number().int().positive().optional() },
    },
    async ({ limit }) => {
      const snapshot = await reader.readSnapshot();
      return asStructuredContent({
        threads: limit === undefined ? snapshot.threads : snapshot.threads.slice(0, limit),
        generatedAt: snapshot.generatedAt,
      });
    },
  );

  server.registerTool(
    'sidetrack.workstreams.get',
    {
      description:
        'Return a workstream subtree plus tracked items, queued asks, and checklist data.',
      inputSchema: { id: z.string().optional() },
    },
    async ({ id }) => {
      const snapshot = await reader.readSnapshot();
      const workstreams =
        id === undefined
          ? snapshot.workstreams
          : snapshot.workstreams.filter((workstream) => workstream.bac_id === id);
      return asStructuredContent({
        workstreams,
        threads: snapshot.threads.filter(
          (thread) => id === undefined || thread.primaryWorkstreamId === id,
        ),
        queuedItems: snapshot.queueItems.filter((item) => id === undefined || item.targetId === id),
        generatedAt: snapshot.generatedAt,
      });
    },
  );

  server.registerTool(
    'sidetrack.workstreams.context_pack',
    {
      description: 'Return a minimal Markdown Context Pack for the selected workstream.',
      inputSchema: {
        workstreamId: z.string().optional(),
        includeQueueItems: z.boolean().optional(),
      },
    },
    async ({ workstreamId, includeQueueItems }) => {
      const snapshot = await reader.readSnapshot();
      const markdown = buildContextPack(snapshot, workstreamId, includeQueueItems ?? true);
      // PRD §15 criterion 5 emit site. A context_pack is a pure read, so
      // it writes nothing to the vault on its own — this is the one place
      // it leaves an observable trace for the freeze-lift counter. Fully
      // best-effort: an audit-write failure must never fail the read.
      if (options.contextPackAuditSink !== undefined) {
        await options
          .contextPackAuditSink({ workstreamId: workstreamId ?? null })
          .catch(() => undefined);
      }
      return {
        content: [{ type: 'text' as const, text: markdown }],
        structuredContent: { pack: { markdown, generatedAt: snapshot.generatedAt } },
      };
    },
  );

  server.registerTool(
    'sidetrack.search',
    {
      description: 'Run lexical search over tracked items, queued asks, and reminders.',
      inputSchema: { query: z.string().min(1) },
    },
    async ({ query }) => {
      const snapshot = await reader.readSnapshot();
      return asStructuredContent({
        hits: searchIndex(snapshot, query),
        generatedAt: snapshot.generatedAt,
      });
    },
  );

  server.registerTool(
    'sidetrack.queue.list',
    {
      description: 'Return queued follow-ups from the live vault.',
      inputSchema: { scope: z.string().optional() },
    },
    async ({ scope }) => {
      const snapshot = await reader.readSnapshot();
      return asStructuredContent({
        queuedItems:
          scope === undefined
            ? snapshot.queueItems
            : snapshot.queueItems.filter((item) => item.scope === scope),
        generatedAt: snapshot.generatedAt,
      });
    },
  );

  server.registerTool(
    'sidetrack.reminders.list',
    {
      description: 'Return inbound reminders from the live vault.',
      inputSchema: { since: z.string().optional() },
    },
    async ({ since }) => {
      const snapshot = await reader.readSnapshot();
      return asStructuredContent({
        reminders:
          since === undefined
            ? snapshot.reminders
            : snapshot.reminders.filter((reminder) => (reminder.detectedAt ?? '') >= since),
        generatedAt: snapshot.generatedAt,
      });
    },
  );

  server.registerTool(
    'sidetrack.sessions.list',
    {
      description:
        'Return coding sessions registered by coding agents (Claude Code / Codex / Cursor). Filterable by workstreamId and status.',
      inputSchema: {
        workstreamId: z.string().optional(),
        status: z.enum(['attached', 'detached']).optional(),
      },
    },
    async ({ workstreamId, status }) => {
      const sessions = await reader.readCodingSessions({
        ...(workstreamId === undefined ? {} : { workstreamId }),
        ...(status === undefined ? {} : { status }),
      });
      return asStructuredContent({
        codingSessions: sessions,
        generatedAt: new Date().toISOString(),
      });
    },
  );

  // Note: the legacy `bac.coding_session_register` and `bac.request_dispatch`
  // tool registrations were deleted in Phase 1.4a of the spec-alignment
  // refactor. Their typed replacements `sidetrack.session.attach` and
  // `sidetrack.dispatch.{create,await_capture}` are registered above by
  // registerSessionTools / registerDispatchTools.

  // Write tools — let an attached coding agent move a thread into a
  // workstream and park a follow-up question. Both wrap existing
  // companion endpoints (POST /v1/threads upsert with
  // primaryWorkstreamId, POST /v1/queue), so no new schema lands here.
  // The companion enforces auth via x-bac-bridge-key; per-workstream
  // trust UI is intentionally deferred.
  server.registerTool(
    'sidetrack.threads.move',
    {
      description:
        'Move a tracked thread into a workstream. Pass workstreamId="" (empty string) to clear the assignment and park the thread back at the top level. Returns the updated thread bac_id + revision.',
      inputSchema: {
        threadId: z.string().min(1).describe('bac_id of the thread to move.'),
        workstreamId: z
          .string()
          .optional()
          .describe('Target workstream bac_id; omit or pass empty to clear.'),
      },
    },
    async ({ threadId, workstreamId }) => {
      if (companionClient?.moveThread === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; sidetrack.threads.move is unavailable.',
        );
      }
      const target =
        workstreamId === undefined || workstreamId.length === 0 ? undefined : workstreamId;
      const result = await companionClient.moveThread({
        threadId,
        ...(target === undefined ? {} : { workstreamId: target }),
      });
      return asStructuredContent({
        bac_id: result.bac_id,
        revision: result.revision,
        movedAt: new Date().toISOString(),
      });
    },
  );

  server.registerTool(
    'sidetrack.queue.create',
    {
      description:
        "Park a follow-up question for the user. Scope determines where it lands: 'thread' (set targetId to a thread bac_id), 'workstream' (set targetId to a workstream bac_id), or 'global' (no target). Returns the queue item bac_id.",
      inputSchema: {
        text: z.string().min(1).max(2000).describe('The follow-up question text.'),
        scope: z
          .enum(['thread', 'workstream', 'global'])
          .describe("Where the item lives. 'global' means no target."),
        targetId: z
          .string()
          .optional()
          .describe(
            "Thread or workstream bac_id; required when scope != 'global', ignored otherwise.",
          ),
      },
    },
    async ({ text, scope, targetId }) => {
      if (companionClient?.createQueueItem === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; sidetrack.queue.create is unavailable.',
        );
      }
      if (scope !== 'global' && (targetId === undefined || targetId.length === 0)) {
        throw new Error(
          `sidetrack.queue.create requires targetId when scope='${scope}'. Pass the thread or workstream bac_id, or use scope='global'.`,
        );
      }
      const result = await companionClient.createQueueItem({
        text,
        scope,
        ...(scope === 'global' || targetId === undefined ? {} : { targetId }),
      });
      return asStructuredContent({
        bac_id: result.bac_id,
        revision: result.revision,
        queuedAt: new Date().toISOString(),
      });
    },
  );

  server.registerTool(
    'sidetrack.workstreams.bump',
    {
      description: 'Mark a workstream as recently active by updating lastBumpedAt.',
      inputSchema: { bac_id: z.string().min(1) },
    },
    async ({ bac_id }) => {
      if (companionClient?.bumpWorkstream === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; sidetrack.workstreams.bump is unavailable.',
        );
      }
      return asStructuredContent(await companionClient.bumpWorkstream({ bac_id }));
    },
  );

  // F32 new_cluster — create a workstream. Nests under parentId when
  // given (the companion trust-gates a child create on the parent).
  // link_items is deferred per the 2026-07-11 PRD amendment.
  server.registerTool(
    'sidetrack.workstreams.create',
    {
      description:
        'Create a new workstream (cluster) to group related threads. Pass parentId to nest it under an existing workstream, else it lands at the top level. kind is an optional free-form label (e.g. "project", "topic"). Returns the new workstream bac_id + revision.',
      inputSchema: {
        title: z.string().min(1).describe('Human-readable workstream title.'),
        parentId: z
          .string()
          .min(1)
          .optional()
          .describe('Parent workstream bac_id to nest under; omit for a top-level workstream.'),
        kind: z
          .string()
          .min(1)
          .optional()
          .describe('Optional free-form category label for the workstream.'),
      },
    },
    async ({ title, parentId, kind }) => {
      if (companionClient?.createWorkstream === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; sidetrack.workstreams.create is unavailable.',
        );
      }
      const result = await companionClient.createWorkstream({
        title,
        ...(parentId === undefined ? {} : { parentId }),
        ...(kind === undefined ? {} : { kind }),
      });
      return asStructuredContent({
        bac_id: result.bac_id,
        revision: result.revision,
        createdAt: new Date().toISOString(),
      });
    },
  );

  server.registerTool(
    'sidetrack.threads.archive',
    {
      description: 'Soft-archive a tracked thread. Idempotent.',
      inputSchema: { bac_id: z.string().min(1) },
    },
    async ({ bac_id }) => {
      if (companionClient?.archiveThread === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; sidetrack.threads.archive is unavailable.',
        );
      }
      return asStructuredContent(await companionClient.archiveThread({ bac_id }));
    },
  );

  server.registerTool(
    'sidetrack.threads.unarchive',
    {
      description: 'Clear a thread soft-archive marker. Idempotent.',
      inputSchema: { bac_id: z.string().min(1) },
    },
    async ({ bac_id }) => {
      if (companionClient?.unarchiveThread === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; sidetrack.threads.unarchive is unavailable.',
        );
      }
      return asStructuredContent(await companionClient.unarchiveThread({ bac_id }));
    },
  );

  // bac.list_dispatches deleted in Phase 1.4: it duplicated the
  // vault-reader-backed sidetrack.dispatches.list (registered below).
  // The HTTP-shim version offered nothing beyond what the local vault
  // reader already provides.

  server.registerTool(
    'sidetrack.audit.list',
    {
      description: 'Return recent companion audit events through the companion API.',
      inputSchema: {
        limit: z.number().int().positive().max(100).optional(),
        since: z.iso.datetime().optional(),
      },
    },
    async ({ limit, since }) => {
      if (companionClient?.listAuditEvents === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; sidetrack.audit.list is unavailable.',
        );
      }
      const data = await companionClient.listAuditEvents({
        ...(limit === undefined ? {} : { limit }),
        ...(since === undefined ? {} : { since }),
      });
      return asStructuredContent({ data: [...data] });
    },
  );

  server.registerTool(
    'sidetrack.workstreams.notes',
    {
      description: 'Return human-authored markdown notes whose frontmatter links to a workstream.',
      inputSchema: {
        workstreamId: z.string().min(1),
      },
    },
    async ({ workstreamId }) => {
      if (companionClient?.listWorkstreamNotes === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; sidetrack.workstreams.notes is unavailable.',
        );
      }
      const items = await companionClient.listWorkstreamNotes({ workstreamId });
      return asStructuredContent({ items: [...items] });
    },
  );

  // Note: the legacy `bac.create_annotation` tool registration was
  // deleted in Phase 1.4a. The typed replacement is
  // `sidetrack.annotations.create_batch` (registered above by
  // registerAnnotationTools), which accepts 1..20 items in a single
  // call and surfaces per-item status for partial-failure handling.

  server.registerTool(
    'sidetrack.annotations.list',
    {
      description: 'Return persisted web annotations, optionally filtered by URL.',
      inputSchema: {
        url: z.url().optional(),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    async ({ url, limit }) => {
      if (companionClient?.listAnnotations === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; sidetrack.annotations.list is unavailable.',
        );
      }
      const data = await companionClient.listAnnotations({
        ...(url === undefined ? {} : { url }),
        ...(limit === undefined ? {} : { limit }),
      });
      return asStructuredContent({ data: [...data] });
    },
  );

  server.registerTool(
    'sidetrack.annotations.update',
    {
      description:
        'Update an annotation note while preserving the previous note in revision history.',
      inputSchema: { bac_id: z.string().min(1), note: z.string() },
    },
    async ({ bac_id, note }) => {
      if (companionClient?.updateAnnotation === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; sidetrack.annotations.update is unavailable.',
        );
      }
      return asStructuredContent(await companionClient.updateAnnotation({ bac_id, note }));
    },
  );

  server.registerTool(
    'sidetrack.annotations.delete',
    {
      description: 'Soft-delete an annotation. Idempotent; history is preserved.',
      inputSchema: { bac_id: z.string().min(1) },
    },
    async ({ bac_id }) => {
      if (companionClient?.deleteAnnotation === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; sidetrack.annotations.delete is unavailable.',
        );
      }
      return asStructuredContent(await companionClient.deleteAnnotation({ bac_id }));
    },
  );

  // sidetrack.threads.read_md and sidetrack.workstreams.read_md were
  // deleted in Phase 5: the same content is now exposed as MCP
  // resources at sidetrack://thread/{threadId}/markdown and
  // sidetrack://workstream/{workstreamId}/context. See resources.ts.

  server.registerTool(
    'sidetrack.recall.query',
    {
      description: 'Run companion-backed vector recall over captured turns.',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().positive().max(50).optional(),
        workstreamId: z.string().min(1).optional(),
      },
    },
    async ({ query, limit, workstreamId }) => {
      if (companionClient?.recall === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; sidetrack.recall.query is unavailable.',
        );
      }
      const data = await companionClient.recall({
        query,
        ...(limit === undefined ? {} : { limit }),
        ...(workstreamId === undefined ? {} : { workstreamId }),
      });
      return asStructuredContent({ data: [...data] });
    },
  );

  server.registerTool(
    'sidetrack.suggestions.workstream',
    {
      description: 'Score likely workstreams for a tracked thread without auto-applying.',
      inputSchema: {
        threadId: z.string().min(1),
        limit: z.number().int().positive().max(20).optional(),
      },
    },
    async ({ threadId, limit }) => {
      if (companionClient?.suggestWorkstream === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; sidetrack.suggestions.workstream is unavailable.',
        );
      }
      const data = await companionClient.suggestWorkstream({
        threadId,
        ...(limit === undefined ? {} : { limit }),
      });
      return asStructuredContent({ data: [...data] });
    },
  );

  server.registerTool(
    'sidetrack.settings.export',
    {
      description: 'Export portable Sidetrack settings and workstream metadata.',
      inputSchema: {},
    },
    async () => {
      if (companionClient?.exportSettings === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; sidetrack.settings.export is unavailable.',
        );
      }
      return asStructuredContent(await companionClient.exportSettings());
    },
  );

  server.registerTool(
    'sidetrack.system.update_check',
    {
      description: 'Return read-only companion version update advisory.',
      inputSchema: {},
    },
    async () => {
      if (companionClient?.systemUpdateCheck === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; sidetrack.system.update_check is unavailable.',
        );
      }
      return asStructuredContent(await companionClient.systemUpdateCheck());
    },
  );

  server.registerTool(
    'sidetrack.buckets.list',
    {
      description: 'List companion multi-vault routing buckets. Read-only.',
      inputSchema: {},
    },
    async () => {
      if (companionClient?.listBuckets === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; sidetrack.buckets.list is unavailable.',
        );
      }
      return asStructuredContent({ items: [...(await companionClient.listBuckets())] });
    },
  );

  server.registerTool(
    'sidetrack.system.health',
    {
      description: 'Return best-effort companion health metrics for diagnostics.',
      inputSchema: {},
    },
    async () => {
      if (companionClient?.systemHealth === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; sidetrack.system.health is unavailable.',
        );
      }
      return asStructuredContent(await companionClient.systemHealth());
    },
  );

  // No MCP tools are exposed for auto-update execution, recall GC, or
  // trust-management writes. They mutate local operational policy and require
  // a user-mediated surface rather than agent invocation.

  server.registerTool(
    'sidetrack.dispatches.list',
    {
      description: 'Return recent dispatch events from the live Sidetrack vault dispatch ledger.',
      inputSchema: {
        limit: z.number().int().positive().max(100).optional(),
        since: z.iso.datetime().optional(),
        workstreamId: z.string().optional(),
        provider: z.string().optional(),
      },
    },
    async ({ limit, since, workstreamId, provider }) => {
      const result = await reader.readDispatches({
        ...(limit === undefined ? {} : { limit }),
        ...(since === undefined ? {} : { since }),
        ...(workstreamId === undefined ? {} : { workstreamId }),
        ...(provider === undefined ? {} : { provider }),
      });
      return asStructuredContent({
        data: result.data,
        ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
      });
    },
  );

  server.registerTool(
    'sidetrack.reviews.list',
    {
      description: 'Return recent review events from the live Sidetrack vault review ledger.',
      inputSchema: {
        limit: z.number().int().positive().max(100).optional(),
        since: z.iso.datetime().optional(),
        threadId: z.string().optional(),
        verdict: z.enum(['agree', 'disagree', 'partial', 'needs_source', 'open']).optional(),
      },
    },
    async ({ limit, since, threadId, verdict }) => {
      const result = await reader.readReviews({
        ...(limit === undefined ? {} : { limit }),
        ...(since === undefined ? {} : { since }),
        ...(threadId === undefined ? {} : { threadId }),
        ...(verdict === undefined ? {} : { verdict }),
      });
      return asStructuredContent({
        data: result.data,
        ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
      });
    },
  );

  server.registerTool(
    'sidetrack.threads.turns',
    {
      description:
        'Return the most-recent captured assistant/user turns for a thread, by threadUrl, deduped by ordinal.',
      inputSchema: {
        threadUrl: z.url(),
        limit: z.number().int().positive().max(50).optional(),
        role: z.enum(['user', 'assistant', 'system', 'unknown']).optional(),
      },
    },
    async ({ threadUrl, limit, role }) => {
      const result = await reader.readTurns({
        threadUrl,
        ...(limit === undefined ? {} : { limit }),
        ...(role === undefined ? {} : { role }),
      });
      return asStructuredContent({
        data: result.data,
        ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
      });
    },
  );

  // ---------------------------------------------------------------
  // Connections — read-only evidence-graph queries.
  //
  // The companion's Class B `connections` materializer projects a
  // deterministic graph snapshot at _BAC/connections/current.json.
  // These tools read it directly from the vault. No writes, no
  // recommendations, no LLM inference — they expose the same edges
  // already visible at GET /v1/connections.
  //
  // Local subgraph + path expansion runs in-process here so the
  // tools work offline (vault-only mode); when the materializer
  // hasn't run yet, every tool returns an empty / not-found result
  // honestly.
  // ---------------------------------------------------------------

  // Local helpers — kept simple and isolated to this scope. The
  // companion has the canonical `subgraphForNode` + `findPath`
  // implementations; we mirror them here against the snapshot
  // shape (loose typing because the snapshot is unknown JSON from
  // the vault).
  const readSnapshotOrNull = async (): Promise<{
    nodes: { id: string; [k: string]: unknown }[];
    edges: { id: string; fromNodeId: string; toNodeId: string; [k: string]: unknown }[];
    [k: string]: unknown;
  } | null> => {
    if (reader.readConnectionsSnapshot === undefined) return null;
    const raw = await reader.readConnectionsSnapshot();
    if (raw === null || typeof raw !== 'object') return null;
    const obj = raw as { nodes?: unknown; edges?: unknown };
    if (!Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) return null;
    return raw as never;
  };

  server.registerTool(
    'sidetrack.connections.snapshot',
    {
      description:
        'Return the companion-projected Connections graph snapshot. Read-only; deterministic; no inference.',
      inputSchema: {
        workstreamId: z.string().optional(),
        nodeKind: z.string().optional(),
        edgeKind: z.string().optional(),
      },
    },
    async ({ workstreamId, nodeKind, edgeKind }) => {
      const snap = await readSnapshotOrNull();
      if (snap === null) {
        return asStructuredContent({
          scope: 'companion-extended',
          snapshot: {
            nodes: [],
            edges: [],
            nodeCount: 0,
            edgeCount: 0,
            updatedAt: '1970-01-01T00:00:00.000Z',
            scope: {},
          },
          note: 'No connections snapshot yet — the materializer has not run.',
        });
      }
      let nodes = snap.nodes;
      let edges = snap.edges;
      if (workstreamId !== undefined) {
        const wsId = `workstream:${workstreamId}`;
        const keep = new Set<string>([wsId]);
        for (const n of nodes) {
          const meta = (n as { metadata?: { workstreamId?: string } }).metadata;
          if (meta?.workstreamId === workstreamId) keep.add(n.id);
        }
        for (const e of edges) {
          if (keep.has(e.fromNodeId)) keep.add(e.toNodeId);
          if (keep.has(e.toNodeId)) keep.add(e.fromNodeId);
        }
        nodes = nodes.filter((n) => keep.has(n.id));
        edges = edges.filter((e) => keep.has(e.fromNodeId) && keep.has(e.toNodeId));
      }
      if (nodeKind !== undefined) {
        nodes = nodes.filter((n) => (n as { kind?: string }).kind === nodeKind);
        const kept = new Set(nodes.map((n) => n.id));
        edges = edges.filter((e) => kept.has(e.fromNodeId) && kept.has(e.toNodeId));
      }
      if (edgeKind !== undefined) {
        edges = edges.filter((e) => (e as { kind?: string }).kind === edgeKind);
      }
      return asStructuredContent({
        scope: 'companion-extended',
        snapshot: {
          ...snap,
          nodes,
          edges,
          nodeCount: nodes.length,
          edgeCount: edges.length,
        },
      });
    },
  );

  server.registerTool(
    'sidetrack.connections.neighbors',
    {
      description: 'Return the BFS subgraph around an anchor node (default 1 hop, max 4).',
      inputSchema: {
        nodeId: z.string().min(1),
        hops: z.number().int().min(0).max(4).optional(),
      },
    },
    async ({ nodeId, hops }) => {
      const snap = await readSnapshotOrNull();
      if (snap === null) {
        return asStructuredContent({
          scope: 'companion-extended',
          snapshot: {
            nodes: [],
            edges: [],
            nodeCount: 0,
            edgeCount: 0,
            updatedAt: '1970-01-01T00:00:00.000Z',
            scope: { nodeId, hops: hops ?? 1 },
          },
          note: 'No connections snapshot yet.',
        });
      }
      const limit = Math.min(Math.max(hops ?? 1, 0), 4);
      const visited = new Set<string>([nodeId]);
      let frontier = new Set<string>([nodeId]);
      const keptEdges = new Map<string, (typeof snap.edges)[number]>();
      for (let h = 0; h < limit; h += 1) {
        const next = new Set<string>();
        for (const e of snap.edges) {
          if (frontier.has(e.fromNodeId) && !visited.has(e.toNodeId)) {
            keptEdges.set(e.id, e);
            next.add(e.toNodeId);
          }
          if (frontier.has(e.toNodeId) && !visited.has(e.fromNodeId)) {
            keptEdges.set(e.id, e);
            next.add(e.fromNodeId);
          }
          if (visited.has(e.fromNodeId) && visited.has(e.toNodeId)) {
            keptEdges.set(e.id, e);
          }
        }
        for (const id of next) visited.add(id);
        frontier = next;
        if (frontier.size === 0) break;
      }
      const nodeMap = new Map(snap.nodes.map((n) => [n.id, n] as const));
      const subNodes = [...visited]
        .map((id) => nodeMap.get(id))
        .filter((n): n is NonNullable<typeof n> => n !== undefined)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const subEdges = [...keptEdges.values()].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      );
      return asStructuredContent({
        scope: 'companion-extended',
        snapshot: {
          scope: { nodeId, hops: limit },
          nodes: subNodes,
          edges: subEdges,
          updatedAt: (snap as { updatedAt?: string }).updatedAt ?? '1970-01-01T00:00:00.000Z',
          nodeCount: subNodes.length,
          edgeCount: subEdges.length,
        },
      });
    },
  );

  server.registerTool(
    'sidetrack.connections.edge',
    {
      description: 'Return a single edge with its provenance (which event/store produced it).',
      inputSchema: { edgeId: z.string().min(1) },
    },
    async ({ edgeId }) => {
      const snap = await readSnapshotOrNull();
      if (snap === null) {
        return asStructuredContent({ found: false, reason: 'no-snapshot' });
      }
      const edge = snap.edges.find((e) => e.id === edgeId);
      if (edge === undefined) {
        return asStructuredContent({ found: false, reason: 'edge-not-found' });
      }
      return asStructuredContent({ found: true, edge });
    },
  );

  server.registerTool(
    'sidetrack.connections.find_path',
    {
      description:
        'BFS over undirected edges; returns the first path between two nodes or {found:false}.',
      inputSchema: {
        fromNodeId: z.string().min(1),
        toNodeId: z.string().min(1),
        maxHops: z.number().int().min(1).max(8).optional(),
      },
    },
    async ({ fromNodeId, toNodeId, maxHops }) => {
      const snap = await readSnapshotOrNull();
      if (snap === null) return asStructuredContent({ found: false });
      const limit = Math.min(Math.max(maxHops ?? 4, 1), 8);
      if (fromNodeId === toNodeId) {
        const node = snap.nodes.find((n) => n.id === fromNodeId);
        if (node !== undefined)
          return asStructuredContent({ found: true, nodes: [node], edges: [] });
        return asStructuredContent({ found: false });
      }
      const adjacency = new Map<string, (typeof snap.edges)[number][]>();
      for (const e of snap.edges) {
        const a = adjacency.get(e.fromNodeId) ?? [];
        a.push(e);
        adjacency.set(e.fromNodeId, a);
        const b = adjacency.get(e.toNodeId) ?? [];
        b.push(e);
        adjacency.set(e.toNodeId, b);
      }
      const queue: { id: string; pathNodes: string[]; pathEdges: typeof snap.edges }[] = [
        { id: fromNodeId, pathNodes: [fromNodeId], pathEdges: [] as typeof snap.edges },
      ];
      const visited = new Set<string>([fromNodeId]);
      while (queue.length > 0) {
        const { id, pathNodes, pathEdges } = queue.shift()!;
        if (pathEdges.length >= limit) continue;
        for (const e of adjacency.get(id) ?? []) {
          const other = e.fromNodeId === id ? e.toNodeId : e.fromNodeId;
          if (visited.has(other)) continue;
          visited.add(other);
          const nextNodes = [...pathNodes, other];
          const nextEdges = [...pathEdges, e];
          if (other === toNodeId) {
            const nodeMap = new Map(snap.nodes.map((n) => [n.id, n] as const));
            return asStructuredContent({
              found: true,
              nodes: nextNodes
                .map((nid) => nodeMap.get(nid))
                .filter((n): n is NonNullable<typeof n> => n !== undefined),
              edges: nextEdges,
            });
          }
          queue.push({ id: other, pathNodes: nextNodes, pathEdges: nextEdges });
        }
      }
      return asStructuredContent({ found: false });
    },
  );

  return server;
};

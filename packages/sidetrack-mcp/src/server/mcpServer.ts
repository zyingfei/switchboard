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
  // Term-form annotation create. Phase 4 of the spec-aligned refactor:
  // the agent provides intent (term + optional selectionHint) and the
  // companion builds the anchor from the thread's stored turn text,
  // mirroring how the in-DOM extension paths already work and avoiding
  // markdown↔DOM offset divergence on the read side.
  readonly createAnnotation?: (input: {
    readonly url: string;
    readonly pageTitle: string;
    readonly term: string;
    readonly note: string;
    readonly threadId?: string;
    readonly threadUrl?: string;
    readonly selectionHint?: string;
  }) => Promise<Record<string, unknown>>;
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
  readonly awaitCaptureForDispatch?: (input: {
    readonly dispatchId: string;
    readonly timeoutMs?: number;
  }) => Promise<{
    readonly dispatchId: string;
    readonly matched: boolean;
    readonly threadId?: string;
    readonly threadUrl?: string;
    readonly title?: string;
    readonly provider?: 'chatgpt' | 'claude' | 'gemini';
    readonly linkedAt?: string;
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

export const createSidetrackMcpServer = (
  reader: SidetrackMcpReader,
  companionClient?: CompanionWriteClient,
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

  return server;
};

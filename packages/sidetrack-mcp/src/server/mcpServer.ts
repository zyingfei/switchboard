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
  readonly createAnnotation?: (input: {
    readonly url: string;
    readonly pageTitle: string;
    readonly anchor: SerializedAnchor;
    readonly note: string;
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
const TERM_CONTEXT_CHARS = 32;
// Minimum term length below which prefix or suffix is required, to
// avoid highlighting the wrong occurrence on a page where the term
// repeats. Picked to clear common short tokens (~5 chars) like
// "node", "code", "AI" while still allowing real terms like "WebGPU".
const TERM_MIN_LEN_WITHOUT_CONTEXT = 6;

const asStructuredContent = (value: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: toolText(value) }],
  structuredContent: value,
});

const termContextPrefix = (prefix: string | undefined): string => {
  if (prefix === undefined) {
    return '';
  }
  return prefix.slice(Math.max(0, prefix.length - TERM_CONTEXT_CHARS));
};

const termContextSuffix = (suffix: string | undefined): string => {
  if (suffix === undefined) {
    return '';
  }
  return suffix.slice(0, TERM_CONTEXT_CHARS);
};

const buildTermAnchor = (input: {
  readonly term: string;
  readonly prefix?: string;
  readonly suffix?: string;
}): SerializedAnchor => ({
  textQuote: {
    exact: input.term,
    prefix: termContextPrefix(input.prefix),
    suffix: termContextSuffix(input.suffix),
  },
  // MCP-created annotations are intentionally quote-bound. Out-of-band
  // poison values (MAX_SAFE_INTEGER, magic selectors) misrepresent
  // intent and risk matching unrelated DOM. Empty cssSelector + an
  // out-of-range textPosition mean "term-quote only"; the extension's
  // findAnchor() short-circuits both fallbacks when they are empty
  // or unsatisfiable.
  textPosition: { start: -1, end: -1 },
  cssSelector: '',
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

  server.registerTool(
    'bac.recent_threads',
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
    'bac.workstream',
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
    'bac.context_pack',
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
    'bac.search',
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
    'bac.queued_items',
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
    'bac.inbound_reminders',
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
    'bac.coding_sessions',
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

  server.registerTool(
    'bac.coding_session_register',
    {
      description:
        "Register the current coding agent's session against a Sidetrack workstream. Call this once at the start of a coding session. The user provides the attach token; auto-detect cwd, branch, sessionId, and a short display name from your runtime — do not ask the user for those.",
      inputSchema: {
        token: z
          .string()
          .min(8)
          .max(64)
          .describe('One-time attach token, supplied by the Sidetrack side panel.'),
        tool: z.enum(['claude_code', 'codex', 'cursor', 'other']),
        cwd: z.string().min(1).describe('Absolute working directory.'),
        branch: z.string().min(1).describe('Current git branch.'),
        sessionId: z.string().min(1).describe('Stable agent-side session identifier.'),
        name: z.string().min(1).describe('Short display name (e.g. "claude-code · feat/queue").'),
        resumeCommand: z
          .string()
          .min(1)
          .optional()
          .describe('Shell command that resumes this agent session.'),
      },
    },
    async ({ token, tool, cwd, branch, sessionId, name, resumeCommand }) => {
      if (companionClient === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; bac.coding_session_register is unavailable.',
        );
      }
      const result = await companionClient.registerCodingSession({
        token,
        tool,
        cwd,
        branch,
        sessionId,
        name,
        ...(resumeCommand === undefined ? {} : { resumeCommand }),
      });
      return asStructuredContent({
        bac_id: result.bac_id,
        ...(result.workstreamId === undefined ? {} : { workstreamId: result.workstreamId }),
        session: result,
        registeredAt: new Date().toISOString(),
      });
    },
  );

  server.registerTool(
    'bac.request_dispatch',
    {
      description:
        'Ask Sidetrack to dispatch a packet from this attached coding session to a target AI. The request is auto-approved for now and recorded through the normal dispatch ledger.',
      inputSchema: {
        codingSessionId: z
          .string()
          .min(1)
          .describe('bac_id returned by bac.coding_session_register.'),
        targetProvider: z
          .enum(['chatgpt', 'claude', 'gemini'])
          .describe('Target AI provider that should receive the packet.'),
        title: z.string().min(1).describe('Short dispatch title shown in Recent dispatches.'),
        body: z.string().min(1).max(20000).describe('Packet body to send to the target AI.'),
        workstreamId: z
          .string()
          .optional()
          .describe('Workstream bac_id. Defaults to the registered session workstream.'),
        sourceThreadId: z.string().optional().describe('Optional source thread bac_id.'),
        mode: z
          .enum(['paste', 'auto-send'])
          .optional()
          .describe("Dispatch mode. Defaults to 'auto-send'."),
      },
    },
    async ({
      codingSessionId,
      targetProvider,
      title,
      body,
      workstreamId,
      sourceThreadId,
      mode,
    }) => {
      if (companionClient?.requestDispatch === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; bac.request_dispatch is unavailable.',
        );
      }
      const sessions = await reader.readCodingSessions({ status: 'attached' });
      const session = sessions.find((candidate) => candidate.bac_id === codingSessionId);
      if (session === undefined) {
        throw new Error(
          `bac.request_dispatch requires an attached coding session; '${codingSessionId}' is not attached.`,
        );
      }
      const resolvedWorkstreamId = workstreamId ?? session.workstreamId;
      const result = await companionClient.requestDispatch({
        codingSessionId,
        targetProvider,
        title,
        body,
        mode: mode ?? 'auto-send',
        ...(resolvedWorkstreamId === undefined ? {} : { workstreamId: resolvedWorkstreamId }),
        ...(sourceThreadId === undefined ? {} : { sourceThreadId }),
      });
      return asStructuredContent({
        dispatchId: result.dispatchId,
        approval: result.approval,
        status: result.status,
        requestedAt: result.requestedAt,
        targetProvider,
        mode: mode ?? 'auto-send',
        ...(resolvedWorkstreamId === undefined ? {} : { workstreamId: resolvedWorkstreamId }),
      });
    },
  );

  // Write tools — let an attached coding agent move a thread into a
  // workstream and park a follow-up question. Both wrap existing
  // companion endpoints (POST /v1/threads upsert with
  // primaryWorkstreamId, POST /v1/queue), so no new schema lands here.
  // The companion enforces auth via x-bac-bridge-key; per-workstream
  // trust UI is intentionally deferred.
  server.registerTool(
    'bac.move_item',
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
          'sidetrack-mcp was started without --companion-url / --bridge-key; bac.move_item is unavailable.',
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
    'bac.queue_item',
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
          'sidetrack-mcp was started without --companion-url / --bridge-key; bac.queue_item is unavailable.',
        );
      }
      if (scope !== 'global' && (targetId === undefined || targetId.length === 0)) {
        throw new Error(
          `bac.queue_item requires targetId when scope='${scope}'. Pass the thread or workstream bac_id, or use scope='global'.`,
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
    'bac.bump_workstream',
    {
      description: 'Mark a workstream as recently active by updating lastBumpedAt.',
      inputSchema: { bac_id: z.string().min(1) },
    },
    async ({ bac_id }) => {
      if (companionClient?.bumpWorkstream === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; bac.bump_workstream is unavailable.',
        );
      }
      return asStructuredContent(await companionClient.bumpWorkstream({ bac_id }));
    },
  );

  server.registerTool(
    'bac.archive_thread',
    {
      description: 'Soft-archive a tracked thread. Idempotent.',
      inputSchema: { bac_id: z.string().min(1) },
    },
    async ({ bac_id }) => {
      if (companionClient?.archiveThread === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; bac.archive_thread is unavailable.',
        );
      }
      return asStructuredContent(await companionClient.archiveThread({ bac_id }));
    },
  );

  server.registerTool(
    'bac.unarchive_thread',
    {
      description: 'Clear a thread soft-archive marker. Idempotent.',
      inputSchema: { bac_id: z.string().min(1) },
    },
    async ({ bac_id }) => {
      if (companionClient?.unarchiveThread === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; bac.unarchive_thread is unavailable.',
        );
      }
      return asStructuredContent(await companionClient.unarchiveThread({ bac_id }));
    },
  );

  server.registerTool(
    'bac.list_dispatches',
    {
      description: 'Return recent dispatch events through the bridge-authenticated companion API.',
      inputSchema: {
        limit: z.number().int().positive().max(100).optional(),
        since: z.iso.datetime().optional(),
      },
    },
    async ({ limit, since }) => {
      if (companionClient?.listDispatches === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; bac.list_dispatches is unavailable.',
        );
      }
      const data = await companionClient.listDispatches({
        ...(limit === undefined ? {} : { limit }),
        ...(since === undefined ? {} : { since }),
      });
      return asStructuredContent({ data: [...data] });
    },
  );

  server.registerTool(
    'bac.list_audit_events',
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
          'sidetrack-mcp was started without --companion-url / --bridge-key; bac.list_audit_events is unavailable.',
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
    'bac.list_workstream_notes',
    {
      description: 'Return human-authored markdown notes whose frontmatter links to a workstream.',
      inputSchema: {
        workstreamId: z.string().min(1),
      },
    },
    async ({ workstreamId }) => {
      if (companionClient?.listWorkstreamNotes === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; bac.list_workstream_notes is unavailable.',
        );
      }
      const items = await companionClient.listWorkstreamNotes({ workstreamId });
      return asStructuredContent({ items: [...items] });
    },
  );

  server.registerTool(
    'bac.create_annotation',
    {
      description:
        'Persist a term-scoped web annotation. Use prefix/suffix from the surrounding text when the term appears multiple times on the page.',
      inputSchema: {
        url: z.url().describe('Exact page URL where the annotation should be restored.'),
        pageTitle: z.string().min(1).describe('Current page title.'),
        term: z
          .string()
          .trim()
          .min(1)
          .max(400)
          .describe('Exact term or short quote to highlight on the page.'),
        note: z.string().max(5000).describe('Annotation note to show in Sidetrack.'),
        prefix: z
          .string()
          .max(512)
          .optional()
          .describe(
            'Optional text immediately before the target term. Used to disambiguate repeated terms.',
          ),
        suffix: z
          .string()
          .max(512)
          .optional()
          .describe(
            'Optional text immediately after the target term. Used to disambiguate repeated terms.',
          ),
      },
    },
    async ({ url, pageTitle, term, note, prefix, suffix }) => {
      if (companionClient?.createAnnotation === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; bac.create_annotation is unavailable.',
        );
      }
      // Short terms collide on common pages — "node" or "AI" hits a
      // dozen unrelated occurrences. Refuse without context so the
      // agent has to provide prefix/suffix that pins to the right
      // sentence. Anything ≥ TERM_MIN_LEN_WITHOUT_CONTEXT is allowed
      // unconditionally; the agent is trusted to be specific.
      const trimmedTerm = term.trim();
      const hasContext =
        (prefix !== undefined && prefix.trim().length > 0) ||
        (suffix !== undefined && suffix.trim().length > 0);
      if (trimmedTerm.length < TERM_MIN_LEN_WITHOUT_CONTEXT && !hasContext) {
        throw new Error(
          `bac.create_annotation: term "${trimmedTerm}" is shorter than ${String(TERM_MIN_LEN_WITHOUT_CONTEXT)} chars; provide prefix or suffix from the surrounding sentence so the highlight pins to the intended occurrence.`,
        );
      }
      const annotation = await companionClient.createAnnotation({
        url,
        pageTitle,
        anchor: buildTermAnchor({
          term,
          ...(prefix === undefined ? {} : { prefix }),
          ...(suffix === undefined ? {} : { suffix }),
        }),
        note,
      });
      return asStructuredContent({
        annotation,
        term,
        createdAt: new Date().toISOString(),
      });
    },
  );

  server.registerTool(
    'bac.list_annotations',
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
          'sidetrack-mcp was started without --companion-url / --bridge-key; bac.list_annotations is unavailable.',
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
    'bac.update_annotation',
    {
      description:
        'Update an annotation note while preserving the previous note in revision history.',
      inputSchema: { bac_id: z.string().min(1), note: z.string() },
    },
    async ({ bac_id, note }) => {
      if (companionClient?.updateAnnotation === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; bac.update_annotation is unavailable.',
        );
      }
      return asStructuredContent(await companionClient.updateAnnotation({ bac_id, note }));
    },
  );

  server.registerTool(
    'bac.delete_annotation',
    {
      description: 'Soft-delete an annotation. Idempotent; history is preserved.',
      inputSchema: { bac_id: z.string().min(1) },
    },
    async ({ bac_id }) => {
      if (companionClient?.deleteAnnotation === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; bac.delete_annotation is unavailable.',
        );
      }
      return asStructuredContent(await companionClient.deleteAnnotation({ bac_id }));
    },
  );

  server.registerTool(
    'bac.read_thread_md',
    {
      description: 'Return raw vault Markdown for a tracked thread, capped by the companion.',
      inputSchema: { bac_id: z.string().min(1) },
    },
    async ({ bac_id }) => {
      if (companionClient?.readThreadMarkdown === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; bac.read_thread_md is unavailable.',
        );
      }
      return asStructuredContent(await companionClient.readThreadMarkdown({ bac_id }));
    },
  );

  server.registerTool(
    'bac.read_workstream_md',
    {
      description: 'Return raw vault Markdown for a workstream root file, capped by the companion.',
      inputSchema: { bac_id: z.string().min(1) },
    },
    async ({ bac_id }) => {
      if (companionClient?.readWorkstreamMarkdown === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; bac.read_workstream_md is unavailable.',
        );
      }
      return asStructuredContent(await companionClient.readWorkstreamMarkdown({ bac_id }));
    },
  );

  server.registerTool(
    'bac.recall',
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
          'sidetrack-mcp was started without --companion-url / --bridge-key; bac.recall is unavailable.',
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
    'bac.suggest_workstream',
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
          'sidetrack-mcp was started without --companion-url / --bridge-key; bac.suggest_workstream is unavailable.',
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
    'bac.export_settings',
    {
      description: 'Export portable Sidetrack settings and workstream metadata.',
      inputSchema: {},
    },
    async () => {
      if (companionClient?.exportSettings === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; bac.export_settings is unavailable.',
        );
      }
      return asStructuredContent(await companionClient.exportSettings());
    },
  );

  server.registerTool(
    'bac.system_update_check',
    {
      description: 'Return read-only companion version update advisory.',
      inputSchema: {},
    },
    async () => {
      if (companionClient?.systemUpdateCheck === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; bac.system_update_check is unavailable.',
        );
      }
      return asStructuredContent(await companionClient.systemUpdateCheck());
    },
  );

  server.registerTool(
    'bac.list_buckets',
    {
      description: 'List companion multi-vault routing buckets. Read-only.',
      inputSchema: {},
    },
    async () => {
      if (companionClient?.listBuckets === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; bac.list_buckets is unavailable.',
        );
      }
      return asStructuredContent({ items: [...(await companionClient.listBuckets())] });
    },
  );

  server.registerTool(
    'bac.system_health',
    {
      description: 'Return best-effort companion health metrics for diagnostics.',
      inputSchema: {},
    },
    async () => {
      if (companionClient?.systemHealth === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; bac.system_health is unavailable.',
        );
      }
      return asStructuredContent(await companionClient.systemHealth());
    },
  );

  // No MCP tools are exposed for auto-update execution, recall GC, or
  // trust-management writes. They mutate local operational policy and require
  // a user-mediated surface rather than agent invocation.

  server.registerTool(
    'bac.dispatches',
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
    'bac.reviews',
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
    'bac.turns',
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

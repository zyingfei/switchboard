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

export interface CompanionWriteClient {
  readonly registerCodingSession: (input: {
    readonly token: string;
    readonly tool: 'claude_code' | 'codex' | 'cursor' | 'other';
    readonly cwd: string;
    readonly branch: string;
    readonly sessionId: string;
    readonly name: string;
    readonly resumeCommand?: string;
  }) => Promise<{ readonly bac_id: string }>;
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
        registeredAt: new Date().toISOString(),
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

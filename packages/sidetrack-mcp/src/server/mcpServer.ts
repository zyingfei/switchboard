import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { LiveVaultReader, LiveVaultSnapshot } from '../vault/liveVaultReader.js';

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

const searchSnapshot = (snapshot: LiveVaultSnapshot, query: string) => {
  const normalizedQuery = query.toLowerCase();
  const hits = [
    ...snapshot.threads.map((thread) => ({
      kind: 'thread',
      id: thread.bac_id,
      title: thread.title ?? thread.threadUrl ?? thread.bac_id,
      text: JSON.stringify(thread),
    })),
    ...snapshot.queueItems.map((item) => ({
      kind: 'queue',
      id: item.bac_id,
      title: item.text ?? item.bac_id,
      text: JSON.stringify(item),
    })),
    ...snapshot.reminders.map((reminder) => ({
      kind: 'reminder',
      id: reminder.bac_id,
      title: reminder.threadId ?? reminder.bac_id,
      text: JSON.stringify(reminder),
    })),
  ];

  return hits
    .filter((hit) => hit.text.toLowerCase().includes(normalizedQuery))
    .map((hit) => ({
      kind: hit.kind,
      id: hit.id,
      title: hit.title,
      excerpt: hit.text.slice(0, 240),
    }));
};

export const createSidetrackMcpServer = (reader: LiveVaultReader): McpServer => {
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
        hits: searchSnapshot(snapshot, query),
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
      description: 'Return coding sessions. M1 has no attach UI, so this returns an empty list.',
      inputSchema: {},
    },
    () =>
      Promise.resolve(
        asStructuredContent({ codingSessions: [], generatedAt: new Date().toISOString() }),
      ),
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
        verdict: z
          .enum(['agree', 'disagree', 'partial', 'needs_source', 'open'])
          .optional(),
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

  return server;
};

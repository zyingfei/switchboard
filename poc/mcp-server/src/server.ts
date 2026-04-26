import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { buildContextPack } from '../../dogfood-loop/src/context/contextPack';
import { findDejaVuHits } from '../../dogfood-loop/src/recall/dejaVu';

import { appendAuditEntry } from './audit';
import { maskStructuredData } from './mask';
import type { BacRuntime } from './runtime';

const threadSchema = z.object({
  id: z.string(),
  provider: z.string(),
  title: z.string(),
  url: z.string(),
  tabId: z.number(),
  lastSpeaker: z.string(),
  status: z.string(),
  selectorCanary: z.string(),
  updatedAt: z.string(),
});

const nodeSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    title: z.string(),
    content: z.string().optional(),
    url: z.string().optional(),
    provider: z.string().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

const promptRunSchema = z.object({
  id: z.string(),
  sourceNoteId: z.string(),
  targetThreadId: z.string(),
  promptText: z.string(),
  status: z.string(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
  failureReason: z.string().optional(),
});

const eventSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    entityId: z.string().optional(),
    payload: z.any().optional(),
    createdAt: z.string(),
  })
  .passthrough();

const recentThreadsResponseSchema = z.object({
  threads: z.array(threadSchema),
  generatedAt: z.string(),
});

const workstreamResponseSchema = z.object({
  nodes: z.array(nodeSchema),
  promptRuns: z.array(promptRunSchema),
  events: z.array(eventSchema).optional(),
  generatedAt: z.string(),
});

const contextPackResponseSchema = z.object({
  pack: z.object({
    generatedAt: z.string(),
    markdown: z.string(),
    eventLogSlice: z.string(),
  }),
});

const searchResponseSchema = z.object({
  hits: z.array(
    z.object({
      nodeId: z.string(),
      title: z.string(),
      provider: z.string().optional(),
      ageDays: z.number(),
      score: z.number(),
      excerpt: z.string(),
    }),
  ),
  generatedAt: z.string(),
});

const recallResponseSchema = z.object({
  hits: z.array(
    z.object({
      title: z.string(),
      sourcePath: z.string(),
      capturedAt: z.string(),
      score: z.number(),
      snippet: z.string(),
      recencyBucket: z.enum(['0-3d', '4-21d', '22-90d', '91d+']),
    }),
  ),
  generatedAt: z.string(),
});

const toolResultText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const countSummary = (value: Record<string, unknown>): Record<string, unknown> => {
  const summary: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item)) {
      summary[key] = item.length;
    }
  }
  return summary;
};

export const createBacServer = (runtime: BacRuntime): McpServer => {
  const server = new McpServer({
    name: 'browser-ai-companion-mcp-server-poc',
    version: '0.0.0',
  });

  const runTool = async <TValue>(
    toolName: string,
    args: unknown,
    render: () => Promise<{
      text: string;
      structuredContent: TValue;
    }>,
  ) => {
    const startedAt = Date.now();
    try {
      const result = await render();
      const structuredContent = runtime.config.screenShareSafe
        ? maskStructuredData(result.structuredContent)
        : result.structuredContent;
      await appendAuditEntry(runtime.config.auditLogPath, {
        at: new Date().toISOString(),
        tool: toolName,
        args,
        ok: true,
        durationMs: Date.now() - startedAt,
        summary:
          structuredContent && typeof structuredContent === 'object'
            ? countSummary(structuredContent as Record<string, unknown>)
            : undefined,
      });
      return {
        content: [{ type: 'text' as const, text: result.text }],
        structuredContent: structuredContent as Record<string, unknown>,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendAuditEntry(runtime.config.auditLogPath, {
        at: new Date().toISOString(),
        tool: toolName,
        args,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: message,
      });
      throw error;
    }
  };

  server.registerTool(
    'bac.recent_threads',
    {
      description: 'Return observed browser AI threads from local BAC provider captures.',
      inputSchema: {
        limit: z.number().int().positive().optional(),
      },
      outputSchema: recentThreadsResponseSchema,
    },
    async ({ limit = undefined }) =>
      await runTool('bac.recent_threads', { limit }, async () => {
        const data = await runtime.readRuntimeData();
        const structuredContent = {
          threads: limit ? data.threadRegistry.slice(0, limit) : data.threadRegistry,
          generatedAt: data.generatedAt,
        };
        return {
          text: toolResultText(structuredContent),
          structuredContent,
        };
      }),
  );

  server.registerTool(
    'bac.workstream',
    {
      description: 'Return current workstream nodes and prompt runs from the local vault and provider captures.',
      inputSchema: {
        includeEvents: z.boolean().optional(),
      },
      outputSchema: workstreamResponseSchema,
    },
    async ({ includeEvents = false }) =>
      await runTool('bac.workstream', { includeEvents }, async () => {
        const data = await runtime.readRuntimeData();
        const structuredContent = includeEvents
          ? {
              nodes: data.nodes,
              promptRuns: data.promptRuns,
              events: data.events,
              generatedAt: data.generatedAt,
            }
          : {
              nodes: data.nodes,
              promptRuns: data.promptRuns,
              generatedAt: data.generatedAt,
            };
        return {
          text: toolResultText(structuredContent),
          structuredContent,
        };
      }),
  );

  server.registerTool(
    'bac.context_pack',
    {
      description: 'Return a portable markdown Context Pack for the current workstream.',
      inputSchema: {
        includeEventLog: z.boolean().optional(),
      },
      outputSchema: contextPackResponseSchema,
    },
    async ({ includeEventLog: _includeEventLog = true }) =>
      await runTool('bac.context_pack', {}, async () => {
        const data = await runtime.readRuntimeData();
        const note = data.nodes.find((node) => node.type === 'note') ?? null;
        const responses = data.nodes.filter((node) => node.type === 'chat_response');
        const sources = data.nodes.filter((node) => node.type === 'source');
        const pack = buildContextPack({
          note,
          responses,
          sources,
          promptRuns: data.promptRuns,
          events: data.events,
          threadRegistry: data.threadRegistry,
          generatedAt: data.generatedAt,
        });
        return {
          text: runtime.config.screenShareSafe ? maskStructuredData(pack).markdown : pack.markdown,
          structuredContent: { pack },
        };
      }),
  );

  server.registerTool(
    'bac.search',
    {
      description: 'Run lexical local recall across BAC notes and captured responses.',
      inputSchema: {
        query: z.string().min(1),
        minAgeDays: z.number().min(0).optional(),
        maxAgeDays: z.number().min(0).optional(),
      },
      outputSchema: searchResponseSchema,
    },
    async ({ query, minAgeDays = undefined, maxAgeDays = undefined }) =>
      await runTool('bac.search', { query, minAgeDays, maxAgeDays }, async () => {
        const data = await runtime.readRuntimeData();
        const structuredContent = {
          hits: findDejaVuHits(
            query.trim(),
            data.nodes,
            new Date(data.generatedAt),
            minAgeDays,
            maxAgeDays,
          ),
          generatedAt: data.generatedAt,
        };
        return {
          text: toolResultText(structuredContent),
          structuredContent,
        };
      }),
  );

  server.registerTool(
    'bac.recall',
    {
      description: 'Run calibrated-freshness semantic recall across the local BAC vault.',
      inputSchema: {
        query: z.string().min(1),
        recencyWindow: z.enum(['3d', '3w', '3m', '3y']).optional(),
        topK: z.number().int().positive().optional(),
        project: z.string().optional(),
        bucket: z.string().optional(),
      },
      outputSchema: recallResponseSchema,
    },
    async ({ query, recencyWindow = undefined, topK = undefined, project = undefined, bucket = undefined }) =>
      await runTool('bac.recall', { query, recencyWindow, topK, project, bucket }, async () => {
        const structuredContent = await runtime.recall({
          query,
          recencyWindow,
          topK,
          project,
          bucket,
        });
        return {
          text: toolResultText(structuredContent),
          structuredContent,
        };
      }),
  );

  return server;
};

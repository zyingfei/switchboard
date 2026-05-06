// Typed dispatch tool surface. Two focused, event-oriented tools:
//
//   sidetrack.dispatch.create       — write the dispatch event; returns
//                                     a dispatchId + resource URIs.
//   sidetrack.dispatch.await_capture — block (or long-poll) until the
//                                     captured ChatGPT/Claude/Gemini
//                                     thread is linked to that dispatch.
//                                     Returns the captured thread,
//                                     resource URIs for follow-up
//                                     reads, and the latest assistant
//                                     turn so the agent can act on
//                                     content without a polling
//                                     runbook.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { CompanionWriteClient, SidetrackMcpReader } from './mcpServer.js';

const targetProviderSchema = z.enum(['chatgpt', 'claude', 'gemini']);
const dispatchModeSchema = z.enum(['paste', 'auto-send']);

const dispatchCreateOutputShape = {
  dispatchId: z.string(),
  approval: z.literal('auto-approved'),
  status: z.string(),
  requestedAt: z.iso.datetime(),
  targetProvider: targetProviderSchema,
  mode: dispatchModeSchema,
  workstreamId: z.string().optional(),
  statusResource: z.string(),
  threadResource: z.string().optional(),
};

const awaitCaptureOutputShape = {
  dispatchId: z.string(),
  matched: z.boolean(),
  linkedAt: z.iso.datetime().optional(),
  // Captured thread identity. Use `thread.threadId` as the input to
  // `sidetrack.annotations.create_batch` and the resource URIs.
  thread: z
    .object({
      threadId: z.string(),
      threadUrl: z.url().optional(),
      title: z.string().optional(),
      provider: targetProviderSchema.optional(),
    })
    .optional(),
  // Pre-built MCP resource URIs for the linked thread + dispatch.
  // The agent should follow these instead of constructing URI templates
  // from boilerplate prompt knowledge.
  resources: z
    .object({
      dispatch: z.string(),
      thread: z.string(),
      turns: z.string(),
      markdown: z.string(),
      annotations: z.string(),
    })
    .optional(),
  // Latest assistant turn from the linked thread, included by default
  // so the agent can read the answer without an extra
  // `sidetrack.threads.turns` round trip. Pass
  // `includeLatestAssistantTurn: false` to suppress.
  latestAssistantTurn: z
    .object({
      ordinal: z.number().int(),
      text: z.string(),
      capturedAt: z.iso.datetime(),
    })
    .optional(),
  reason: z.enum(['matched', 'timeout']).optional(),
};

export const registerDispatchTools = (
  server: McpServer,
  reader: SidetrackMcpReader,
  companionClient?: CompanionWriteClient,
): void => {
  server.registerTool(
    'sidetrack.dispatch.create',
    {
      description:
        'Dispatch a packet from the attached coding session to a target AI provider. The companion records the dispatch and the extension auto-opens the chat tab to drive auto-send. Returns a dispatch handle plus resource URIs the agent can subscribe to once Phase 5 prompts/resources are live.',
      inputSchema: {
        codingSessionId: z
          .string()
          .min(1)
          .describe('bac_id returned by sidetrack.session.attach.'),
        targetProvider: targetProviderSchema.describe(
          'Which provider should receive the packet.',
        ),
        title: z
          .string()
          .min(1)
          .describe('Short title shown in Sidetrack Recent Dispatches.'),
        body: z
          .string()
          .min(1)
          .max(20000)
          .describe('The packet body the target AI will receive.'),
        workstreamId: z
          .string()
          .optional()
          .describe('Workstream bac_id. Defaults to the registered session workstream.'),
        sourceThreadId: z.string().optional().describe('Optional source thread bac_id.'),
        mode: dispatchModeSchema
          .optional()
          .describe("Dispatch mode. Defaults to 'auto-send'."),
      },
      outputSchema: dispatchCreateOutputShape,
    },
    async ({ codingSessionId, targetProvider, title, body, workstreamId, sourceThreadId, mode }) => {
      if (companionClient?.requestDispatch === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; sidetrack.dispatch.create is unavailable.',
        );
      }
      const sessions = await reader.readCodingSessions({ status: 'attached' });
      const session = sessions.find((candidate) => candidate.bac_id === codingSessionId);
      if (session === undefined) {
        throw new Error(
          `sidetrack.dispatch.create requires an attached coding session; '${codingSessionId}' is not attached.`,
        );
      }
      const resolvedWorkstreamId = workstreamId ?? session.workstreamId;
      const resolvedMode = mode ?? 'auto-send';
      const result = await companionClient.requestDispatch({
        codingSessionId,
        targetProvider,
        title,
        body,
        mode: resolvedMode,
        ...(resolvedWorkstreamId === undefined ? {} : { workstreamId: resolvedWorkstreamId }),
        ...(sourceThreadId === undefined ? {} : { sourceThreadId }),
      });
      const structured: z.infer<z.ZodObject<typeof dispatchCreateOutputShape>> = {
        dispatchId: result.dispatchId,
        approval: result.approval,
        status: result.status,
        requestedAt: result.requestedAt,
        targetProvider,
        mode: resolvedMode,
        statusResource: `sidetrack://dispatch/${result.dispatchId}`,
        ...(resolvedWorkstreamId === undefined ? {} : { workstreamId: resolvedWorkstreamId }),
      };
      return {
        content: [{ type: 'text' as const, text: `${JSON.stringify(structured, null, 2)}\n` }],
        structuredContent: structured,
      };
    },
  );

  server.registerTool(
    'sidetrack.dispatch.await_capture',
    {
      description:
        "Wait for a dispatch to be linked to a captured thread. Use this immediately after sidetrack.dispatch.create when the user expects the target AI's response to be read or annotated. Returns thread identity, resource URIs the agent can readResource, and the latest assistant turn so no follow-up turn fetch is needed.",
      inputSchema: {
        dispatchId: z
          .string()
          .min(1)
          .describe('dispatchId returned by sidetrack.dispatch.create.'),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(120_000)
          .optional()
          .describe('Long-poll timeout in milliseconds. Default 60_000, capped at 120_000.'),
        includeLatestAssistantTurn: z
          .boolean()
          .optional()
          .describe(
            'When true (default), the response includes latestAssistantTurn so the agent can act on the captured answer immediately. Set false to skip the read.',
          ),
      },
      outputSchema: awaitCaptureOutputShape,
    },
    async ({ dispatchId, timeoutMs, includeLatestAssistantTurn }) => {
      if (companionClient?.awaitCaptureForDispatch === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; sidetrack.dispatch.await_capture is unavailable.',
        );
      }
      const result = await companionClient.awaitCaptureForDispatch({
        dispatchId,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(includeLatestAssistantTurn === undefined
          ? {}
          : { includeLatestAssistantTurn }),
      });
      const structured: z.infer<z.ZodObject<typeof awaitCaptureOutputShape>> = {
        dispatchId: result.dispatchId,
        matched: result.matched,
        ...(result.linkedAt === undefined ? {} : { linkedAt: result.linkedAt }),
        ...(result.thread === undefined ? {} : { thread: result.thread }),
        ...(result.resources === undefined ? {} : { resources: result.resources }),
        ...(result.latestAssistantTurn === undefined
          ? {}
          : { latestAssistantTurn: result.latestAssistantTurn }),
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      };
      return {
        content: [{ type: 'text' as const, text: `${JSON.stringify(structured, null, 2)}\n` }],
        structuredContent: structured,
      };
    },
  );
};

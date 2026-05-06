// Typed dispatch tool surface introduced in the MCP-spec alignment
// refactor. Replaces the ad-hoc `bac.request_dispatch` flow with two
// focused, event-oriented tools:
//
//   sidetrack.dispatch.create      — write the dispatch event; returns
//                                    a dispatchId + resource URIs.
//   sidetrack.dispatch.await_capture — block (or long-poll) until the
//                                    captured ChatGPT/Claude/Gemini
//                                    thread is linked to that dispatch.
//
// The second tool is a stub in this commit. Phase 3 of the refactor
// ports the dispatchId↔threadId matcher from the extension's
// chrome.storage into the companion vault and wires the long-poll
// against `GET /v1/dispatches/:bacId/await-capture`. Until then,
// await_capture returns `matched: false, reason: 'unsupported-in-phase-1'`
// and instructs the caller to fall back to `sidetrack.threads.list`
// time-filtering — same fallback the legacy demo prompt used.

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
  // Resource URIs the agent can subscribe to once Phase 5 lands. Surfaced
  // here so prompts written today reference the right names tomorrow.
  statusResource: z.string(),
  threadResource: z.string().optional(),
};

const awaitCaptureOutputShape = {
  dispatchId: z.string(),
  matched: z.boolean(),
  threadId: z.string().optional(),
  threadUrl: z.url().optional(),
  title: z.string().optional(),
  provider: targetProviderSchema.optional(),
  reason: z
    .enum([
      'matched',
      'timeout',
      'no-prefix-match',
      'tiny-prefix',
      'window-expired',
      'provider-mismatch',
      'already-linked',
      // Sentinel returned by the Phase-1 stub so callers can detect that
      // server-side correlation is not yet available and fall back to
      // `sidetrack.threads.list` time-filtered polling.
      'unsupported-in-phase-1',
    ])
    .optional(),
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
        "Block until the dispatch's chat tab has been auto-opened, auto-sent, and captured. Returns the linked thread when matched, or a reason code when the timeout hits. NOTE: Phase 1 returns 'unsupported-in-phase-1' — Phase 3 wires the long-poll against the companion link table. In the meantime, fall back to `sidetrack.threads.list` filtered by capturedAt > the dispatch creation time.",
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
      },
      outputSchema: awaitCaptureOutputShape,
    },
    async ({ dispatchId }) => {
      // Phase 1 stub. Phase 3 replaces this with a real call to
      // companion `GET /v1/dispatches/:bacId/await-capture`.
      const structured: z.infer<z.ZodObject<typeof awaitCaptureOutputShape>> = {
        dispatchId,
        matched: false,
        reason: 'unsupported-in-phase-1',
      };
      return {
        content: [{ type: 'text' as const, text: `${JSON.stringify(structured, null, 2)}\n` }],
        structuredContent: structured,
      };
    },
  );
};

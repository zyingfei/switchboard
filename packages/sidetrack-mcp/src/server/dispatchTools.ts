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

// Capture profiles encode "how should the captured response be
// shaped" as a structured option, not as user-prompt boilerplate.
// The MCP tool composes a short formatting prefix from the chosen
// profile + responseProfile, prepends it to the body, and lets the
// caller's intent stay verbatim (i.e. body still reads like the
// user's actual request). This keeps the prompt-side surface small
// while still giving the agent control over downstream-friendly
// output.
const captureProfileSchema = z.enum(['default', 'annotation_friendly', 'plain_text_diagrams']);
const responseProfileSchema = z.object({
  preferPlainText: z.boolean().optional(),
  avoidLatex: z.boolean().optional(),
  preferSectionHeadings: z.boolean().optional(),
  preferStableTerminology: z.boolean().optional(),
});

const buildFormattingPrefix = (
  captureProfile: z.infer<typeof captureProfileSchema> | undefined,
  responseProfile: z.infer<typeof responseProfileSchema> | undefined,
): string => {
  const lines: string[] = [];
  // Profile presets — turned into specific request lines so the
  // target AI sees a normal user instruction rather than a
  // metadata block. 'annotation_friendly' is the heaviest preset
  // because anchor restoration depends on stable visible text.
  if (captureProfile === 'annotation_friendly') {
    lines.push('Format: respond in plain text. Prefer ASCII for diagrams (no LaTeX, no images).');
    lines.push('Use clear section headings. Keep technical terminology consistent throughout.');
  } else if (captureProfile === 'plain_text_diagrams') {
    lines.push('Format: prefer plain text and ASCII diagrams. Avoid LaTeX or rich formatting.');
  }
  if (responseProfile?.preferPlainText === true && captureProfile !== 'annotation_friendly') {
    lines.push('Format: respond in plain text where possible.');
  }
  if (responseProfile?.avoidLatex === true && captureProfile === undefined) {
    lines.push('Format: avoid LaTeX; use ASCII or plain text formulas.');
  }
  if (
    responseProfile?.preferSectionHeadings === true &&
    captureProfile === undefined
  ) {
    lines.push('Format: organise the answer into labelled section headings.');
  }
  if (responseProfile?.preferStableTerminology === true && captureProfile === undefined) {
    lines.push('Format: keep technical terminology stable; avoid synonym substitution.');
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n\n`;
};

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
  // Resource URI map — same shape as await_capture, surfaced here
  // so a follow-up `readResource` is one hop away. `thread` is
  // omitted until capture lands; the agent should call
  // `sidetrack.dispatch.await_capture` to get it.
  resources: z.object({
    dispatch: z.string(),
  }),
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
        "Send a natural-language task to a target AI provider through Sidetrack. Use this when the user asks Sidetrack to ask ChatGPT, Claude, or Gemini something. Put the user's actual request in body — write it like a normal user message; do not add Sidetrack workflow instructions. If the captured answer will be annotated later, set captureProfile='annotation_friendly' instead of expanding body with formatting boilerplate. Returns a dispatchId; call sidetrack.dispatch.await_capture next to get thread + latestAssistantTurn.",
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
          .describe(
            "Natural-language request to send to the target provider. Should read like a normal user message; let captureProfile / responseProfile carry formatting constraints instead of inline instructions.",
          ),
        captureProfile: captureProfileSchema
          .optional()
          .describe(
            "Preset that shapes the response for downstream Sidetrack use. 'annotation_friendly' asks for plain text + ASCII diagrams + section headings + stable terminology — recommended whenever the captured answer will be annotated.",
          ),
        responseProfile: responseProfileSchema
          .optional()
          .describe(
            'Fine-grained alternative to captureProfile. Each flag adds a single formatting request. Use this only when no preset fits.',
          ),
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
    async ({
      codingSessionId,
      targetProvider,
      title,
      body,
      captureProfile,
      responseProfile,
      workstreamId,
      sourceThreadId,
      mode,
    }) => {
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
      // Prepend a short formatting block. The user's intent stays
      // verbatim below it so the target AI's attention bias toward
      // recent text still sees the actual request, not a wall of
      // formatting hints.
      const formattingPrefix = buildFormattingPrefix(captureProfile, responseProfile);
      const composedBody = `${formattingPrefix}${body}`;
      const result = await companionClient.requestDispatch({
        codingSessionId,
        targetProvider,
        title,
        body: composedBody,
        mode: resolvedMode,
        ...(resolvedWorkstreamId === undefined ? {} : { workstreamId: resolvedWorkstreamId }),
        ...(sourceThreadId === undefined ? {} : { sourceThreadId }),
      });
      const dispatchUri = `sidetrack://dispatch/${result.dispatchId}`;
      const structured: z.infer<z.ZodObject<typeof dispatchCreateOutputShape>> = {
        dispatchId: result.dispatchId,
        approval: result.approval,
        status: result.status,
        requestedAt: result.requestedAt,
        targetProvider,
        mode: resolvedMode,
        statusResource: dispatchUri,
        resources: { dispatch: dispatchUri },
        ...(resolvedWorkstreamId === undefined ? {} : { workstreamId: resolvedWorkstreamId }),
      };
      return {
        // Resource link plus a JSON summary. Per MCP spec, tool
        // results can return resource_link items the model client
        // surfaces alongside the textual body.
        content: [
          {
            type: 'resource_link' as const,
            uri: dispatchUri,
            name: `Dispatch ${result.dispatchId}`,
            description: 'Dispatch event record (status, body, target).',
            mimeType: 'application/json',
          },
          { type: 'text' as const, text: `${JSON.stringify(structured, null, 2)}\n` },
        ],
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
      // Resource links accompany the JSON so MCP clients can render
      // each captured-thread resource as a clickable affordance.
      // Only emitted when the dispatch matched — pre-capture there
      // are no thread resources to link to.
      const resourceLinks =
        result.matched && result.resources !== undefined && result.thread !== undefined
          ? [
              {
                type: 'resource_link' as const,
                uri: result.resources.thread,
                name: result.thread.title ?? `Thread ${result.thread.threadId}`,
                description: 'Captured thread metadata.',
                mimeType: 'application/json',
              },
              {
                type: 'resource_link' as const,
                uri: result.resources.markdown,
                name: 'Thread markdown',
                description: 'Vault-rendered Markdown for the captured thread.',
                mimeType: 'text/markdown',
              },
              {
                type: 'resource_link' as const,
                uri: result.resources.annotations,
                name: 'Thread annotations',
                description: 'Existing annotations on the thread URL.',
                mimeType: 'application/json',
              },
            ]
          : [];
      return {
        content: [
          ...resourceLinks,
          { type: 'text' as const, text: `${JSON.stringify(structured, null, 2)}\n` },
        ],
        structuredContent: structured,
      };
    },
  );
};

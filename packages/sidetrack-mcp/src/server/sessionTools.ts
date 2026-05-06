// Typed coding-session attach tool. Replaces `bac.coding_session_register`
// with a clearer name that matches what the user actually does: hand a
// short-lived attach token from the side panel to their coding agent so
// the agent can claim a Sidetrack-managed session.
//
// The legacy `bac.coding_session_register` registration in mcpServer.ts
// stays alive through Phase 1.4 (mass rename + delete) so any prompts
// already in flight don't break mid-refactor.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { CompanionWriteClient } from './mcpServer.js';

const sessionToolSchema = z.enum(['claude_code', 'codex', 'cursor', 'other']);

const sessionAttachOutputShape = {
  codingSessionId: z.string(),
  workstreamId: z.string().optional(),
  tool: sessionToolSchema,
  attachedAt: z.iso.datetime(),
};

export const registerSessionTools = (
  server: McpServer,
  companionClient?: CompanionWriteClient,
): void => {
  server.registerTool(
    'sidetrack.session.attach',
    {
      description:
        "Attach the current coding-agent session to Sidetrack. Call this once at the start of a coding session with the attach token the user pasted. Auto-detect cwd, branch, sessionId, and a short display name from your runtime — do not ask the user for those. Returns a codingSessionId you'll need for sidetrack.dispatch.create.",
      inputSchema: {
        attachToken: z
          .string()
          .min(8)
          .max(64)
          .describe('Single-use attach token, supplied by the Sidetrack side panel.'),
        tool: sessionToolSchema.describe(
          "Which agent runtime is calling: 'claude_code', 'codex', 'cursor', or 'other'.",
        ),
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
      outputSchema: sessionAttachOutputShape,
    },
    async ({ attachToken, tool, cwd, branch, sessionId, name, resumeCommand }) => {
      if (companionClient === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; sidetrack.session.attach is unavailable.',
        );
      }
      const result = await companionClient.registerCodingSession({
        token: attachToken,
        tool,
        cwd,
        branch,
        sessionId,
        name,
        ...(resumeCommand === undefined ? {} : { resumeCommand }),
      });
      const structured: z.infer<z.ZodObject<typeof sessionAttachOutputShape>> = {
        codingSessionId: result.bac_id,
        ...(result.workstreamId === undefined ? {} : { workstreamId: result.workstreamId }),
        tool,
        attachedAt: new Date().toISOString(),
      };
      return {
        content: [{ type: 'text' as const, text: `${JSON.stringify(structured, null, 2)}\n` }],
        structuredContent: structured,
      };
    },
  );
};

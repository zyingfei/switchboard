// Workflow prompts. Three callable prompts that emit the canonical
// Sidetrack agent flows so MCP clients (Claude desktop, Cursor,
// Codex) can pick them by name and pass arguments instead of having
// the user paste boilerplate from the side panel.
//
// PR-92 review correction: these prompts are *intent-level*. They
// describe what the user wants and let the agent discover the
// workflow from tool schemas, descriptions, and structured outputs.
// The earlier numbered runbooks ("1. Call dispatch.create. 2. Call
// await_capture…") reintroduced the prompt-as-workflow-engine
// pattern these prompts were meant to retire — see commit
// 8abbe70 for the matching tool-side cleanup that makes the
// workflow self-discoverable.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const userMessage = (text: string) => ({
  description: undefined,
  messages: [
    {
      role: 'user' as const,
      content: { type: 'text' as const, text },
    },
  ],
});

export const registerPrompts = (server: McpServer): void => {
  // sidetrack.session.attach({attachToken, workstreamId?})
  //
  // The 3-line attach prompt the side panel will switch to in
  // Phase 5. Capable agents can read this directly from the MCP
  // server instead of waiting for the user to copy text.
  server.registerPrompt(
    'sidetrack.session.attach',
    {
      title: 'Attach a coding session to Sidetrack',
      description:
        'Emits the minimal attach instruction. The agent calls sidetrack.session.attach with the supplied token and continues with the user task.',
      argsSchema: {
        attachToken: z.string().min(8).describe('Attach token from the Sidetrack side panel.'),
        workstreamId: z.string().min(1).optional().describe('Optional workstream bac_id.'),
      },
    },
    ({ attachToken, workstreamId }) => {
      const lines = [
        'Use the Sidetrack MCP server. Call sidetrack.session.attach with this attach token:',
        attachToken,
        ...(workstreamId === undefined
          ? []
          : ['', `Workstream context: sidetrack://workstream/${workstreamId}/context`]),
        '',
        'Then continue with my task using Sidetrack tools when useful.',
      ];
      return userMessage(lines.join('\n'));
    },
  );

  // sidetrack.demo.dispatch_and_annotate({targetProvider, taskBody, annotationCount?, audience?})
  //
  // The end-to-end demo flow that the codex-hn-mcp-annotation e2e
  // ships (PR-92). Replaces the 30+ line copy-paste script the user
  // had to keep in their notes app.
  server.registerPrompt(
    'sidetrack.demo.dispatch_and_annotate',
    {
      title: 'Dispatch a packet and pin architect-relevant annotations',
      description:
        'Sends a dispatch to the chosen provider, awaits the resulting captured thread, then annotates 3-5 architect-relevant terms on the thread URL.',
      argsSchema: {
        targetProvider: z
          .enum(['chatgpt', 'claude', 'gemini'])
          .describe('Where to send the dispatch.'),
        taskBody: z.string().min(1).describe('The packet body the provider will receive.'),
        annotationCount: z
          .string()
          .optional()
          .describe('How many annotations to pin (default 4).'),
        audience: z
          .string()
          .optional()
          .describe(
            'Who the annotations are for. Defaults to "10+ year software architects".',
          ),
      },
    },
    ({ targetProvider, taskBody, annotationCount, audience }) => {
      // Intent-level: describe the user goal. The Sidetrack tools
      // (dispatch.create, await_capture, annotations.create_batch)
      // self-document the rest through their descriptions, output
      // schemas, and resource_link content blocks.
      const audienceText = audience ?? '10+ year software architects';
      const countText = annotationCount === undefined ? 'useful' : `~${annotationCount}`;
      const lines = [
        `Use Sidetrack to dispatch this task to ${targetProvider}, then annotate ${countText} terms on the captured response that ${audienceText} would benefit from understanding.`,
        '',
        'Task to dispatch:',
        '',
        taskBody,
      ];
      return userMessage(lines.join('\n'));
    },
  );

  // sidetrack.thread.annotate({threadUrl, audience})
  //
  // Annotate-only flow against an already-captured thread. Skips
  // the dispatch step, useful when the user manually pasted into
  // a chat tab and wants the agent to pin terms after the fact.
  server.registerPrompt(
    'sidetrack.thread.annotate',
    {
      title: 'Annotate architect-relevant terms on an existing thread',
      description:
        'Reads the thread, picks 3-5 architect-relevant terms, and pins them via sidetrack.annotations.create_batch. No dispatch step.',
      argsSchema: {
        threadUrl: z.string().min(1).describe('Captured thread URL to annotate.'),
        audience: z.string().optional().describe('Audience descriptor.'),
      },
    },
    ({ threadUrl, audience }) => {
      const audienceText = audience ?? '10+ year software architects';
      const lines = [
        `Annotate the Sidetrack-captured thread at ${threadUrl} for ${audienceText}: pick terms or phrases that warrant a brief explanation, and pin them via Sidetrack annotation tools.`,
      ];
      return userMessage(lines.join('\n'));
    },
  );
};

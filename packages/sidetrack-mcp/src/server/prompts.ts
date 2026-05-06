// Phase 5: workflow prompts. Three callable prompts that emit the
// canonical Sidetrack agent flows so MCP clients (Claude desktop,
// Cursor, Codex) can pick them by name and pass arguments instead
// of having the user paste boilerplate from the side panel.
//
// Each prompt returns a single user-role message — agents handle the
// content as if the user typed it. Keeping them argument-driven lets
// prompts ride the MCP server's lifecycle (no UI roundtrips, no
// out-of-band copy/paste).

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
      const count = annotationCount ?? '4';
      const audienceText = audience ?? '10+ year software architects';
      const lines = [
        '# Sidetrack dispatch + annotate',
        '',
        '1. Call sidetrack.dispatch.create with:',
        `   - targetProvider: ${targetProvider}`,
        '   - title: short task title',
        '   - body:',
        '',
        taskBody,
        '',
        '2. Call sidetrack.dispatch.await_capture with the dispatchId from step 1.',
        '   This blocks until the chat tab finishes capturing.',
        '',
        `3. From the captured thread, identify the top ${count} terms a ${audienceText}`,
        '   would benefit from understanding. Avoid extremely-common terms.',
        '',
        '4. Call sidetrack.annotations.create_batch with:',
        '   - url: the captured threadUrl from step 2',
        '   - pageTitle: the captured title',
        `   - items: the ${count} {term, note} entries (let the companion build anchors)`,
        '',
        '5. Confirm: tell me the dispatchId, the linked threadId, and the term list.',
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
        '# Sidetrack annotate-only',
        '',
        `1. Read the thread at ${threadUrl} via sidetrack://thread/<id>/markdown`,
        '   (find the threadId via sidetrack.threads.list filtered by URL).',
        '',
        `2. Identify 3-5 terms a ${audienceText} would benefit from understanding.`,
        '',
        '3. Call sidetrack.annotations.create_batch with:',
        `   - url: ${threadUrl}`,
        '   - items: {term, note} entries (let the companion build anchors)',
      ];
      return userMessage(lines.join('\n'));
    },
  );
};

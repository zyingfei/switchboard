// Batch annotation tool. Single typed batch that takes one URL +
// pageTitle and a list of {term, note, selectionHint?} items.
// Returns per-item status so partial failures surface cleanly.
//
// Phase 4 contract (current): items carry intent only — term + optional
// selectionHint. The companion builds the anchor server-side from the
// thread's stored assistant-turn body, so the agent never does offset
// arithmetic. selectionHint disambiguates between multiple occurrences
// (either an `ordinal:N` form or a preceding-fragment).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { CompanionWriteClient } from './mcpServer.js';

const MAX_BATCH = 20;

const annotationItemShape = z.object({
  term: z
    .string()
    .trim()
    .min(1)
    .max(400)
    .describe('Exact term or short quote to highlight on the page.'),
  note: z.string().max(5000).describe('Annotation note to show in Sidetrack.'),
  selectionHint: z
    .string()
    .max(512)
    .optional()
    .describe(
      "Optional disambiguator. Either 'ordinal:N' (1-based) to pick the Nth occurrence, or a preceding-text fragment whose tail matches the context immediately before the term.",
    ),
});

const annotationStatusEnum = z.enum(['created', 'rejected', 'failed']);

const batchOutputShape = {
  annotations: z.array(
    z.object({
      term: z.string(),
      status: annotationStatusEnum,
      annotationId: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
  countForThread: z.number().int(),
  createdAt: z.iso.datetime(),
};

export const registerAnnotationTools = (
  server: McpServer,
  companionClient?: CompanionWriteClient,
): void => {
  server.registerTool(
    'sidetrack.annotations.create_batch',
    {
      description:
        'Persist 1..20 term-scoped annotations against a single page URL. Each item is a (term, note, optional selectionHint). The companion looks up the thread by URL, fetches the assistant-turn body, builds the anchor, and writes the annotation — the agent never computes offsets. Returns a per-item status array so partial failures surface cleanly.',
      inputSchema: {
        url: z.url().describe('Exact page URL where the annotations should restore.'),
        pageTitle: z.string().min(1).describe('Current page title.'),
        items: z
          .array(annotationItemShape)
          .min(1)
          .max(MAX_BATCH)
          .describe(`Between 1 and ${String(MAX_BATCH)} annotation specs.`),
      },
      outputSchema: batchOutputShape,
    },
    async ({ url, pageTitle, items }) => {
      if (companionClient?.createAnnotation === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; sidetrack.annotations.create_batch is unavailable.',
        );
      }
      const createAnnotation = companionClient.createAnnotation;
      const results: z.infer<typeof batchOutputShape.annotations>[number][] = [];
      for (const item of items) {
        const trimmedTerm = item.term.trim();
        try {
          const created = await createAnnotation({
            url,
            pageTitle,
            term: trimmedTerm,
            note: item.note,
            ...(item.selectionHint === undefined ? {} : { selectionHint: item.selectionHint }),
          });
          const rawId = created['bac_id'];
          const annotationId = typeof rawId === 'string' ? rawId : '';
          results.push({
            term: trimmedTerm,
            status: 'created',
            annotationId,
          });
        } catch (error) {
          results.push({
            term: trimmedTerm,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const successes = results.filter((entry) => entry.status === 'created').length;
      const structured: z.infer<z.ZodObject<typeof batchOutputShape>> = {
        annotations: results,
        countForThread: successes,
        createdAt: new Date().toISOString(),
      };
      return {
        content: [{ type: 'text' as const, text: `${JSON.stringify(structured, null, 2)}\n` }],
        structuredContent: structured,
      };
    },
  );
};

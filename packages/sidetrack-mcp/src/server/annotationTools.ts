// Batch annotation tool. Thread-first, intent-driven: the agent
// supplies the captured threadId and a list of {term, note,
// selectionHint?} items. The companion looks up the thread record,
// fetches the assistant-turn body, builds the anchor, and writes
// the annotation — the agent never computes offsets, prefix/suffix
// windows, or DOM positions.
//
// Failure surface is structured: each item returns a status from
// {created, anchor_failed, validation_failed, failed}. anchor_failed
// items also carry a `reason` enum and `suggestedSelectionHints` so
// the model can retry once with a disambiguating hint without any
// prompt-side procedural knowledge.

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
    .describe(
      'Exact visible term from the captured assistant turn. Prefer precise multi-word phrases over generic single words.',
    ),
  note: z.string().max(5000).describe('Annotation note to display in Sidetrack.'),
  selectionHint: z
    .string()
    .max(512)
    .optional()
    .describe(
      "Optional disambiguator. Use 'ordinal:N' (1-based) for the Nth occurrence, or a short preceding-text fragment. Required only when the tool reports short/repeated-term failure.",
    ),
});

const sourceTurnShape = z.union([
  z.literal('assistant_latest'),
  z.literal('assistant_all'),
  z.object({ ordinal: z.number().int().nonnegative() }),
]);

const anchorFailureReasonEnum = z.enum([
  'term_not_found',
  'short_term_requires_selection_hint',
  'ambiguous_term_requires_selection_hint',
  'invalid_ordinal',
  'selection_hint_no_match',
]);

const annotationStatusEnum = z.enum([
  'created',
  'anchor_failed',
  'validation_failed',
  'failed',
]);

const batchOutputShape = {
  threadId: z.string().optional(),
  url: z.string().optional(),
  attemptedCount: z.number().int(),
  createdCount: z.number().int(),
  anchorFailedCount: z.number().int(),
  failedCount: z.number().int(),
  items: z.array(
    z.object({
      term: z.string(),
      status: annotationStatusEnum,
      annotationId: z.string().optional(),
      reason: anchorFailureReasonEnum.optional(),
      message: z.string().optional(),
      occurrenceCount: z.number().int().optional(),
      suggestedSelectionHints: z.array(z.string()).optional(),
    }),
  ),
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
        'Create 1..20 annotations on a captured Sidetrack thread from semantic intent (exact visible term + note). The companion looks up the thread, picks the source turn, builds the anchor, and writes the annotation. The model must not compute offsets, prefix/suffix, or CSS selectors. Per-item statuses include retry-able anchor_failed reasons with suggestedSelectionHints — retry once with one of those hints when the reason is short_term_requires_selection_hint or ambiguous_term_requires_selection_hint.',
      inputSchema: {
        threadId: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Captured Sidetrack thread bac_id (returned by sidetrack.dispatch.await_capture as thread.threadId). Preferred over url. When provided, the companion resolves url/pageTitle from the thread record.',
          ),
        url: z
          .url()
          .optional()
          .describe(
            'Page URL where annotations restore. Optional when threadId is supplied. Required when threadId is omitted (legacy URL-driven path).',
          ),
        pageTitle: z
          .string()
          .min(1)
          .optional()
          .describe('Optional page title shown in Sidetrack. Resolved from threadId if absent.'),
        sourceTurn: sourceTurnShape
          .optional()
          .describe(
            "Which captured turn is the anchor source. Defaults to 'assistant_latest'. Pass 'assistant_all' to span every assistant turn or {ordinal:N} for a specific one.",
          ),
        items: z
          .array(annotationItemShape)
          .min(1)
          .max(MAX_BATCH)
          .describe(`Between 1 and ${String(MAX_BATCH)} annotation specs.`),
      },
      outputSchema: batchOutputShape,
    },
    async ({ threadId, url, pageTitle, sourceTurn, items }) => {
      if (companionClient?.createAnnotation === undefined) {
        throw new Error(
          'sidetrack-mcp was started without --companion-url / --bridge-key; sidetrack.annotations.create_batch is unavailable.',
        );
      }
      if (threadId === undefined && url === undefined) {
        throw new Error(
          'sidetrack.annotations.create_batch requires either threadId or url.',
        );
      }
      const createAnnotation = companionClient.createAnnotation;
      const results: z.infer<typeof batchOutputShape.items>[number][] = [];
      for (const item of items) {
        const trimmedTerm = item.term.trim();
        try {
          const result = await createAnnotation({
            ...(threadId === undefined ? {} : { threadId }),
            ...(url === undefined ? {} : { url }),
            ...(pageTitle === undefined ? {} : { pageTitle }),
            term: trimmedTerm,
            note: item.note,
            ...(item.selectionHint === undefined ? {} : { selectionHint: item.selectionHint }),
            ...(sourceTurn === undefined ? {} : { sourceTurn }),
          });
          if (result.status === 'created') {
            results.push({
              term: trimmedTerm,
              status: 'created',
              annotationId: result.annotationId,
              occurrenceCount: result.occurrenceCount,
            });
          } else {
            results.push({
              term: trimmedTerm,
              status: result.status,
              reason: result.reason,
              message: result.message,
              occurrenceCount: result.occurrenceCount,
              ...(result.suggestedSelectionHints === undefined
                ? {}
                : { suggestedSelectionHints: [...result.suggestedSelectionHints] }),
            });
          }
        } catch (error) {
          results.push({
            term: trimmedTerm,
            status: 'failed',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const createdCount = results.filter((entry) => entry.status === 'created').length;
      const anchorFailedCount = results.filter(
        (entry) => entry.status === 'anchor_failed',
      ).length;
      const failedCount = results.filter(
        (entry) => entry.status === 'failed' || entry.status === 'validation_failed',
      ).length;
      const structured: z.infer<z.ZodObject<typeof batchOutputShape>> = {
        ...(threadId === undefined ? {} : { threadId }),
        ...(url === undefined ? {} : { url }),
        attemptedCount: items.length,
        createdCount,
        anchorFailedCount,
        failedCount,
        items: results,
        createdAt: new Date().toISOString(),
      };
      return {
        content: [{ type: 'text' as const, text: `${JSON.stringify(structured, null, 2)}\n` }],
        structuredContent: structured,
      };
    },
  );
};

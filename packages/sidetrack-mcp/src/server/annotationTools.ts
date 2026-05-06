// Batch annotation tool. Replaces the four-separate-tool-call pattern
// (one bac.create_annotation per term) with a single typed batch that
// takes one URL + pageTitle and a list of {term, note, prefix?, suffix?}
// items. Returns per-item status so partial failures surface cleanly.
//
// Phase-1 contract: items still carry prefix/suffix windows the agent
// extracted from the markdown turn body. Phase 4 changes the contract
// to {term, note, selectionHint?} and moves anchor construction to the
// companion, so the agent stops doing offset arithmetic.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { CompanionWriteClient, SerializedAnchor } from './mcpServer.js';

const TERM_CONTEXT_CHARS = 32;
const TERM_MIN_LEN_WITHOUT_CONTEXT = 6;
const MAX_BATCH = 20;

const annotationItemShape = z.object({
  term: z
    .string()
    .trim()
    .min(1)
    .max(400)
    .describe('Exact term or short quote to highlight on the page.'),
  note: z.string().max(5000).describe('Annotation note to show in Sidetrack.'),
  prefix: z
    .string()
    .max(512)
    .optional()
    .describe('Optional 32-char-cap text immediately before the term.'),
  suffix: z
    .string()
    .max(512)
    .optional()
    .describe('Optional 32-char-cap text immediately after the term.'),
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

const truncatePrefix = (prefix: string | undefined): string =>
  prefix === undefined ? '' : prefix.slice(Math.max(0, prefix.length - TERM_CONTEXT_CHARS));

const truncateSuffix = (suffix: string | undefined): string =>
  suffix === undefined ? '' : suffix.slice(0, TERM_CONTEXT_CHARS);

const buildAnchor = (input: {
  readonly term: string;
  readonly prefix?: string;
  readonly suffix?: string;
}): SerializedAnchor => ({
  textQuote: {
    exact: input.term,
    prefix: truncatePrefix(input.prefix),
    suffix: truncateSuffix(input.suffix),
  },
  textPosition: { start: -1, end: -1 },
  cssSelector: '',
});

export const registerAnnotationTools = (
  server: McpServer,
  companionClient?: CompanionWriteClient,
): void => {
  server.registerTool(
    'sidetrack.annotations.create_batch',
    {
      description:
        'Persist 1..20 term-scoped annotations against a single page URL. Each item is a (term, note, optional prefix, optional suffix). Returns a per-item status array — partial failures surface cleanly without rolling back the successes. Short terms (<6 chars) require either prefix or suffix to disambiguate.',
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
        const hasContext =
          (item.prefix !== undefined && item.prefix.trim().length > 0) ||
          (item.suffix !== undefined && item.suffix.trim().length > 0);
        if (trimmedTerm.length < TERM_MIN_LEN_WITHOUT_CONTEXT && !hasContext) {
          results.push({
            term: trimmedTerm,
            status: 'rejected',
            error: `term shorter than ${String(TERM_MIN_LEN_WITHOUT_CONTEXT)} chars; provide prefix or suffix to disambiguate`,
          });
          continue;
        }
        try {
          const created = await createAnnotation({
            url,
            pageTitle,
            anchor: buildAnchor({
              term: trimmedTerm,
              ...(item.prefix === undefined ? {} : { prefix: item.prefix }),
              ...(item.suffix === undefined ? {} : { suffix: item.suffix }),
            }),
            note: item.note,
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

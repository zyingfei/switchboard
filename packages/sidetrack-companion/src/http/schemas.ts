import { z } from 'zod';

const bacIdSchema = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
const isoDateTimeSchema = z.iso.datetime();
const providerSchema = z.enum(['chatgpt', 'claude', 'gemini', 'codex', 'unknown']);
const dispatchTargetProviderSchema = z.enum([
  'chatgpt',
  'claude',
  'gemini',
  'codex',
  'claude_code',
  'cursor',
  'other',
]);
const dispatchStatusSchema = z.enum(['queued', 'sent', 'replied', 'noted', 'pending', 'failed']);
const reviewVerdictSchema = z.enum(['agree', 'disagree', 'partial', 'needs_source', 'open']);
const reviewOutcomeSchema = z.enum(['save', 'submit_back', 'dispatch_out']);
const tabSnapshotSchema = z.object({
  tabId: z.number().int().optional(),
  windowId: z.number().int().optional(),
  url: z.url(),
  title: z.string().min(1),
  favIconUrl: z.url().optional(),
  capturedAt: isoDateTimeSchema,
});
const checklistItemSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  checked: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
const redactionSummarySchema = z.object({
  matched: z.number().int().nonnegative(),
  categories: z.array(z.string().min(1)),
});

export const serializedAnchorSchema = z.object({
  textQuote: z.object({
    exact: z.string(),
    prefix: z.string(),
    suffix: z.string(),
  }),
  // Negative values mean "no position fallback" — the extension's
  // findAnchor() short-circuits the position branch when start/end
  // are < 0. Used by MCP-created term-scoped anchors that should
  // refuse to fall back to a position match if the term moved.
  textPosition: z.object({
    start: z.number().int(),
    end: z.number().int(),
  }),
  cssSelector: z.string(),
});

export const captureEventSchema = z.object({
  provider: providerSchema,
  threadId: z.string().min(1).optional(),
  threadUrl: z.url(),
  title: z.string().min(1).optional(),
  capturedAt: isoDateTimeSchema,
  selectorCanary: z.enum(['ok', 'warning', 'failed']).optional(),
  extractionConfigVersion: z.string().min(1).optional(),
  visibleTextCharCount: z.number().int().nonnegative().optional(),
  tabSnapshot: tabSnapshotSchema.optional(),
  warnings: z
    .array(
      z.object({
        code: z.enum([
          'possible_api_key',
          'email',
          'internal_url',
          'long_capture',
          'unsupported_provider',
        ]),
        message: z.string().min(1),
        severity: z.enum(['info', 'warning']),
      }),
    )
    .optional(),
  turns: z.array(
    z.object({
      role: z.enum(['user', 'assistant', 'system', 'unknown']),
      text: z.string().min(1),
      formattedText: z.string().min(1).optional(),
      ordinal: z.number().int().nonnegative(),
      capturedAt: isoDateTimeSchema,
      sourceSelector: z.string().min(1).optional(),
      // Per-turn enrichment from `turnEnricher.ts` (extension side).
      // Each field is optional because providers expose different
      // signals — and we'd rather drop a field than reject the
      // whole event when an extractor regresses.
      modelName: z.string().min(1).max(120).optional(),
      markdown: z.string().min(1).optional(),
      reasoning: z.string().min(1).optional(),
      attachments: z
        .array(
          z.object({
            kind: z.enum(['image', 'upload', 'artifact', 'tool']),
            url: z.string().min(1).optional(),
            alt: z.string().max(500).optional(),
            mimeType: z.string().max(120).optional(),
          }),
        )
        .optional(),
      researchReport: z
        .object({
          mode: z.enum(['deep-research', 'gemini-deep-research', 'unknown']),
          citations: z
            .array(
              z.object({
                source: z.string().min(1),
                url: z.string().min(1).optional(),
              }),
            )
            .optional(),
          sections: z.array(z.string().min(1)).optional(),
        })
        .optional(),
    }),
  ),
});

export const threadUpsertSchema = z.object({
  bac_id: bacIdSchema.optional(),
  provider: providerSchema,
  threadId: z.string().min(1).optional(),
  threadUrl: z.url(),
  title: z.string().min(1),
  lastSeenAt: isoDateTimeSchema,
  status: z
    .enum([
      'active',
      'tracked',
      'queued',
      'needs_organize',
      'closed',
      'restorable',
      'archived',
      'removed',
    ])
    .optional(),
  primaryWorkstreamId: bacIdSchema.optional(),
  tags: z.array(z.string()).optional(),
  trackingMode: z.enum(['auto', 'manual', 'stopped', 'removed']).optional(),
  tabSnapshot: tabSnapshotSchema.optional(),
});

export const workstreamCreateSchema = z.object({
  title: z.string().min(1),
  parentId: bacIdSchema.optional(),
  privacy: z.enum(['private', 'shared', 'public']).optional(),
  screenShareSensitive: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  children: z.array(bacIdSchema).optional(),
  checklist: z.array(checklistItemSchema).optional(),
  // Free-form text the user can curate for the suggester. Surfaces
  // through buildSignals as `${title} ${description}` for both the
  // lexical match (token + trigram) and the cold-start vector
  // centroid embedding. Useful for cross-language hints (e.g. add
  // English+Chinese keywords on a "travel" workstream so foreign-
  // language threads get matched without waiting for a multilingual
  // embedder to bridge the gap on its own).
  description: z.string().optional(),
});

export const workstreamUpdateSchema = z.object({
  revision: z.string().min(1),
  title: z.string().min(1).optional(),
  parentId: bacIdSchema.optional(),
  privacy: z.enum(['private', 'shared', 'public']).optional(),
  screenShareSensitive: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  children: z.array(bacIdSchema).optional(),
  checklist: z.array(checklistItemSchema).optional(),
  description: z.string().optional(),
});

export const queueCreateSchema = z.object({
  text: z.string().min(1),
  scope: z.enum(['thread', 'workstream', 'global']),
  targetId: bacIdSchema.optional(),
  status: z.enum(['pending', 'done', 'dismissed']).optional(),
});

export const reminderCreateSchema = z.object({
  threadId: bacIdSchema,
  provider: providerSchema,
  detectedAt: isoDateTimeSchema,
  status: z.enum(['new', 'seen', 'relevant', 'dismissed']).optional(),
});

export const reminderUpdateSchema = z.object({
  revision: z.string().min(1).optional(),
  status: z.enum(['new', 'seen', 'relevant', 'dismissed']).optional(),
});

const codingToolSchema = z.enum(['claude_code', 'codex', 'cursor', 'other']);

export const codingAttachTokenCreateSchema = z.object({
  workstreamId: bacIdSchema.optional(),
});

export const codingAttachTokenSchema = z.object({
  token: z.string().min(8).max(64),
  workstreamId: bacIdSchema.optional(),
  createdAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
});

export const codingSessionRegisterSchema = z.object({
  token: z.string().min(8).max(64),
  tool: codingToolSchema,
  cwd: z.string().min(1),
  branch: z.string().min(1),
  sessionId: z.string().min(1),
  name: z.string().min(1),
  resumeCommand: z.string().min(1).optional(),
});

export const codingSessionSchema = z.object({
  bac_id: bacIdSchema,
  workstreamId: bacIdSchema.optional(),
  tool: codingToolSchema,
  cwd: z.string().min(1),
  branch: z.string().min(1),
  sessionId: z.string().min(1),
  name: z.string().min(1),
  resumeCommand: z.string().min(1).optional(),
  attachedAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
  status: z.enum(['attached', 'detached']),
});

export const codingSessionListQuerySchema = z.object({
  token: z.string().min(8).max(64).optional(),
  workstreamId: bacIdSchema.optional(),
});

export const dispatchEventSchema = z.object({
  bac_id: bacIdSchema.optional(),
  kind: z.enum(['research', 'review', 'coding', 'note', 'other']),
  target: z.object({
    provider: dispatchTargetProviderSchema,
    mode: z.enum(['paste', 'auto-send']),
  }),
  sourceThreadId: z.string().min(1).optional(),
  workstreamId: z.string().min(1).optional(),
  title: z.string().min(1),
  body: z.string().min(1),
  createdAt: isoDateTimeSchema.optional(),
  redactionSummary: redactionSummarySchema.optional(),
  tokenEstimate: z.number().int().nonnegative().optional(),
  status: dispatchStatusSchema.default('sent'),
  mcpRequest: z
    .object({
      codingSessionId: bacIdSchema,
      approval: z.literal('auto-approved'),
      requestedAt: isoDateTimeSchema,
    })
    .optional(),
});

export const dispatchEventRecordSchema = dispatchEventSchema.extend({
  bac_id: bacIdSchema,
  createdAt: isoDateTimeSchema,
  redactionSummary: redactionSummarySchema,
  tokenEstimate: z.number().int().nonnegative(),
});

// Persisted record in `_BAC/dispatch-links/<YYYY-MM-DD>.jsonl`.
// Append-only; later records for the same dispatchId override earlier
// ones on read. Companion is the authoritative store after Phase 3
// of the spec-aligned refactor.
export const dispatchLinkSchema = z.object({
  dispatchId: bacIdSchema,
  threadId: bacIdSchema,
  linkedAt: isoDateTimeSchema,
});

export const dispatchLinkRequestSchema = z.object({
  threadId: bacIdSchema,
});

const providerOptInSchema = z.object({
  chatgpt: z.boolean(),
  claude: z.boolean(),
  gemini: z.boolean(),
});

export const settingsDocumentSchema = z.object({
  autoSendOptIn: providerOptInSchema,
  defaultPacketKind: z.enum(['research', 'review', 'coding', 'note', 'other']),
  defaultDispatchTarget: dispatchTargetProviderSchema,
  screenShareSafeMode: z.boolean(),
  revision: z.string().min(1),
});

export const settingsPatchSchema = z.object({
  revision: z.string().min(1),
  autoSendOptIn: providerOptInSchema.partial().optional(),
  defaultPacketKind: settingsDocumentSchema.shape.defaultPacketKind.optional(),
  defaultDispatchTarget: settingsDocumentSchema.shape.defaultDispatchTarget.optional(),
  screenShareSafeMode: z.boolean().optional(),
});

export const reviewEventSchema = z.object({
  bac_id: bacIdSchema.optional(),
  sourceThreadId: z.string().min(1),
  sourceTurnOrdinal: z.number().int().nonnegative(),
  provider: providerSchema,
  verdict: reviewVerdictSchema,
  reviewerNote: z.string().min(1),
  spans: z.array(
    z.object({
      id: z.string().min(1),
      text: z.string().min(1),
      comment: z.string().min(1),
      capturedAt: isoDateTimeSchema.optional(),
    }),
  ),
  outcome: reviewOutcomeSchema,
  createdAt: isoDateTimeSchema.optional(),
});

export const reviewEventRecordSchema = reviewEventSchema.extend({
  bac_id: bacIdSchema,
  createdAt: isoDateTimeSchema,
});

export const dispatchListQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .transform((limit) => Math.min(limit ?? 25, 100)),
  since: isoDateTimeSchema.optional(),
});

export const auditEventSchema = z.object({
  requestId: z.string().min(1),
  route: z.string().min(1),
  outcome: z.enum(['success', 'failure']),
  bac_id: z.string().min(1).optional(),
  timestamp: isoDateTimeSchema,
});

export const auditListQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .transform((limit) => Math.min(limit ?? 20, 100)),
  since: isoDateTimeSchema.optional(),
});

export const reviewListQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .transform((limit) => Math.min(limit ?? 25, 100)),
  since: isoDateTimeSchema.optional(),
  threadId: bacIdSchema.optional(),
});

export const turnsQuerySchema = z.object({
  threadUrl: z.url(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .transform((limit) => Math.min(limit ?? 5, 50)),
  role: z.enum(['user', 'assistant', 'system', 'unknown']).optional(),
});

export const turnRecordSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'unknown']),
  text: z.string().min(1),
  formattedText: z.string().min(1).optional(),
  ordinal: z.number().int().nonnegative(),
  capturedAt: isoDateTimeSchema,
  sourceSelector: z.string().min(1).optional(),
});

// Two ways to create an annotation:
//   1. Anchor-form (DOM-driven): the caller serialised a Range and
//      sends the full anchor. Used by the side panel's per-turn
//      composer and other in-DOM selection paths.
//   2. Term-form (intent-driven, Phase 4): the caller provides the
//      keyword and lets the companion compute the anchor from the
//      thread's assistant turn body. Used by MCP-side agents — the
//      agent doesn't have the live DOM, only the markdown turn body
//      stored on the companion, so making the companion build the
//      anchor avoids markdown↔DOM offset divergence on the read side.
const annotationCreateAnchorSchema = z.object({
  url: z.url(),
  pageTitle: z.string().min(1),
  anchor: serializedAnchorSchema,
  note: z.string(),
});

const annotationCreateTermSchema = z.object({
  url: z.url(),
  pageTitle: z.string().min(1),
  term: z.string().min(1).max(400),
  // Optional — when omitted, the companion uses the request `url` as
  // the thread URL for the turn-text lookup. ChatGPT, Claude, and
  // Gemini all serve thread pages on stable URLs that already match
  // the canonical threadUrl, so this is the typical case.
  threadId: z.string().min(1).optional(),
  threadUrl: z.url().optional(),
  selectionHint: z.string().max(512).optional(),
  note: z.string(),
});

export const annotationCreateSchema = z.union([
  annotationCreateAnchorSchema,
  annotationCreateTermSchema,
]);

export const annotationListQuerySchema = z.object({
  url: z.url().optional(),
  includeDeleted: z.coerce.boolean().optional().default(false),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .transform((limit) => Math.min(limit ?? 100, 100)),
});

export const annotationUpdateSchema = z.object({
  note: z.string(),
});

export const recallIndexSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1),
      threadId: z.string().min(1),
      capturedAt: isoDateTimeSchema,
      text: z.string().min(1),
    }),
  ),
});

export const recallGcSchema = z.object({
  validIds: z.array(z.string().min(1)),
});

export const recallQuerySchema = z.object({
  q: z.string().min(1),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .transform((limit) => Math.min(limit ?? 10, 50)),
  workstreamId: bacIdSchema.optional(),
});

export const suggestionQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .transform((limit) => Math.min(limit ?? 5, 20)),
  // Per-request threshold override — clamped [0, 1]. Defaults to
  // SIDETRACK_SUGGEST_THRESHOLD env (or 0.35 if unset). Lets the UI
  // ask for a lower bar on explicit refresh, and lets debug probes
  // pass `threshold=0` to see the raw score breakdown.
  threshold: z.coerce.number().min(0).max(1).optional(),
});

export const autoUpdateSchema = z.object({
  confirm: z.string().min(1),
});

export const bucketSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  vaultRoot: z.string().min(1),
  matchers: z.array(
    z.object({
      kind: z.enum(['workstream', 'provider', 'urlPattern']),
      value: z.string().min(1),
    }),
  ),
});

export const bucketsPutSchema = z.object({
  buckets: z.array(bucketSchema),
});

export const workstreamTrustPutSchema = z.object({
  allowedTools: z.array(
    z.enum([
      'sidetrack.threads.move',
      'sidetrack.queue.create',
      'sidetrack.workstreams.bump',
      'sidetrack.threads.archive',
      'sidetrack.threads.unarchive',
    ]),
  ),
});

export type CaptureEventInput = z.infer<typeof captureEventSchema>;
export type ThreadUpsertInput = z.infer<typeof threadUpsertSchema>;
export type WorkstreamCreateInput = z.infer<typeof workstreamCreateSchema>;
export type WorkstreamUpdateInput = z.infer<typeof workstreamUpdateSchema>;
export type QueueCreateInput = z.infer<typeof queueCreateSchema>;
export type ReminderCreateInput = z.infer<typeof reminderCreateSchema>;
export type ReminderUpdateInput = z.infer<typeof reminderUpdateSchema>;
export type DispatchEventInput = z.infer<typeof dispatchEventSchema>;
export type DispatchEventRecord = z.infer<typeof dispatchEventRecordSchema>;
export type DispatchListQuery = z.infer<typeof dispatchListQuerySchema>;
export type DispatchLinkRecord = z.infer<typeof dispatchLinkSchema>;
export type DispatchLinkRequest = z.infer<typeof dispatchLinkRequestSchema>;
export type AuditEventRecord = z.infer<typeof auditEventSchema>;
export type AuditListQuery = z.infer<typeof auditListQuerySchema>;
export type SettingsDocument = z.infer<typeof settingsDocumentSchema>;
export type SettingsPatchInput = z.infer<typeof settingsPatchSchema>;
export type ReviewEventInput = z.infer<typeof reviewEventSchema>;
export type ReviewEvent = z.infer<typeof reviewEventRecordSchema>;
export type ReviewListQuery = z.infer<typeof reviewListQuerySchema>;
export type TurnsQuery = z.infer<typeof turnsQuerySchema>;
export type TurnRecord = z.infer<typeof turnRecordSchema>;
export type SerializedAnchor = z.infer<typeof serializedAnchorSchema>;
export type AnnotationCreateInput = z.infer<typeof annotationCreateSchema>;
export type AnnotationListQuery = z.infer<typeof annotationListQuerySchema>;
export type RecallIndexInput = z.infer<typeof recallIndexSchema>;
export type RecallQuery = z.infer<typeof recallQuerySchema>;
export type SuggestionQuery = z.infer<typeof suggestionQuerySchema>;
export type BucketRecord = z.infer<typeof bucketSchema>;
export type CodingTool = z.infer<typeof codingToolSchema>;
export type CodingAttachTokenCreateInput = z.infer<typeof codingAttachTokenCreateSchema>;
export type CodingAttachTokenRecord = z.infer<typeof codingAttachTokenSchema>;
export type CodingSessionRegisterInput = z.infer<typeof codingSessionRegisterSchema>;
export type CodingSessionRecord = z.infer<typeof codingSessionSchema>;
export type CodingSessionListQuery = z.infer<typeof codingSessionListQuerySchema>;

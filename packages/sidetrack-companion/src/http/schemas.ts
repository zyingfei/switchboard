import { z } from 'zod';

const bacIdSchema = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
const isoDateTimeSchema = z.iso.datetime();
const providerSchema = z.enum(['chatgpt', 'claude', 'gemini', 'unknown']);
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
});

export const dispatchEventRecordSchema = dispatchEventSchema.extend({
  bac_id: bacIdSchema,
  createdAt: isoDateTimeSchema,
  redactionSummary: redactionSummarySchema,
  tokenEstimate: z.number().int().nonnegative(),
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
export type SettingsDocument = z.infer<typeof settingsDocumentSchema>;
export type SettingsPatchInput = z.infer<typeof settingsPatchSchema>;
export type ReviewEventInput = z.infer<typeof reviewEventSchema>;
export type ReviewEvent = z.infer<typeof reviewEventRecordSchema>;
export type ReviewListQuery = z.infer<typeof reviewListQuerySchema>;
export type TurnsQuery = z.infer<typeof turnsQuerySchema>;
export type TurnRecord = z.infer<typeof turnRecordSchema>;
export type CodingTool = z.infer<typeof codingToolSchema>;
export type CodingAttachTokenCreateInput = z.infer<typeof codingAttachTokenCreateSchema>;
export type CodingAttachTokenRecord = z.infer<typeof codingAttachTokenSchema>;
export type CodingSessionRegisterInput = z.infer<typeof codingSessionRegisterSchema>;
export type CodingSessionRecord = z.infer<typeof codingSessionSchema>;
export type CodingSessionListQuery = z.infer<typeof codingSessionListQuerySchema>;

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
  tags: z.array(z.string()).optional(),
  children: z.array(bacIdSchema).optional(),
  checklist: z.array(checklistItemSchema).optional(),
});

export const workstreamUpdateSchema = z.object({
  revision: z.string().min(1),
  title: z.string().min(1).optional(),
  parentId: bacIdSchema.optional(),
  privacy: z.enum(['private', 'shared', 'public']).optional(),
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

export const dispatchListQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .transform((limit) => Math.min(limit ?? 25, 100)),
  since: isoDateTimeSchema.optional(),
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

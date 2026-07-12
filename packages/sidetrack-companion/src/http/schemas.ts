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
  // Surface of the most recent assistant turn — `deep-research` /
  // `gemini-deep-research` flag the long-form research surface so
  // the side panel and md sidecar can show "Deep Research" rather
  // than just "active". Sourced from the per-turn `researchReport`
  // enrichment; absent for ordinary threads.
  lastResearchMode: z.enum(['deep-research', 'gemini-deep-research', 'unknown']).optional(),
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
  // string = re-parent under that bac_id.
  // null   = detach to top-level (writer drops the parentId field
  //          from the record and removes self from the previous
  //          parent's children).
  // omitted = leave parent unchanged.
  parentId: bacIdSchema.nullable().optional(),
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

// §13 step 13 — user-facing Markdown export. The workstream variant may
// also project its threads; the thread variant takes no body options.
// Body is optional (empty POST ⇒ includeThreads defaults off).
export const workstreamExportSchema = z.object({
  includeThreads: z.boolean().optional(),
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
  // F02 audit provenance. All optional so JSONL lines written before
  // this landed (which lack these fields) still parse — old audit
  // history stays readable. Newer write sites populate every field.
  //   agent          — caller class, e.g. 'mcp:<client-name>' | 'extension'.
  //   tool           — the MCP write tool that drove the write, else null.
  //   argsSummary    — bounded, redaction-safe description of the call;
  //                    NEVER the full request payload.
  //   scope          — workstream id the write was trust-scoped to, else null.
  //   trustModeActive — whether workstream-trust enforcement gated this call.
  agent: z.string().min(1).optional(),
  tool: z.string().min(1).nullable().optional(),
  argsSummary: z.string().max(500).optional(),
  scope: z.string().min(1).nullable().optional(),
  trustModeActive: z.boolean().optional(),
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

const reviewDraftEventTypeSchema = z.enum([
  'review-draft.span.added',
  'review-draft.span.removed',
  'review-draft.comment.set',
  'review-draft.overall.set',
  'review-draft.verdict.set',
  'review-draft.discarded',
]);

const versionVectorSchema = z.record(z.string(), z.number().int().nonnegative());

// Conversation-level addressing for events that touch chat content.
// Two replicas observing different snapshots of the same thread can
// emit events with different `messageId` / `quoteHash` so the
// projection layer can decide whether they're "the same fact" or
// distinct. All fields are optional; clients fill what they have.
export const targetRefSchema = z
  .object({
    provider: z.string().min(1).optional(),
    canonicalUrl: z.url().optional(),
    conversationId: z.string().min(1).optional(),
    messageId: z.string().min(1).optional(),
    turnOrdinal: z.number().int().nonnegative().optional(),
    role: z.enum(['user', 'assistant', 'system']).optional(),
    quoteHash: z.string().min(1).optional(),
    anchorFingerprint: z.string().min(1).optional(),
    sourceSnapshotHash: z.string().min(1).optional(),
  })
  .strict();

// Browser-shaped client event: carries the projection vector the
// editor observed (`baseVector`) plus optional `clientDeps` so a
// batch can express "this edit depends on this earlier edit in the
// same POST." The companion stamps `dot`, `deps`, and `acceptedAtMs`
// on accept.
export const reviewDraftClientEventSchema = z.object({
  clientEventId: z.string().min(1),
  type: reviewDraftEventTypeSchema,
  payload: z.record(z.string(), z.unknown()).optional(),
  target: targetRefSchema.optional(),
  baseVector: versionVectorSchema.optional(),
  clientDeps: z.array(z.string().min(1)).optional(),
  clientCreatedAtMs: z.number().int().nonnegative().optional(),
});

export const reviewDraftEventBatchSchema = z.object({
  threadUrl: z.url().optional(),
  events: z.array(reviewDraftClientEventSchema).min(1).max(64),
});

export const reviewDraftListQuerySchema = z.object({
  since: z.coerce.number().int().nonnegative().optional(),
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

// Term-form input. Either `threadId` or `url` must be present —
// threadId is preferred (the companion looks the thread record up
// and resolves both threadUrl + pageTitle); url is the legacy
// shortcut for "annotate the page at this URL", used when the
// caller has no threadId.
const annotationSourceTurnSchema = z.union([
  z.literal('assistant_latest'),
  z.literal('assistant_all'),
  z.object({ ordinal: z.number().int().nonnegative() }),
]);

const annotationAnchorPolicySchema = z.object({
  repeatedTerm: z.enum(['first', 'require_hint']).optional(),
  shortTermMinLength: z.number().int().positive().max(64).optional(),
});

const annotationCreateTermSchema = z
  .object({
    threadId: z.string().min(1).optional(),
    url: z.url().optional(),
    pageTitle: z.string().min(1).optional(),
    term: z.string().min(1).max(400),
    selectionHint: z.string().max(512).optional(),
    sourceTurn: annotationSourceTurnSchema.optional(),
    anchorPolicy: annotationAnchorPolicySchema.optional(),
    note: z.string(),
  })
  .refine((value) => value.threadId !== undefined || value.url !== undefined, {
    message: 'Either threadId or url is required when term is present.',
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

// Recall v2 (POST /v2/recall) request validation. Mirrors the
// `RecallRequest` interface in recall-v2/types.ts — keep them in sync.
// Unknown fields are stripped (z.object() drops unknown keys by
// default in v4); enum arrays prevent caller-injected typos from
// silently changing source-fanout behavior.
const recallV2SourceKindSchema = z.enum([
  'page_content',
  'timeline_visit',
  'chat_turn',
  'semantic_query',
  'graph_neighbor',
  'current_session',
  'focus',
]);

// Scope B — named retrieval intents. Each intent picks default
// source profile + suppression posture inside the pipeline. The
// schema validates the input string and rejects anything else
// loudly (we'd rather a typo 400 than silently re-route to dejavu).
const recallV2IntentSchema = z.enum(['dejavu', 'search', 'focus']);

const recallV2RetrieverSchema = z.enum([
  'bm25',
  'fts5',
  'dense',
  'sparse',
  'rrf',
  'rerank',
  'fts5-local',
]);
// retriever isn't used in the request, but exported here for
// completeness so the type-side stays cohesive when we add request
// fields that reference it.
void recallV2RetrieverSchema;

const recallV2SuppressionPolicySchema = z
  .object({
    suppressCurrentPage: z.enum(['always', 'never', 'unless-discussion']).optional(),
    suppressActiveChatBacIds: z.array(z.string().min(1)).max(64).optional(),
    suppressAskAiArtifacts: z.boolean().optional(),
    minHitAgeMs: z.number().int().nonnegative().max(86_400_000).optional(),
    excludeEntityIds: z.array(z.string().min(1)).max(1000).optional(),
    surfaceCurrentSessionAsFacet: z.boolean().optional(),
  })
  .strict();

const recallV2StrategySchema = z
  .object({
    fusion: z.enum(['rrf', 'weighted_rrf', 'normalized_score']).optional(),
    rerankTopK: z.number().int().nonnegative().max(50).optional(),
    explain: z.boolean().optional(),
    debug: z.boolean().optional(),
  })
  .strict();

const recallV2SessionSchema = z
  .object({
    sessionId: z.string().min(1).max(256).optional(),
    currentUrl: z.string().min(1).max(2048).optional(),
    currentThreadId: z.string().min(1).max(256).optional(),
    activeChatBacIds: z.array(z.string().min(1)).max(64).optional(),
    excludeEntityIds: z.array(z.string().min(1)).max(1000).optional(),
  })
  .strict();

const recallV2FiltersSchema = z
  .object({
    hosts: z.array(z.string().min(1).max(255)).max(64).optional(),
    sourceKinds: z.array(recallV2SourceKindSchema).max(8).optional(),
    timeFrom: z.string().min(1).max(64).optional(),
    timeTo: z.string().min(1).max(64).optional(),
    workstreamId: z.string().min(1).max(128).optional(),
  })
  .strict();

export const recallV2RequestSchema = z
  .object({
    // The `focus` intent (Now card) passes an empty q because the
    // anchor is `session.currentUrl`, not a typed query. So accept
    // the empty string here — pre-Zod behavior is preserved by the
    // pipeline's `composeLexicalQuery` which itself returns "" for
    // empty input and downstream lexical generators short-circuit
    // on empty queries.
    q: z.string().max(8192),
    intent: recallV2IntentSchema.optional(),
    limit: z.number().int().positive().max(50).optional(),
    perSourceLimit: z.number().int().positive().max(50).optional(),
    sources: z.array(recallV2SourceKindSchema).max(8).optional(),
    session: recallV2SessionSchema.optional(),
    filters: recallV2FiltersSchema.optional(),
    suppression: recallV2SuppressionPolicySchema.optional(),
    strategy: recallV2StrategySchema.optional(),
  })
  .strict();

export const contentQuerySchema = z.object({
  q: z.string().min(1),
  sourceKind: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined
        ? // W4(b-lite): semantic-recall-pool is in the default set so
          // it expands query candidates by default; the runtime flag
          // SIDETRACK_ENABLE_SEMANTIC_RECALL_POOL is the one-step off.
          // P1 (2026-05-24): timeline-visit added so visited pages
          // with title-only evidence (no body extraction — e.g. HN
          // item pages where Readability bails, Google SERPs, any
          // URL the user only briefly visited) still surface in
          // recall instead of being invisible.
          ([
            'page-content',
            'chat-turn',
            'semantic-recall-pool',
            'timeline-visit',
          ] as const)
        : value
            .split(',')
            .map((entry) => entry.trim())
            .filter(
              (
                entry,
              ): entry is
                | 'page-content'
                | 'chat-turn'
                | 'semantic-recall-pool'
                | 'timeline-visit' =>
                entry === 'page-content' ||
                entry === 'chat-turn' ||
                entry === 'semantic-recall-pool' ||
                entry === 'timeline-visit',
            ),
    ),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .transform((limit) => Math.min(limit ?? 20, 50)),
  workstreamId: bacIdSchema.optional(),
});

export const pageContentCoverageQuerySchema = z.object({
  canonicalUrl: z.url(),
});

const pageContentExtractionStrategySchema = z.enum([
  'manual-selection',
  'reader-mode',
  'visible-dom',
]);

const pageContentQualitySchema = z.enum(['high', 'medium', 'low']);

export const pageContentExtractedSchema = z.object({
  payloadVersion: z.literal(1),
  canonicalUrl: z.url(),
  url: z.url(),
  title: z.string().optional(),
  provider: z.string().optional(),
  extractedAt: isoDateTimeSchema,
  extractionSource: pageContentExtractionStrategySchema,
  extractionPolicy: z.object({
    trigger: z.enum([
      'manual',
      'workstream-policy',
      'save-suggestion',
      'allowlist',
      'auto-observed',
      'attention-gate',
      'bulk-open-tabs',
    ]),
    workstreamId: z.string().optional(),
    domainPolicyId: z.string().optional(),
  }),
  quality: pageContentQualitySchema,
  qualitySignals: z.object({
    extractedWordCount: z.number().int().nonnegative(),
    contentToDomRatio: z.number().nonnegative(),
    boilerplateFraction: z.number().nonnegative(),
    extractionStrategy: pageContentExtractionStrategySchema,
    headingSignatureHash: z.string().optional(),
  }),
  content: z.object({
    text: z.string().min(1),
    markdown: z.string().optional(),
    contentHash: z.string().min(1),
    charCount: z.number().int().nonnegative(),
  }),
  redaction: z
    .object({
      applied: z.boolean(),
      rules: z.array(z.string()),
    })
    .optional(),
  dimensions: z.record(z.string(), z.unknown()).optional(),
});

export const pageEvidenceExtractedSchema = pageContentExtractedSchema.extend({
  storageMode: z.enum(['features_only', 'indexed_chunks']),
});

export const pageContentTombstonedSchema = z.object({
  payloadVersion: z.literal(1),
  canonicalUrl: z.url(),
  tombstonedAt: isoDateTimeSchema,
  reason: z.enum(['user-delete', 'policy-revoked', 'retention-expired', 'quality-reject']),
  contentHash: z.string().optional(),
  dimensions: z.record(z.string(), z.unknown()).optional(),
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
export type RecallV2Request = z.infer<typeof recallV2RequestSchema>;
export type SuggestionQuery = z.infer<typeof suggestionQuerySchema>;
export type BucketRecord = z.infer<typeof bucketSchema>;
export type CodingTool = z.infer<typeof codingToolSchema>;
export type CodingAttachTokenCreateInput = z.infer<typeof codingAttachTokenCreateSchema>;
export type CodingAttachTokenRecord = z.infer<typeof codingAttachTokenSchema>;
export type CodingSessionRegisterInput = z.infer<typeof codingSessionRegisterSchema>;
export type CodingSessionRecord = z.infer<typeof codingSessionSchema>;
export type CodingSessionListQuery = z.infer<typeof codingSessionListQuerySchema>;

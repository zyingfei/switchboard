import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { z } from 'zod';

const threadSchema = z
  .object({
    bac_id: z.string(),
    provider: z.string().optional(),
    threadId: z.string().optional(),
    threadUrl: z.string().optional(),
    title: z.string().optional(),
    lastSeenAt: z.string().optional(),
    status: z.string().optional(),
    primaryWorkstreamId: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .loose();

const workstreamSchema = z
  .object({
    bac_id: z.string(),
    title: z.string().optional(),
    parentId: z.string().optional(),
    children: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    checklist: z.array(z.unknown()).optional(),
    privacy: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .loose();

const queueItemSchema = z
  .object({
    bac_id: z.string(),
    text: z.string().optional(),
    scope: z.string().optional(),
    targetId: z.string().optional(),
    status: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .loose();

const reminderSchema = z
  .object({
    bac_id: z.string(),
    threadId: z.string().optional(),
    provider: z.string().optional(),
    detectedAt: z.string().optional(),
    status: z.string().optional(),
  })
  .loose();

const bacIdSchema = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/u);
const isoDateTimeSchema = z.iso.datetime();

const dispatchEventSchema = z.object({
  bac_id: bacIdSchema,
  kind: z.enum(['research', 'review', 'coding', 'note', 'other']),
  target: z.object({
    provider: z.enum(['chatgpt', 'claude', 'gemini', 'codex', 'claude_code', 'cursor', 'other']),
    mode: z.enum(['paste', 'auto-send']),
  }),
  sourceThreadId: z.string().min(1).optional(),
  workstreamId: z.string().min(1).optional(),
  title: z.string().min(1),
  body: z.string().min(1),
  createdAt: isoDateTimeSchema,
  redactionSummary: z.object({
    matched: z.number().int().nonnegative(),
    categories: z.array(z.string().min(1)),
  }),
  tokenEstimate: z.number().int().nonnegative(),
  status: z.enum(['queued', 'sent', 'replied', 'noted', 'pending', 'failed']),
});

const reviewVerdictSchema = z.enum(['agree', 'disagree', 'partial', 'needs_source', 'open']);

const reviewEventSchema = z.object({
  bac_id: bacIdSchema,
  sourceThreadId: z.string().min(1),
  sourceTurnOrdinal: z.number().int().nonnegative(),
  provider: z.enum(['chatgpt', 'claude', 'gemini', 'unknown']),
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
  outcome: z.enum(['save', 'submit_back', 'dispatch_out']),
  createdAt: isoDateTimeSchema,
});

export type ThreadRecord = z.infer<typeof threadSchema>;
export type WorkstreamRecord = z.infer<typeof workstreamSchema>;
export type QueueItemRecord = z.infer<typeof queueItemSchema>;
export type ReminderRecord = z.infer<typeof reminderSchema>;
export type DispatchEvent = z.infer<typeof dispatchEventSchema>;
export type ReviewEvent = z.infer<typeof reviewEventSchema>;

const turnRoleSchema = z.enum(['user', 'assistant', 'system', 'unknown']);

const captureEventSchema = z.object({
  threadUrl: z.url(),
  capturedAt: isoDateTimeSchema,
  turns: z.array(
    z.object({
      role: turnRoleSchema,
      text: z.string().min(1),
      formattedText: z.string().min(1).optional(),
      ordinal: z.number().int().nonnegative(),
      capturedAt: isoDateTimeSchema,
      sourceSelector: z.string().min(1).optional(),
    }),
  ),
});

export type TurnRole = z.infer<typeof turnRoleSchema>;
export type CapturedTurn = z.infer<typeof captureEventSchema>['turns'][number];

export interface DispatchReadOptions {
  readonly limit?: number;
  readonly since?: string;
  readonly workstreamId?: string;
  readonly provider?: string;
}

export interface DispatchReadResult {
  readonly data: readonly DispatchEvent[];
  readonly cursor?: string;
}

export interface ReviewReadOptions {
  readonly limit?: number;
  readonly since?: string;
  readonly threadId?: string;
  readonly verdict?: ReviewEvent['verdict'];
}

export interface ReviewReadResult {
  readonly data: readonly ReviewEvent[];
  readonly cursor?: string;
}

export interface TurnsReadOptions {
  readonly threadUrl: string;
  readonly limit?: number;
  readonly role?: TurnRole;
}

export interface TurnsReadResult {
  readonly data: readonly CapturedTurn[];
  readonly cursor?: string;
}

export interface LiveVaultSnapshot {
  readonly threads: readonly ThreadRecord[];
  readonly workstreams: readonly WorkstreamRecord[];
  readonly queueItems: readonly QueueItemRecord[];
  readonly reminders: readonly ReminderRecord[];
  readonly events: readonly Record<string, unknown>[];
  readonly generatedAt: string;
}

const ensureInsideRoot = (rootPath: string, childPath: string): string => {
  const resolvedRoot = resolve(rootPath);
  const resolvedChild = resolve(resolvedRoot, childPath);
  const childRelative = relative(resolvedRoot, resolvedChild);
  if (childRelative.startsWith('..')) {
    throw new Error(`Vault path escapes root: ${childPath}`);
  }
  return resolvedChild;
};

const readJsonDirectory = async <TValue>(
  rootPath: string,
  directory: string,
  schema: z.ZodType<TValue>,
): Promise<TValue[]> => {
  const absoluteDirectory = ensureInsideRoot(rootPath, directory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true }).catch(() => []);
  const values: TValue[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    const raw = await readFile(join(absoluteDirectory, entry.name), 'utf8');
    values.push(schema.parse(JSON.parse(raw) as unknown));
  }

  return values;
};

const readEventLogs = async (rootPath: string): Promise<Record<string, unknown>[]> => {
  const eventDirectory = ensureInsideRoot(rootPath, '_BAC/events');
  const entries = await readdir(eventDirectory, { withFileTypes: true }).catch(() => []);
  const events: Record<string, unknown>[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue;
    }
    const raw = await readFile(join(eventDirectory, entry.name), 'utf8');
    raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .forEach((line) => {
        const parsed = JSON.parse(line) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          events.push(parsed as Record<string, unknown>);
        }
      });
  }

  return events;
};

const parseDispatchLine = (line: string): DispatchEvent | undefined => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const result = dispatchEventSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
};

const readDispatchFile = async (path: string): Promise<DispatchEvent[]> => {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .map(parseDispatchLine)
    .filter((event): event is DispatchEvent => event !== undefined);
};

const parseReviewLine = (line: string): ReviewEvent | undefined => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const result = reviewEventSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
};

const parseEventLine = (line: string): z.infer<typeof captureEventSchema> | undefined => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const result = captureEventSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
};

const readEventFile = async (path: string): Promise<z.infer<typeof captureEventSchema>[]> => {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .map(parseEventLine)
    .filter((event): event is z.infer<typeof captureEventSchema> => event !== undefined);
};

const readReviewFile = async (path: string): Promise<ReviewEvent[]> => {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .map(parseReviewLine)
    .filter((event): event is ReviewEvent => event !== undefined);
};

export class LiveVaultReader {
  constructor(private readonly vaultPath: string) {}

  async readSnapshot(): Promise<LiveVaultSnapshot> {
    const [threads, workstreams, queueItems, reminders, events] = await Promise.all([
      readJsonDirectory(this.vaultPath, '_BAC/threads', threadSchema),
      readJsonDirectory(this.vaultPath, '_BAC/workstreams', workstreamSchema),
      readJsonDirectory(this.vaultPath, '_BAC/queue', queueItemSchema),
      readJsonDirectory(this.vaultPath, '_BAC/reminders', reminderSchema),
      readEventLogs(this.vaultPath),
    ]);

    return {
      threads: threads.sort((left, right) =>
        (right.lastSeenAt ?? '').localeCompare(left.lastSeenAt ?? ''),
      ),
      workstreams,
      queueItems,
      reminders,
      events,
      generatedAt: new Date().toISOString(),
    };
  }

  async readDispatches(options: DispatchReadOptions = {}): Promise<DispatchReadResult> {
    const dispatchDirectory = ensureInsideRoot(this.vaultPath, '_BAC/dispatches');
    const entries = await readdir(dispatchDirectory, { withFileTypes: true }).catch(() => []);
    const limit = Math.min(options.limit ?? 25, 100);
    const sinceMillis = options.since === undefined ? undefined : Date.parse(options.since);
    const events = (
      await Promise.all(
        entries
          .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(entry.name))
          .sort((left, right) => right.name.localeCompare(left.name))
          .slice(0, 100)
          .map((entry) => readDispatchFile(join(dispatchDirectory, entry.name))),
      )
    ).flat();

    return {
      data: events
        .filter(
          (event) =>
            (sinceMillis === undefined || Date.parse(event.createdAt) >= sinceMillis) &&
            (options.workstreamId === undefined || event.workstreamId === options.workstreamId) &&
            (options.provider === undefined || event.target.provider === options.provider),
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit),
    };
  }

  async readTurns(options: TurnsReadOptions): Promise<TurnsReadResult> {
    const eventsDirectory = ensureInsideRoot(this.vaultPath, '_BAC/events');
    const entries = await readdir(eventsDirectory, { withFileTypes: true }).catch(() => []);
    const limit = Math.min(options.limit ?? 5, 50);
    const dedupe = new Map<string, CapturedTurn>();
    const sortedFiles = entries
      .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(entry.name))
      .sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of sortedFiles) {
      const fileEvents = await readEventFile(join(eventsDirectory, entry.name));
      for (const event of fileEvents) {
        if (event.threadUrl !== options.threadUrl) {
          continue;
        }
        for (const turn of event.turns) {
          if (options.role !== undefined && turn.role !== options.role) {
            continue;
          }
          const key = `${String(turn.ordinal)}::${turn.role}`;
          const existing = dedupe.get(key);
          if (existing === undefined || existing.capturedAt < turn.capturedAt) {
            dedupe.set(key, turn);
          }
        }
      }
      if (dedupe.size >= limit * 4) {
        break;
      }
    }

    return {
      data: Array.from(dedupe.values())
        .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))
        .slice(0, limit),
    };
  }

  async readReviews(options: ReviewReadOptions = {}): Promise<ReviewReadResult> {
    const reviewDirectory = ensureInsideRoot(this.vaultPath, '_BAC/reviews');
    const entries = await readdir(reviewDirectory, { withFileTypes: true }).catch(() => []);
    const limit = Math.min(options.limit ?? 25, 100);
    const sinceMillis = options.since === undefined ? undefined : Date.parse(options.since);
    const events = (
      await Promise.all(
        entries
          .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(entry.name))
          .sort((left, right) => right.name.localeCompare(left.name))
          .slice(0, 100)
          .map((entry) => readReviewFile(join(reviewDirectory, entry.name))),
      )
    ).flat();

    return {
      data: events
        .filter(
          (event) =>
            (sinceMillis === undefined || Date.parse(event.createdAt) >= sinceMillis) &&
            (options.threadId === undefined || event.sourceThreadId === options.threadId) &&
            (options.verdict === undefined || event.verdict === options.verdict),
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit),
    };
  }
}

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

export type ThreadRecord = z.infer<typeof threadSchema>;
export type WorkstreamRecord = z.infer<typeof workstreamSchema>;
export type QueueItemRecord = z.infer<typeof queueItemSchema>;
export type ReminderRecord = z.infer<typeof reminderSchema>;

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
}

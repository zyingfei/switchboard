import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import { createBacId, createRevision } from '../domain/ids.js';
import {
  parseMarkdownLockSentinel,
  renderPromotedThreadMarkdown,
  renderThreadMarkdown,
  renderWorkstreamMarkdown,
  type ThreadProjectionInput,
  type WorkstreamProjectionInput,
} from './markdownProjection.js';
import {
  captureEventSchema,
  auditEventSchema,
  codingAttachTokenSchema,
  codingSessionSchema,
  dispatchEventRecordSchema,
  dispatchLinkSchema,
  reviewEventRecordSchema,
  settingsDocumentSchema,
} from '../http/schemas.js';
import type {
  AuditEventRecord,
  AuditListQuery,
  CaptureEventInput,
  CodingAttachTokenCreateInput,
  CodingAttachTokenRecord,
  CodingSessionListQuery,
  CodingSessionRecord,
  CodingSessionRegisterInput,
  DispatchEventRecord,
  DispatchLinkRecord,
  DispatchListQuery,
  QueueCreateInput,
  ReminderCreateInput,
  ReminderUpdateInput,
  ReviewEvent,
  ReviewListQuery,
  SettingsDocument,
  SettingsPatchInput,
  ThreadUpsertInput,
  TurnRecord,
  TurnsQuery,
  WorkstreamCreateInput,
  WorkstreamUpdateInput,
} from '../http/schemas.js';

export interface MutationResult {
  readonly bac_id: string;
  readonly revision: string;
}

export class SettingsRevisionConflictError extends Error {
  constructor() {
    super('Settings revision does not match current settings revision.');
    this.name = 'SettingsRevisionConflictError';
  }
}

export class CodingAttachTokenInvalidError extends Error {
  constructor(message = 'Attach token is unknown, expired, or already consumed.') {
    super(message);
    this.name = 'CodingAttachTokenInvalidError';
  }
}

export class CodingSessionNotFoundError extends Error {
  constructor() {
    super('Coding session not found.');
    this.name = 'CodingSessionNotFoundError';
  }
}

export interface AuditEvent {
  readonly requestId: string;
  readonly route: string;
  readonly outcome: 'success' | 'failure';
  readonly bac_id?: string;
  readonly timestamp: string;
}

export interface VaultWriter {
  readonly status: () => Promise<'connected' | 'unreachable'>;
  readonly writeCaptureEvent: (
    input: CaptureEventInput,
    requestId: string,
  ) => Promise<MutationResult>;
  readonly readRecentTurns: (query: TurnsQuery) => Promise<readonly TurnRecord[]>;
  readonly writeDispatchEvent: (
    input: DispatchEventRecord,
    requestId: string,
  ) => Promise<{ readonly bac_id: string; readonly status: 'recorded' }>;
  readonly readDispatchEvents: (
    query: DispatchListQuery,
  ) => Promise<readonly DispatchEventRecord[]>;
  readonly linkDispatchToThread: (
    input: { readonly dispatchId: string; readonly threadId: string },
    requestId: string,
  ) => Promise<DispatchLinkRecord>;
  readonly readLinkForDispatch: (dispatchId: string) => Promise<DispatchLinkRecord | null>;
  readonly readLinksForThread: (threadId: string) => Promise<readonly DispatchLinkRecord[]>;
  readonly readAuditEvents: (query: AuditListQuery) => Promise<readonly AuditEventRecord[]>;
  readonly writeReviewEvent: (
    input: ReviewEvent,
    requestId: string,
  ) => Promise<{ readonly bac_id: string; readonly status: 'recorded' }>;
  readonly readReviewEvents: (query: ReviewListQuery) => Promise<readonly ReviewEvent[]>;
  readonly readSettings: () => Promise<SettingsDocument>;
  readonly updateSettings: (
    patch: SettingsPatchInput,
    revision: string,
  ) => Promise<SettingsDocument>;
  readonly upsertThread: (input: ThreadUpsertInput, requestId: string) => Promise<MutationResult>;
  readonly createWorkstream: (
    input: WorkstreamCreateInput,
    requestId: string,
  ) => Promise<MutationResult>;
  readonly updateWorkstream: (
    workstreamId: string,
    input: WorkstreamUpdateInput,
    requestId: string,
  ) => Promise<MutationResult>;
  readonly createQueueItem: (input: QueueCreateInput, requestId: string) => Promise<MutationResult>;
  readonly createReminder: (
    input: ReminderCreateInput,
    requestId: string,
  ) => Promise<MutationResult>;
  readonly updateReminder: (
    reminderId: string,
    input: ReminderUpdateInput,
    requestId: string,
  ) => Promise<MutationResult>;
  readonly createCodingAttachToken: (
    input: CodingAttachTokenCreateInput,
    requestId: string,
  ) => Promise<CodingAttachTokenRecord>;
  readonly registerCodingSession: (
    input: CodingSessionRegisterInput,
    requestId: string,
  ) => Promise<CodingSessionRecord>;
  readonly listCodingSessions: (
    query: CodingSessionListQuery,
  ) => Promise<readonly CodingSessionRecord[]>;
  readonly detachCodingSession: (bac_id: string, requestId: string) => Promise<CodingSessionRecord>;
  readonly bumpWorkstream: (bac_id: string, requestId: string) => Promise<MutationResult>;
  readonly archiveThread: (bac_id: string, requestId: string) => Promise<MutationResult>;
  readonly unarchiveThread: (bac_id: string, requestId: string) => Promise<MutationResult>;
}

const dateStamp = (value: Date): string => value.toISOString().slice(0, 10);

const createDefaultSettings = (revision = '0'): SettingsDocument =>
  settingsDocumentSchema.parse({
    // Default-ON for new installs. Auto-send still requires the
    // per-thread toggle PLUS this provider opt-in PLUS screen-share-
    // safe being off (§24.10 quartet), so flipping these on by
    // default doesn't ship anything without an explicit thread
    // toggle. Existing users keep their stored values — this only
    // applies on first vault initialisation.
    autoSendOptIn: { chatgpt: true, claude: true, gemini: true },
    defaultPacketKind: 'research',
    defaultDispatchTarget: 'claude',
    screenShareSafeMode: false,
    revision,
  });

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

// Markdown sidecar for a vault record. Lives next to the .json with
// the same bac_id stem. Failures here are best-effort — the JSON is
// the canonical store, the .md is for human browsing. We swallow
// errors so a flaky filesystem can't take down a write.
const writeMarkdownProjection = async (path: string, body: string): Promise<void> => {
  try {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, body, 'utf8');
  } catch {
    // Vault write failures are surfaced via audit elsewhere; the
    // markdown sidecar is non-critical, do not fail the upsert.
  }
};

const writeJsonAtomic = async (path: string, value: unknown): Promise<void> => {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const tempPath = join(directory, `.${basename(path)}.${createRevision()}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
};

const appendJsonLine = async (path: string, value: unknown): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'a' });
};

const readJsonRecord = async (path: string): Promise<Record<string, unknown>> => {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object at ${path}`);
  }
  return parsed as Record<string, unknown>;
};

const readStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const isMissingPathError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { readonly code?: unknown }).code === 'ENOENT';

const readMarkdownLockSentinel = async (path: string): Promise<boolean> => {
  try {
    return parseMarkdownLockSentinel(await readFile(path, 'utf8'));
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
};

const incrementSettingsRevision = (revision: string): string => {
  if (!/^\d+$/u.test(revision)) {
    throw new Error('Settings revision must be numeric to increment.');
  }

  return (BigInt(revision) + 1n).toString();
};

const readSettingsDocument = async (path: string): Promise<SettingsDocument> => {
  try {
    const raw = await readFile(path, 'utf8');
    return settingsDocumentSchema.parse(JSON.parse(raw) as unknown);
  } catch (error) {
    if (isMissingPathError(error)) {
      return createDefaultSettings();
    }
    throw error;
  }
};

const parseDispatchLine = (line: string): DispatchEventRecord | undefined => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const result = dispatchEventRecordSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
};

const readDispatchFile = async (path: string): Promise<readonly DispatchEventRecord[]> => {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .map(parseDispatchLine)
    .filter((event): event is DispatchEventRecord => event !== undefined);
};

const parseDispatchLinkLine = (line: string): DispatchLinkRecord | undefined => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const result = dispatchLinkSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
};

const readDispatchLinkFile = async (path: string): Promise<readonly DispatchLinkRecord[]> => {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .map(parseDispatchLinkLine)
    .filter((entry): entry is DispatchLinkRecord => entry !== undefined);
};

// Walk every dispatch-links/<date>.jsonl file, newest first. Used by
// the link readers — the table is small (one entry per dispatch) and
// pruning happens out-of-band, so a simple linear scan is fine.
const readAllDispatchLinks = async (
  bacRoot: string,
): Promise<readonly DispatchLinkRecord[]> => {
  const linkRoot = join(bacRoot, 'dispatch-links');
  let names: string[];
  try {
    names = await readdir(linkRoot);
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }
  const files = names.filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name)).sort();
  return (
    await Promise.all(files.map((name) => readDispatchLinkFile(join(linkRoot, name))))
  ).flat();
};

const parseAuditLine = (line: string): AuditEventRecord | undefined => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const result = auditEventSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
};

const readAuditFile = async (path: string): Promise<readonly AuditEventRecord[]> => {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .map(parseAuditLine)
    .filter((event): event is AuditEventRecord => event !== undefined);
};

const parseReviewLine = (line: string): ReviewEvent | undefined => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const result = reviewEventRecordSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
};

const readReviewFile = async (path: string): Promise<readonly ReviewEvent[]> => {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .map(parseReviewLine)
    .filter((event): event is ReviewEvent => event !== undefined);
};

const parseEventLine = (line: string): CaptureEventInput | undefined => {
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

const readEventFile = async (path: string): Promise<readonly CaptureEventInput[]> => {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .map(parseEventLine)
    .filter((event): event is CaptureEventInput => event !== undefined);
};

export const createVaultWriter = (vaultPath: string): VaultWriter => {
  const bacRoot = join(vaultPath, '_BAC');
  const settingsPath = join(bacRoot, '.config', 'settings.json');

  const ensureVaultPresent = async (): Promise<void> => {
    try {
      await access(vaultPath);
    } catch {
      throw new Error('Vault path is unavailable.');
    }
  };

  const audit = async (event: AuditEvent): Promise<void> => {
    await appendJsonLine(
      join(bacRoot, 'audit', `${dateStamp(new Date(event.timestamp))}.jsonl`),
      event,
    );
  };

  const readRecentTurnsFromEvents = async (query: {
    readonly threadUrl: string;
    readonly limit: number;
    readonly role?: TurnRecord['role'];
  }): Promise<readonly TurnRecord[]> => {
    const eventsRoot = join(bacRoot, 'events');
    let names: string[];
    try {
      names = await readdir(eventsRoot);
    } catch (error) {
      if (isMissingPathError(error)) {
        return [];
      }
      throw error;
    }

    const dedupe = new Map<string, TurnRecord>();
    for (const name of names
      .filter((candidate) => /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(candidate))
      .sort()
      .reverse()) {
      const fileEvents = await readEventFile(join(eventsRoot, name));
      for (const event of fileEvents) {
        if (event.threadUrl !== query.threadUrl) {
          continue;
        }
        for (const turn of event.turns) {
          if (query.role !== undefined && turn.role !== query.role) {
            continue;
          }
          const key = `${String(turn.ordinal)}::${turn.role}`;
          const existing = dedupe.get(key);
          // Keep the EARLIEST capturedAt for each (ordinal, role) so
          // re-captures of the same chat (e.g. extension reload
          // re-injection) don't overwrite the original time we first
          // saw the turn. The user's "X min ago" stamp should reflect
          // when the AI actually replied, not when we last extracted.
          if (existing === undefined || existing.capturedAt > turn.capturedAt) {
            dedupe.set(key, turn);
          }
        }
      }
      if (dedupe.size >= query.limit * 4) {
        break;
      }
    }

    // Sort by ordinal desc (newest turn in chat sequence first) —
    // capturedAt sort breaks once we preserve earliest timestamps,
    // because a re-stamp on an older turn would float it to the top.
    return Array.from(dedupe.values())
      .sort((left, right) => right.ordinal - left.ordinal)
      .slice(0, query.limit);
  };

  const readWorkstreamTitle = async (workstreamId: string): Promise<string> => {
    try {
      const workstream = await readJsonRecord(join(bacRoot, 'workstreams', `${workstreamId}.json`));
      return typeof workstream['title'] === 'string' ? workstream['title'] : workstreamId;
    } catch (error) {
      if (isMissingPathError(error)) {
        return workstreamId;
      }
      throw error;
    }
  };

  return {
    async status() {
      try {
        await access(vaultPath);
        return 'connected';
      } catch {
        return 'unreachable';
      }
    },

    async writeCaptureEvent(input, requestId) {
      await ensureVaultPresent();
      const bac_id = createBacId();
      const revision = createRevision();
      const timestamp = new Date().toISOString();
      const event = { ...input, bac_id, revision, requestId, receivedAt: timestamp };

      await appendJsonLine(
        join(bacRoot, 'events', `${dateStamp(new Date(input.capturedAt))}.jsonl`),
        event,
      );
      await audit({ requestId, route: 'appendEvent', outcome: 'success', bac_id, timestamp });
      return { bac_id, revision };
    },

    async readRecentTurns(query) {
      await ensureVaultPresent();
      return await readRecentTurnsFromEvents({
        threadUrl: query.threadUrl,
        limit: query.limit,
        ...(query.role === undefined ? {} : { role: query.role }),
      });
    },

    async writeDispatchEvent(input, requestId) {
      await ensureVaultPresent();
      const timestamp = new Date().toISOString();
      await appendJsonLine(
        join(bacRoot, 'dispatches', `${dateStamp(new Date(input.createdAt))}.jsonl`),
        input,
      );
      await audit({
        requestId,
        route: 'recordDispatch',
        outcome: 'success',
        bac_id: input.bac_id,
        timestamp,
      });
      return { bac_id: input.bac_id, status: 'recorded' };
    },

    async linkDispatchToThread(input, requestId) {
      await ensureVaultPresent();
      const linkedAt = new Date().toISOString();
      const existingLinks = await readAllDispatchLinks(bacRoot);
      const existing = existingLinks
        .filter((entry) => entry.dispatchId === input.dispatchId)
        .sort((a, b) => b.linkedAt.localeCompare(a.linkedAt))[0];
      // Idempotent: same (dispatchId, threadId) pair returns the
      // existing record without appending another row. Re-linking
      // to a different thread appends a new row — readLinkForDispatch
      // resolves to the latest entry, so the move is observable.
      if (existing !== undefined && existing.threadId === input.threadId) {
        await audit({
          requestId,
          route: 'linkDispatch',
          outcome: 'success',
          bac_id: input.dispatchId,
          timestamp: linkedAt,
        });
        return existing;
      }
      const record: DispatchLinkRecord = {
        dispatchId: input.dispatchId,
        threadId: input.threadId,
        linkedAt,
      };
      await appendJsonLine(
        join(bacRoot, 'dispatch-links', `${dateStamp(new Date(linkedAt))}.jsonl`),
        record,
      );
      await audit({
        requestId,
        route: 'linkDispatch',
        outcome: 'success',
        bac_id: input.dispatchId,
        timestamp: linkedAt,
      });
      return record;
    },

    async readLinkForDispatch(dispatchId) {
      await ensureVaultPresent();
      const links = await readAllDispatchLinks(bacRoot);
      const matches = links
        .filter((entry) => entry.dispatchId === dispatchId)
        .sort((a, b) => b.linkedAt.localeCompare(a.linkedAt));
      return matches[0] ?? null;
    },

    async readLinksForThread(threadId) {
      await ensureVaultPresent();
      const links = await readAllDispatchLinks(bacRoot);
      return links.filter((entry) => entry.threadId === threadId);
    },

    async readDispatchEvents(query) {
      await ensureVaultPresent();
      const dispatchRoot = join(bacRoot, 'dispatches');
      let names: string[];

      try {
        names = await readdir(dispatchRoot);
      } catch (error) {
        if (isMissingPathError(error)) {
          return [];
        }
        throw error;
      }

      const sinceMillis = query.since === undefined ? undefined : Date.parse(query.since);
      const events = (
        await Promise.all(
          names
            .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name))
            .sort()
            .reverse()
            .slice(0, 100)
            .map((name) => readDispatchFile(join(dispatchRoot, name))),
        )
      ).flat();

      return events
        .filter((event) => sinceMillis === undefined || Date.parse(event.createdAt) >= sinceMillis)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, query.limit);
    },

    async readAuditEvents(query) {
      await ensureVaultPresent();
      const auditRoot = join(bacRoot, 'audit');
      let names: string[];

      try {
        names = await readdir(auditRoot);
      } catch (error) {
        if (isMissingPathError(error)) {
          return [];
        }
        throw error;
      }

      const sinceMillis = query.since === undefined ? undefined : Date.parse(query.since);
      const events = (
        await Promise.all(
          names
            .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name))
            .sort()
            .reverse()
            .slice(0, 100)
            .map((name) => readAuditFile(join(auditRoot, name))),
        )
      ).flat();

      return events
        .filter((event) => sinceMillis === undefined || Date.parse(event.timestamp) >= sinceMillis)
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
        .slice(0, query.limit);
    },

    async writeReviewEvent(input, requestId) {
      await ensureVaultPresent();
      const timestamp = new Date().toISOString();
      await appendJsonLine(
        join(bacRoot, 'reviews', `${dateStamp(new Date(input.createdAt))}.jsonl`),
        input,
      );
      await audit({
        requestId,
        route: 'recordReview',
        outcome: 'success',
        bac_id: input.bac_id,
        timestamp,
      });
      return { bac_id: input.bac_id, status: 'recorded' };
    },

    async readReviewEvents(query) {
      await ensureVaultPresent();
      const reviewRoot = join(bacRoot, 'reviews');
      let names: string[];

      try {
        names = await readdir(reviewRoot);
      } catch (error) {
        if (isMissingPathError(error)) {
          return [];
        }
        throw error;
      }

      const sinceMillis = query.since === undefined ? undefined : Date.parse(query.since);
      const events: ReviewEvent[] = [];
      for (const name of names
        .filter((candidate) => /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(candidate))
        .sort()
        .reverse()) {
        const fileEvents = await readReviewFile(join(reviewRoot, name));
        events.push(
          ...fileEvents.filter(
            (event) =>
              (sinceMillis === undefined || Date.parse(event.createdAt) >= sinceMillis) &&
              (query.threadId === undefined || event.sourceThreadId === query.threadId),
          ),
        );
        if (events.length >= query.limit) {
          break;
        }
      }

      return events
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, query.limit);
    },

    async readSettings() {
      await ensureVaultPresent();
      return await readSettingsDocument(settingsPath);
    },

    async updateSettings(patch, revision) {
      await ensureVaultPresent();
      const current = await readSettingsDocument(settingsPath);
      if (current.revision !== revision) {
        throw new SettingsRevisionConflictError();
      }

      const updated = settingsDocumentSchema.parse({
        ...current,
        autoSendOptIn: {
          ...current.autoSendOptIn,
          ...(patch.autoSendOptIn ?? {}),
        },
        defaultPacketKind: patch.defaultPacketKind ?? current.defaultPacketKind,
        defaultDispatchTarget: patch.defaultDispatchTarget ?? current.defaultDispatchTarget,
        screenShareSafeMode: patch.screenShareSafeMode ?? current.screenShareSafeMode,
        revision: incrementSettingsRevision(current.revision),
      });
      await writeJsonAtomic(settingsPath, updated);
      return updated;
    },

    async upsertThread(input, requestId) {
      await ensureVaultPresent();
      const bac_id = input.bac_id ?? createBacId();
      const revision = createRevision();
      const timestamp = new Date().toISOString();
      const threadPath = join(bacRoot, 'threads', `${bac_id}.json`);
      const threadMarkdownPath = join(bacRoot, 'threads', `${bac_id}.md`);
      let existingThread: Record<string, unknown> | undefined;
      try {
        existingThread = await readJsonRecord(threadPath);
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error;
        }
      }
      const previousWorkstreamId =
        typeof existingThread?.['primaryWorkstreamId'] === 'string'
          ? existingThread['primaryWorkstreamId']
          : undefined;
      const thread = {
        ...input,
        bac_id,
        revision,
        updatedAt: timestamp,
        tags: input.tags ?? [],
        status: input.status ?? 'tracked',
      };
      const promotedForFirstTime =
        existingThread !== undefined &&
        previousWorkstreamId === undefined &&
        input.primaryWorkstreamId !== undefined;
      const promotedWorkstreamId = input.primaryWorkstreamId;

      await writeJson(threadPath, thread);
      if (!(await readMarkdownLockSentinel(threadMarkdownPath))) {
        if (promotedForFirstTime && promotedWorkstreamId !== undefined) {
          const turns = await readRecentTurnsFromEvents({
            threadUrl: input.threadUrl,
            limit: 1000,
          });
          const workstreamTitle = await readWorkstreamTitle(promotedWorkstreamId);
          await writeMarkdownProjection(
            threadMarkdownPath,
            renderPromotedThreadMarkdown(
              thread as ThreadProjectionInput,
              turns,
              workstreamTitle,
              timestamp,
            ),
          );
        } else if (existingThread === undefined || previousWorkstreamId === undefined) {
          await writeMarkdownProjection(
            threadMarkdownPath,
            renderThreadMarkdown(thread as ThreadProjectionInput),
          );
        }
      }
      await audit({ requestId, route: 'upsertThread', outcome: 'success', bac_id, timestamp });
      return { bac_id, revision };
    },

    async createWorkstream(input, requestId) {
      await ensureVaultPresent();
      const bac_id = createBacId();
      const revision = createRevision();
      const timestamp = new Date().toISOString();
      const workstream = {
        ...input,
        bac_id,
        revision,
        children: input.children ?? [],
        checklist: input.checklist ?? [],
        tags: input.tags ?? [],
        privacy: input.privacy ?? 'shared',
        screenShareSensitive: input.screenShareSensitive ?? false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await writeJson(join(bacRoot, 'workstreams', `${bac_id}.json`), workstream);
      await writeMarkdownProjection(
        join(bacRoot, 'workstreams', `${bac_id}.md`),
        renderWorkstreamMarkdown(workstream as WorkstreamProjectionInput),
      );
      if (input.parentId !== undefined) {
        const parentId = input.parentId;
        const parentPath = join(bacRoot, 'workstreams', `${parentId}.json`);
        const parent = await readJsonRecord(parentPath);
        const updatedParent = {
          ...parent,
          bac_id: parentId,
          children: [...new Set([...readStringArray(parent['children']), bac_id])],
          revision: createRevision(),
          updatedAt: timestamp,
        };
        await writeJson(parentPath, updatedParent);
        await writeMarkdownProjection(
          join(bacRoot, 'workstreams', `${parentId}.md`),
          renderWorkstreamMarkdown(updatedParent),
        );
      }
      await audit({ requestId, route: 'createWorkstream', outcome: 'success', bac_id, timestamp });
      return { bac_id, revision };
    },

    async updateWorkstream(workstreamId, input, requestId) {
      await ensureVaultPresent();
      const path = join(bacRoot, 'workstreams', `${workstreamId}.json`);
      const existing = await readJsonRecord(path);
      const previousParentId =
        typeof existing['parentId'] === 'string' ? existing['parentId'] : undefined;
      const revision = createRevision();
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        ...input,
        bac_id: workstreamId,
        revision,
        updatedAt: timestamp,
      };

      await writeJson(path, updated);
      await writeMarkdownProjection(
        join(bacRoot, 'workstreams', `${workstreamId}.md`),
        renderWorkstreamMarkdown(updated as unknown as WorkstreamProjectionInput),
      );
      if (input.parentId !== undefined && input.parentId !== previousParentId) {
        if (previousParentId !== undefined) {
          const previousParentPath = join(bacRoot, 'workstreams', `${previousParentId}.json`);
          const previousParent = await readJsonRecord(previousParentPath);
          const updatedPrev = {
            ...previousParent,
            bac_id: previousParentId,
            children: readStringArray(previousParent['children']).filter(
              (childId) => childId !== workstreamId,
            ),
            revision: createRevision(),
            updatedAt: timestamp,
          };
          await writeJson(previousParentPath, updatedPrev);
          await writeMarkdownProjection(
            join(bacRoot, 'workstreams', `${previousParentId}.md`),
            renderWorkstreamMarkdown(updatedPrev),
          );
        }
        const nextParentId = input.parentId;
        const nextParentPath = join(bacRoot, 'workstreams', `${nextParentId}.json`);
        const nextParent = await readJsonRecord(nextParentPath);
        const updatedNext = {
          ...nextParent,
          bac_id: nextParentId,
          children: [...new Set([...readStringArray(nextParent['children']), workstreamId])],
          revision: createRevision(),
          updatedAt: timestamp,
        };
        await writeJson(nextParentPath, updatedNext);
        await writeMarkdownProjection(
          join(bacRoot, 'workstreams', `${nextParentId}.md`),
          renderWorkstreamMarkdown(updatedNext),
        );
      }
      await audit({
        requestId,
        route: 'updateWorkstream',
        outcome: 'success',
        bac_id: workstreamId,
        timestamp,
      });
      return { bac_id: workstreamId, revision };
    },

    async createQueueItem(input, requestId) {
      await ensureVaultPresent();
      const bac_id = createBacId();
      const revision = createRevision();
      const timestamp = new Date().toISOString();
      const queueItem = {
        ...input,
        bac_id,
        revision,
        status: input.status ?? 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await writeJson(join(bacRoot, 'queue', `${bac_id}.json`), queueItem);
      await audit({ requestId, route: 'createQueueItem', outcome: 'success', bac_id, timestamp });
      return { bac_id, revision };
    },

    async createReminder(input, requestId) {
      await ensureVaultPresent();
      const bac_id = createBacId();
      const revision = createRevision();
      const timestamp = new Date().toISOString();
      const reminder = {
        ...input,
        bac_id,
        revision,
        status: input.status ?? 'new',
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await writeJson(join(bacRoot, 'reminders', `${bac_id}.json`), reminder);
      await audit({ requestId, route: 'createReminder', outcome: 'success', bac_id, timestamp });
      return { bac_id, revision };
    },

    async updateReminder(reminderId, input, requestId) {
      await ensureVaultPresent();
      const path = join(bacRoot, 'reminders', `${reminderId}.json`);
      const existing = await readJsonRecord(path);
      const revision = createRevision();
      const timestamp = new Date().toISOString();
      const reminder = {
        ...existing,
        ...input,
        bac_id: reminderId,
        revision,
        updatedAt: timestamp,
      };

      await writeJson(path, reminder);
      await audit({
        requestId,
        route: 'updateReminder',
        outcome: 'success',
        bac_id: reminderId,
        timestamp,
      });
      return { bac_id: reminderId, revision };
    },

    async createCodingAttachToken(input, requestId) {
      await ensureVaultPresent();
      // 16 chars, URL-safe, easy to paste verbatim. Lifetime: 5 minutes.
      const token = randomBytes(12).toString('base64url').slice(0, 16);
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + 5 * 60 * 1000);
      const record = codingAttachTokenSchema.parse({
        token,
        ...(input.workstreamId === undefined ? {} : { workstreamId: input.workstreamId }),
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
      await writeJsonAtomic(join(bacRoot, 'coding', 'tokens', `${token}.json`), record);
      await audit({
        requestId,
        route: 'createCodingAttachToken',
        outcome: 'success',
        bac_id: token,
        timestamp: createdAt.toISOString(),
      });
      return record;
    },

    async registerCodingSession(input, requestId) {
      await ensureVaultPresent();
      const tokenPath = join(bacRoot, 'coding', 'tokens', `${input.token}.json`);
      let tokenRecord: CodingAttachTokenRecord;
      try {
        const raw = await readFile(tokenPath, 'utf8');
        tokenRecord = codingAttachTokenSchema.parse(JSON.parse(raw) as unknown);
      } catch (error) {
        if (isMissingPathError(error)) {
          throw new CodingAttachTokenInvalidError();
        }
        throw error;
      }
      if (Date.parse(tokenRecord.expiresAt) < Date.now()) {
        // Best-effort cleanup; ignore missing.
        try {
          await unlink(tokenPath);
        } catch {
          // Token already gone — fine.
        }
        throw new CodingAttachTokenInvalidError('Attach token has expired.');
      }
      const bac_id = createBacId();
      const timestamp = new Date().toISOString();
      const session = codingSessionSchema.parse({
        bac_id,
        ...(tokenRecord.workstreamId === undefined
          ? {}
          : { workstreamId: tokenRecord.workstreamId }),
        tool: input.tool,
        cwd: input.cwd,
        branch: input.branch,
        sessionId: input.sessionId,
        name: input.name,
        ...(input.resumeCommand === undefined ? {} : { resumeCommand: input.resumeCommand }),
        attachedAt: timestamp,
        lastSeenAt: timestamp,
        status: 'attached',
      });
      await writeJsonAtomic(join(bacRoot, 'coding', 'sessions', `${bac_id}.json`), session);
      try {
        await unlink(tokenPath);
      } catch {
        // Token might have been swept already; safe to ignore.
      }
      await audit({
        requestId,
        route: 'registerCodingSession',
        outcome: 'success',
        bac_id,
        timestamp,
      });
      return session;
    },

    async listCodingSessions(query) {
      await ensureVaultPresent();
      // Query by token: look in tokens/ first; if a session was registered
      // with this token, the token file is gone, so fall through to sessions
      // directory, find the most recent session whose attachedAt >= token
      // createdAt. To avoid re-reading the deleted token, we instead scan
      // sessions and filter by workstreamId or createdAt window upstream.
      const sessionsRoot = join(bacRoot, 'coding', 'sessions');
      let names: string[];
      try {
        names = await readdir(sessionsRoot);
      } catch (error) {
        if (isMissingPathError(error)) {
          return [];
        }
        throw error;
      }
      const sessions: CodingSessionRecord[] = [];
      for (const name of names.filter((candidate) => candidate.endsWith('.json'))) {
        try {
          const raw = await readFile(join(sessionsRoot, name), 'utf8');
          const parsed = codingSessionSchema.safeParse(JSON.parse(raw) as unknown);
          if (parsed.success) {
            sessions.push(parsed.data);
          }
        } catch {
          // Skip unreadable files — vault may be mid-write.
        }
      }
      // If a token query was provided and the token still exists, the agent
      // hasn't registered yet — return an empty list. If the token is gone,
      // the most recently attached session within its workstream is the
      // likely match; the side panel polls and dedupes by bac_id anyway.
      if (query.token !== undefined) {
        const tokenPath = join(bacRoot, 'coding', 'tokens', `${query.token}.json`);
        try {
          await access(tokenPath);
          return [];
        } catch {
          // Token consumed; fall through to filter by workstream below.
        }
      }
      const filtered =
        query.workstreamId === undefined
          ? sessions
          : sessions.filter((session) => session.workstreamId === query.workstreamId);
      return filtered.sort((left, right) => right.attachedAt.localeCompare(left.attachedAt));
    },

    async detachCodingSession(bac_id, requestId) {
      await ensureVaultPresent();
      const path = join(bacRoot, 'coding', 'sessions', `${bac_id}.json`);
      let existing: CodingSessionRecord;
      try {
        const raw = await readFile(path, 'utf8');
        existing = codingSessionSchema.parse(JSON.parse(raw) as unknown);
      } catch (error) {
        if (isMissingPathError(error)) {
          throw new CodingSessionNotFoundError();
        }
        throw error;
      }
      const timestamp = new Date().toISOString();
      const updated = codingSessionSchema.parse({
        ...existing,
        status: 'detached',
        lastSeenAt: timestamp,
      });
      await writeJsonAtomic(path, updated);
      await audit({
        requestId,
        route: 'detachCodingSession',
        outcome: 'success',
        bac_id,
        timestamp,
      });
      return updated;
    },

    async bumpWorkstream(bac_id, requestId) {
      await ensureVaultPresent();
      const path = join(bacRoot, 'workstreams', `${bac_id}.json`);
      const existing = await readJsonRecord(path);
      const revision = createRevision();
      const timestamp = new Date().toISOString();
      const updated = { ...existing, bac_id, revision, lastBumpedAt: timestamp, updatedAt: timestamp };
      await writeJson(path, updated);
      await audit({ requestId, route: 'bumpWorkstream', outcome: 'success', bac_id, timestamp });
      return { bac_id, revision };
    },

    async archiveThread(bac_id, requestId) {
      await ensureVaultPresent();
      const path = join(bacRoot, 'threads', `${bac_id}.json`);
      const existing = await readJsonRecord(path);
      const revision = createRevision();
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        bac_id,
        revision,
        status: 'archived',
        archivedAt: typeof existing['archivedAt'] === 'string' ? existing['archivedAt'] : timestamp,
        updatedAt: timestamp,
      };
      await writeJson(path, updated);
      await audit({ requestId, route: 'archiveThread', outcome: 'success', bac_id, timestamp });
      return { bac_id, revision };
    },

    async unarchiveThread(bac_id, requestId) {
      await ensureVaultPresent();
      const path = join(bacRoot, 'threads', `${bac_id}.json`);
      const existing = await readJsonRecord(path);
      const revision = createRevision();
      const timestamp = new Date().toISOString();
      const { archivedAt: _archivedAt, ...rest } = existing;
      void _archivedAt;
      const updated = { ...rest, bac_id, revision, status: 'tracked', updatedAt: timestamp };
      await writeJson(path, updated);
      await audit({ requestId, route: 'unarchiveThread', outcome: 'success', bac_id, timestamp });
      return { bac_id, revision };
    },
  };
};

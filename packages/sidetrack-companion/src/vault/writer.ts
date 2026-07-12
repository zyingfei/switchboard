import { access, mkdir, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

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
import { writeFileAtomic, writeJsonAtomic } from './atomic.js';
import { currentAuditContext } from './auditContext.js';
import { VaultExportConfinementError, VaultUnavailableError } from '../http/errors.js';
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

// Thrown when a workstream PATCH carries a revision that no longer
// matches the on-disk record — a concurrent writer (a second panel /
// MCP caller) has already advanced it. Without this check a full-array
// checklist PATCH is silent last-writer-wins: the second caller's write
// drops the ticked items the first caller added, with no 409.
//
// Extends `SettingsRevisionConflictError` so the HTTP layer's existing
// `instanceof SettingsRevisionConflictError` branch maps it to
// 409 REVISION_CONFLICT with no server.ts change; the overridden
// message surfaces in the problem `detail`.
export class WorkstreamRevisionConflictError extends SettingsRevisionConflictError {
  constructor() {
    super();
    this.message = 'Workstream revision does not match the current workstream revision.';
    this.name = 'WorkstreamRevisionConflictError';
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

// A workstream cannot be deleted while it still has child workstreams
// — promoting / detaching the children is a deliberate user action,
// not a side effect of deletion. The HTTP layer maps this to 409
// CONFLICT so the side panel can show the child count and offer an
// inline "detach all then retry" affordance.
export class WorkstreamHasChildrenError extends Error {
  readonly childCount: number;
  constructor(childCount: number) {
    super(`Cannot delete workstream — it still has ${String(childCount)} child workstream(s).`);
    this.name = 'WorkstreamHasChildrenError';
    this.childCount = childCount;
  }
}

export class WorkstreamNotFoundError extends Error {
  constructor() {
    super('Workstream not found.');
    this.name = 'WorkstreamNotFoundError';
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
  readonly deleteWorkstream: (
    workstreamId: string,
    requestId: string,
  ) => Promise<{
    readonly bac_id: string;
    readonly detachedThreadIds: readonly string[];
  }>;
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
  // §13 step 13 — user-facing Markdown export. Projects the workstream
  // (and optionally its threads) / the thread to Markdown and writes it
  // at the tree-derived path <ancestor titles…>/<safe-title>-report<N>.md
  // relative to the vault root (OUTSIDE _BAC/ — distinct from the flat
  // _BAC/<type>/<bac_id>.md sidecars, which stay). report<N> increments
  // when the target already exists so an export never overwrites a
  // prior one. bac_id lives in frontmatter, so a later reorg that moves
  // the file never breaks linkage. Returns vault-root-relative paths.
  readonly exportWorkstream: (
    workstreamId: string,
    options: { readonly includeThreads?: boolean },
  ) => Promise<{ readonly files: readonly { readonly path: string }[] }>;
  readonly exportThread: (
    threadId: string,
  ) => Promise<{ readonly files: readonly { readonly path: string }[] }>;
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

const appendJsonLine = async (path: string, value: unknown): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'a' });
};

// The machine-managed root under the vault. Exports must never land
// inside it (that tree holds the canonical JSON records + sidecars), so
// a `_BAC`-titled workstream/thread is remapped to its fallback id.
const BAC_ROOT_NAME = '_BAC';

// §13 export — sanitize a workstream/thread title into a single safe
// path segment. Strips filesystem-reserved characters, collapses
// whitespace, and caps length so a pathological title can't blow past
// filesystem limits. Falls back to the bac_id (passed by the caller as
// `fallback`) when the title reduces to nothing.
const sanitizePathSegment = (value: string, fallback: string): string => {
  const cleaned = Array.from(value)
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      // Strip ASCII control characters (0x00-0x1F, 0x7F) and path /
      // Windows-reserved characters, mapping each to a space so word
      // boundaries survive.
      if (code < 0x20 || code === 0x7f || '/\\:*?"<>|'.includes(char)) {
        return ' ';
      }
      return char;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    // Leading dots would make hidden / relative-looking segments.
    // Loop until stable: a single pass leaves `.. ..` → `..` because
    // the interior space defeated a one-shot leading-dot strip, and a
    // bare `..`/`.` is a directory-traversal segment.
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 120)
    .trim();
  // Belt-and-suspenders: after every transform, a segment that is still
  // `.`, `..`, empty, or the machine-managed `_BAC` root is unsafe as a
  // path component — fall back to the caller's id (a bac_id, which is
  // never any of those). This is what makes join()-based tree building
  // traversal-proof at the source.
  if (
    cleaned.length === 0 ||
    cleaned === '.' ||
    cleaned === '..' ||
    cleaned === BAC_ROOT_NAME
  ) {
    return fallback;
  }
  return cleaned;
};

// Belt-and-suspenders confinement for user-facing exports. `directory`
// (and every report path under it) is derived from user-controlled
// titles; even with `sanitizePathSegment` neutering traversal segments,
// we resolve the absolute target and refuse anything that escapes the
// vault root or lands inside the machine-managed `_BAC/` tree. Throws a
// typed 4xx error so a malicious/corrupt title can never write outside
// the boundary.
const assertExportPathConfined = (vaultRoot: string, targetPath: string): void => {
  const resolvedRoot = resolve(vaultRoot);
  const resolvedTarget = resolve(targetPath);
  const rel = relative(resolvedRoot, resolvedTarget);
  // A leading `..` segment or an absolute result means the target sits
  // outside the vault root.
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new VaultExportConfinementError();
  }
  // Reject anything at or under vaultRoot/_BAC — that tree is the
  // canonical record store, off-limits to user-facing reports.
  const bacRel = relative(join(resolvedRoot, BAC_ROOT_NAME), resolvedTarget);
  if (bacRel === '' || (!bacRel.startsWith(`..${sep}`) && bacRel !== '..' && !isAbsolute(bacRel))) {
    throw new VaultExportConfinementError();
  }
};

// Reserve the first free `<baseName>-report<N>.md` path under
// `directory`, starting at N=1, and return it. Never overwrites a prior
// export. To close the check-then-write race between two concurrent
// exports of the same workstream (both would compute the same N with a
// plain `access` probe), we atomically CLAIM the slot with an
// exclusive-create open (`wx`): the loser gets EEXIST and advances to
// N+1. The caller then rewrites the claimed placeholder via
// writeFileAtomic (rename replaces the empty file in place).
const nextReportPath = async (directory: string, baseName: string): Promise<string> => {
  await mkdir(directory, { recursive: true });
  for (let n = 1; ; n += 1) {
    const candidate = join(directory, `${baseName}-report${String(n)}.md`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(candidate, 'wx');
      return candidate;
    } catch (error) {
      if (isExistsError(error)) {
        continue;
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }
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

const turnContentHash = (turn: TurnRecord): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        role: turn.role,
        text: turn.text,
        formattedText: turn.formattedText ?? null,
      }),
    )
    .digest('hex');

const isMissingPathError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { readonly code?: unknown }).code === 'ENOENT';

// EEXIST from an exclusive-create open — the report slot was claimed by
// a concurrent export between our probe and our open. The caller retries
// at the next N.
const isExistsError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { readonly code?: unknown }).code === 'EEXIST';

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
const readAllDispatchLinks = async (bacRoot: string): Promise<readonly DispatchLinkRecord[]> => {
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
      throw new VaultUnavailableError();
    }
  };

  const audit = async (event: AuditEvent): Promise<void> => {
    // Merge the ambient request-scoped provenance (agent / tool /
    // argsSummary / scope / trustModeActive) set by the HTTP layer. When
    // no context is bound (direct writer use, legacy paths) the line is
    // written with the base fields only — still schema-valid.
    const provenance = currentAuditContext();
    const enriched: AuditEvent &
      Partial<{
        agent: string;
        tool: string | null;
        argsSummary: string;
        scope: string | null;
        trustModeActive: boolean;
      }> =
      provenance === undefined
        ? event
        : {
            ...event,
            agent: provenance.agent,
            tool: provenance.tool,
            ...(provenance.argsSummary === undefined
              ? {}
              : { argsSummary: provenance.argsSummary }),
            scope: provenance.scope,
            trustModeActive: provenance.trustModeActive,
          };
    await appendJsonLine(
      join(bacRoot, 'audit', `${dateStamp(new Date(event.timestamp))}.jsonl`),
      enriched,
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

    const dedupe = new Map<number, { readonly turn: TurnRecord; readonly contentHash: string }>();
    for (const name of names
      .filter((candidate) => /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(candidate))
      .sort()) {
      const fileEvents = await readEventFile(join(eventsRoot, name));
      for (const event of fileEvents) {
        if (event.threadUrl !== query.threadUrl) {
          continue;
        }
        for (const turn of event.turns) {
          if (query.role !== undefined && turn.role !== query.role) {
            continue;
          }
          const existing = dedupe.get(turn.ordinal);
          const contentHash = turnContentHash(turn);
          // Merge captures by ordinal. A partial re-capture must only
          // update the ordinals it contains, never replace the whole
          // remembered thread. Equal content keeps the existing turn to
          // avoid last-seen churn; changed content takes the newer
          // capture for that ordinal.
          if (
            existing === undefined ||
            (existing.contentHash !== contentHash && existing.turn.capturedAt <= turn.capturedAt)
          ) {
            dedupe.set(turn.ordinal, { turn, contentHash });
          }
        }
      }
    }

    // Sort by ordinal desc (newest turn in chat sequence first).
    return Array.from(dedupe.values())
      .map(({ turn }) => turn)
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
      if (existing?.threadId === input.threadId) {
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
      // Carry forward the previous `lastResearchMode` when the input
      // omits it. Partial upserts (move-thread, tracking toggle, tab
      // closed → restorable) only set the fields they care about; if
      // we wrote `{...input}` straight to disk we'd silently strip
      // the deep-research chip every time the user did anything other
      // than re-capture. The extension carries the field across local
      // upserts the same way (state.ts:upsertLocalThread).
      const previousResearchMode =
        existingThread?.['lastResearchMode'] === 'deep-research' ||
        existingThread?.['lastResearchMode'] === 'gemini-deep-research' ||
        existingThread?.['lastResearchMode'] === 'unknown'
          ? existingThread['lastResearchMode']
          : undefined;
      const carriedResearchMode = input.lastResearchMode ?? previousResearchMode;
      const thread = {
        ...input,
        bac_id,
        revision,
        updatedAt: timestamp,
        tags: input.tags ?? [],
        status: input.status ?? 'tracked',
        ...(carriedResearchMode === undefined ? {} : { lastResearchMode: carriedResearchMode }),
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
        privacy: input.privacy ?? 'private',
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
      // Optimistic concurrency: the PATCH body carries the revision the
      // caller read. If it no longer matches the on-disk record, a
      // concurrent writer has moved on — reject with a 409 (same shape
      // as updateSettings) rather than silently last-writer-wins, which
      // would drop the other caller's ticked checklist items.
      if (existing['revision'] !== input.revision) {
        throw new WorkstreamRevisionConflictError();
      }
      const previousParentId =
        typeof existing['parentId'] === 'string' ? existing['parentId'] : undefined;
      const revision = createRevision();
      const timestamp = new Date().toISOString();
      // Three branches for parentId:
      //   null      → detach (drop parentId from record).
      //   string    → re-parent under that workstream.
      //   undefined → leave parent unchanged.
      // Spread `...input` would persist a literal `parentId: null` on
      // disk; strip it out and re-set explicitly so the JSON stays
      // clean. `revision` is stripped too — the caller's read-revision
      // must never land on disk; the freshly minted one below wins.
      const wantsDetach = input.parentId === null;
      const wantsReparent = typeof input.parentId === 'string';
      const { parentId: _omitParentId, revision: _omitRevision, ...inputWithoutParent } = input;
      const updated: Record<string, unknown> = {
        ...existing,
        ...inputWithoutParent,
        bac_id: workstreamId,
        revision,
        updatedAt: timestamp,
      };
      if (wantsDetach) {
        delete updated['parentId'];
      } else if (wantsReparent) {
        updated['parentId'] = input.parentId;
      }

      await writeJson(path, updated);
      await writeMarkdownProjection(
        join(bacRoot, 'workstreams', `${workstreamId}.md`),
        renderWorkstreamMarkdown(updated as unknown as WorkstreamProjectionInput),
      );
      const parentChanged =
        (wantsDetach && previousParentId !== undefined) ||
        (wantsReparent && input.parentId !== previousParentId);
      if (parentChanged) {
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
        if (wantsReparent) {
          const nextParentId = input.parentId!;
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

    async deleteWorkstream(workstreamId, requestId) {
      await ensureVaultPresent();
      const path = join(bacRoot, 'workstreams', `${workstreamId}.json`);
      let existing: Record<string, unknown>;
      try {
        existing = await readJsonRecord(path);
      } catch (error) {
        if (isMissingPathError(error)) {
          // Idempotent DELETE — if the record is already gone, the
          // caller's "delete this group" intent is satisfied. The
          // original strict 404 was unfriendly when the side panel
          // had a workstream in chrome.storage that never made it
          // to disk (e.g., created during a brief companion outage).
          await audit({
            requestId,
            route: 'deleteWorkstream',
            outcome: 'success',
            bac_id: workstreamId,
            timestamp: new Date().toISOString(),
          });
          return { bac_id: workstreamId, detachedThreadIds: [] };
        }
        throw error;
      }
      // Refuse if there are still child workstreams. Asking the user
      // to detach them first keeps the cascade explicit instead of
      // silently re-parenting (or worse, deleting) child trees.
      const children = readStringArray(existing['children']);
      if (children.length > 0) {
        await audit({
          requestId,
          route: 'deleteWorkstream',
          outcome: 'failure',
          bac_id: workstreamId,
          timestamp: new Date().toISOString(),
        });
        throw new WorkstreamHasChildrenError(children.length);
      }
      const previousParentId =
        typeof existing['parentId'] === 'string' ? existing['parentId'] : undefined;
      const timestamp = new Date().toISOString();

      // Detach every thread that points at this workstream — they
      // land back in Inbox (primaryWorkstreamId undefined) instead of
      // becoming orphans pointing at a missing record.
      const threadsRoot = join(bacRoot, 'threads');
      const detachedThreadIds: string[] = [];
      try {
        const threadFiles = await readdir(threadsRoot);
        for (const file of threadFiles) {
          if (!file.endsWith('.json')) continue;
          const threadPath = join(threadsRoot, file);
          const thread = await readJsonRecord(threadPath);
          if (thread['primaryWorkstreamId'] !== workstreamId) continue;
          const threadBacId = typeof thread['bac_id'] === 'string' ? thread['bac_id'] : null;
          if (threadBacId === null) continue;
          const { primaryWorkstreamId: _drop, ...rest } = thread;
          const detached = {
            ...rest,
            bac_id: threadBacId,
            revision: createRevision(),
            updatedAt: timestamp,
          };
          await writeJson(threadPath, detached);
          const threadMd = join(threadsRoot, `${threadBacId}.md`);
          if (!(await readMarkdownLockSentinel(threadMd))) {
            await writeMarkdownProjection(threadMd, renderThreadMarkdown(detached));
          }
          detachedThreadIds.push(threadBacId);
        }
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }

      // Remove self from the parent's children array.
      if (previousParentId !== undefined) {
        const parentPath = join(bacRoot, 'workstreams', `${previousParentId}.json`);
        try {
          const parent = await readJsonRecord(parentPath);
          const updatedParent = {
            ...parent,
            bac_id: previousParentId,
            children: readStringArray(parent['children']).filter((id) => id !== workstreamId),
            revision: createRevision(),
            updatedAt: timestamp,
          };
          await writeJson(parentPath, updatedParent);
          await writeMarkdownProjection(
            join(bacRoot, 'workstreams', `${previousParentId}.md`),
            renderWorkstreamMarkdown(updatedParent),
          );
        } catch (error) {
          if (!isMissingPathError(error)) throw error;
        }
      }

      // Tear down the workstream's own JSON + md.
      try {
        await unlink(path);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
      try {
        await unlink(join(bacRoot, 'workstreams', `${workstreamId}.md`));
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }

      await audit({
        requestId,
        route: 'deleteWorkstream',
        outcome: 'success',
        bac_id: workstreamId,
        timestamp,
      });
      return { bac_id: workstreamId, detachedThreadIds };
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
      const updated = {
        ...existing,
        bac_id,
        revision,
        lastBumpedAt: timestamp,
        updatedAt: timestamp,
      };
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

    async exportWorkstream(workstreamId, options) {
      await ensureVaultPresent();
      const record = await readJsonRecord(
        join(bacRoot, 'workstreams', `${workstreamId}.json`),
      );
      // Walk the parent chain (root → self) to build the on-disk tree
      // that mirrors the workstream hierarchy. A cycle guard caps the
      // walk so a corrupt parent loop can't spin forever.
      const chain: Record<string, unknown>[] = [record];
      const seen = new Set<string>([workstreamId]);
      let cursor = typeof record['parentId'] === 'string' ? record['parentId'] : undefined;
      while (cursor !== undefined && !seen.has(cursor)) {
        seen.add(cursor);
        try {
          const parent = await readJsonRecord(join(bacRoot, 'workstreams', `${cursor}.json`));
          chain.unshift(parent);
          cursor = typeof parent['parentId'] === 'string' ? parent['parentId'] : undefined;
        } catch {
          break;
        }
      }
      const segments = chain.map((entry) => {
        const id = typeof entry['bac_id'] === 'string' ? entry['bac_id'] : workstreamId;
        const title = typeof entry['title'] === 'string' ? entry['title'] : id;
        return sanitizePathSegment(title, id);
      });
      // Export tree lives OUTSIDE _BAC/ — this is the user-facing
      // report, distinct from the flat _BAC/workstreams/<id>.md sidecar.
      const directory = join(vaultPath, ...segments);
      // Confine BEFORE nextReportPath, which mkdirs the directory and
      // claims a placeholder file — nothing on disk may be created
      // outside the vault boundary or inside _BAC/.
      assertExportPathConfined(vaultPath, directory);
      const selfTitle =
        typeof record['title'] === 'string' ? record['title'] : workstreamId;
      const reportPath = await nextReportPath(
        directory,
        sanitizePathSegment(selfTitle, workstreamId),
      );
      assertExportPathConfined(vaultPath, reportPath);
      const body = renderWorkstreamMarkdown(record as unknown as WorkstreamProjectionInput);
      await writeFileAtomic(reportPath, body);
      const files: { readonly path: string }[] = [{ path: relative(vaultPath, reportPath) }];

      if (options.includeThreads === true) {
        const threadsRoot = join(bacRoot, 'threads');
        try {
          const threadFiles = await readdir(threadsRoot);
          for (const file of threadFiles.filter((name) => name.endsWith('.json')).sort()) {
            const thread = await readJsonRecord(join(threadsRoot, file));
            if (thread['primaryWorkstreamId'] !== workstreamId) continue;
            const threadId =
              typeof thread['bac_id'] === 'string' ? thread['bac_id'] : undefined;
            if (threadId === undefined) continue;
            const threadTitle =
              typeof thread['title'] === 'string' ? thread['title'] : threadId;
            const threadReportPath = await nextReportPath(
              directory,
              sanitizePathSegment(threadTitle, threadId),
            );
            assertExportPathConfined(vaultPath, threadReportPath);
            await writeFileAtomic(
              threadReportPath,
              renderThreadMarkdown(thread as unknown as ThreadProjectionInput),
            );
            files.push({ path: relative(vaultPath, threadReportPath) });
          }
        } catch (error) {
          if (!isMissingPathError(error)) throw error;
        }
      }
      return { files };
    },

    async exportThread(threadId) {
      await ensureVaultPresent();
      const record = await readJsonRecord(join(bacRoot, 'threads', `${threadId}.json`));
      // Place the thread report under its workstream's tree when it has
      // one, else at the vault root. Only the immediate workstream title
      // is used as the parent segment; the full ancestor chain is a
      // workstream-export concern.
      const workstreamId =
        typeof record['primaryWorkstreamId'] === 'string'
          ? record['primaryWorkstreamId']
          : undefined;
      const parentSegments: string[] = [];
      if (workstreamId !== undefined) {
        try {
          const ws = await readJsonRecord(join(bacRoot, 'workstreams', `${workstreamId}.json`));
          const wsTitle = typeof ws['title'] === 'string' ? ws['title'] : workstreamId;
          parentSegments.push(sanitizePathSegment(wsTitle, workstreamId));
        } catch {
          // Missing workstream record → export at the vault root.
        }
      }
      const directory = join(vaultPath, ...parentSegments);
      // Confine BEFORE nextReportPath mkdirs / claims a placeholder.
      assertExportPathConfined(vaultPath, directory);
      const title = typeof record['title'] === 'string' ? record['title'] : threadId;
      const reportPath = await nextReportPath(directory, sanitizePathSegment(title, threadId));
      assertExportPathConfined(vaultPath, reportPath);
      await writeFileAtomic(
        reportPath,
        renderThreadMarkdown(record as unknown as ThreadProjectionInput),
      );
      return { files: [{ path: relative(vaultPath, reportPath) }] };
    },
  };
};

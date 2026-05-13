import type {
  CaptureEvent,
  CodingAttachTokenCreate,
  CodingAttachTokenRecord,
  CompanionSettings,
  CompanionStatus,
  MutationResult,
  Problem,
  QueueCreate,
  ReminderCreate,
  ReminderUpdate,
  ThreadUpsert,
  WorkstreamProjection,
  WorkstreamProjectionRecord,
  WorkstreamCreate,
  WorkstreamUpdate,
} from './model';
import type { CodingSession } from '../workboard';

export interface CompanionClient {
  readonly status: () => Promise<CompanionStatus>;
  readonly appendEvent: (event: CaptureEvent, idempotencyKey: string) => Promise<MutationResult>;
  readonly upsertThread: (thread: ThreadUpsert) => Promise<MutationResult>;
  readonly createWorkstream: (workstream: WorkstreamCreate) => Promise<MutationResult>;
  readonly listWorkstreamProjections: () => Promise<readonly WorkstreamProjection[]>;
  readonly updateWorkstream: (
    workstreamId: string,
    update: WorkstreamUpdate,
  ) => Promise<MutationResult>;
  readonly deleteWorkstream: (
    workstreamId: string,
  ) => Promise<{ readonly bac_id: string; readonly detachedThreadIds: readonly string[] }>;
  readonly createQueueItem: (item: QueueCreate, idempotencyKey: string) => Promise<MutationResult>;
  readonly createReminder: (reminder: ReminderCreate) => Promise<MutationResult>;
  readonly updateReminder: (
    reminderId: string,
    reminder: ReminderUpdate,
  ) => Promise<MutationResult>;
  readonly createCodingAttachToken: (
    request: CodingAttachTokenCreate,
  ) => Promise<CodingAttachTokenRecord>;
  readonly listCodingSessions: (query: {
    readonly token?: string;
    readonly workstreamId?: string;
  }) => Promise<readonly CodingSession[]>;
  readonly detachCodingSession: (codingSessionId: string) => Promise<CodingSession>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parseProblemMessage = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const problem = value as Partial<Problem>;
  return typeof problem.detail === 'string'
    ? problem.detail
    : typeof problem.title === 'string'
      ? problem.title
      : undefined;
};

const parseStatus = (value: unknown): CompanionStatus => {
  if (!isRecord(value)) {
    throw new Error('Companion status response was not an object.');
  }

  const envelope = value as { readonly data?: unknown };
  const data = envelope.data;
  if (!isRecord(data)) {
    throw new Error('Companion status response missing data.');
  }

  const statusData = data as {
    readonly companion?: unknown;
    readonly vault?: unknown;
    readonly requestId?: unknown;
    readonly sync?: unknown;
    readonly snapshot?: unknown;
  };

  if (statusData.companion !== 'running') {
    throw new Error('Companion status response has invalid companion state.');
  }

  const vault = statusData.vault;
  if (vault !== 'connected' && vault !== 'unreachable') {
    throw new Error('Companion status response has invalid vault state.');
  }

  const requestId = statusData.requestId;
  if (typeof requestId !== 'string') {
    throw new Error('Companion status response missing requestId.');
  }

  // Optional sync.relay block (companion only emits it when it
  // was started with --sync-relay or --sync-relay-local). Parse
  // defensively — a malformed relay block should NOT make the
  // whole status call fail; the extension just won't surface a
  // relay-down banner.
  const syncIn = statusData.sync;
  let sync: CompanionStatus['sync'] | undefined;
  if (isRecord(syncIn) && isRecord(syncIn.relay)) {
    const r = syncIn.relay as Record<string, unknown>;
    sync = {
      relay: {
        url: typeof r.url === 'string' ? r.url : '',
        mode: r.mode === 'local' || r.mode === 'remote' ? r.mode : 'remote',
        ...(typeof r.connected === 'boolean' ? { connected: r.connected } : {}),
        ...(typeof r.lastConnectedAtMs === 'number'
          ? { lastConnectedAtMs: r.lastConnectedAtMs }
          : {}),
        ...(typeof r.lastDisconnectedAtMs === 'number'
          ? { lastDisconnectedAtMs: r.lastDisconnectedAtMs }
          : {}),
        ...(typeof r.consecutiveFailures === 'number'
          ? { consecutiveFailures: r.consecutiveFailures }
          : {}),
        ...(typeof r.pendingPublishes === 'number' ? { pendingPublishes: r.pendingPublishes } : {}),
      },
    };
  }

  // Snapshot freshness — the side panel uses revision changes as a
  // signal that resolver suggestions cached against the previous
  // snapshot have gone stale. Parse defensively; a missing field
  // just means the companion didn't publish a revision yet.
  const snapshotIn = statusData.snapshot;
  const snapshotRevision =
    isRecord(snapshotIn) && typeof (snapshotIn as Record<string, unknown>)['revision'] === 'string'
      ? ((snapshotIn as Record<string, unknown>)['revision'] as string)
      : undefined;

  return {
    companion: 'running',
    vault,
    requestId,
    ...(sync === undefined ? {} : { sync }),
    ...(snapshotRevision === undefined ? {} : { snapshotRevision }),
  };
};

const parseMutationResult = (value: unknown): MutationResult => {
  if (!isRecord(value)) {
    throw new Error('Companion mutation response was not an object.');
  }

  const envelope = value as { readonly data?: unknown };
  const data = envelope.data;
  if (!isRecord(data)) {
    throw new Error('Companion mutation response missing data.');
  }

  const mutationData = data as {
    readonly bac_id?: unknown;
    readonly revision?: unknown;
    readonly requestId?: unknown;
  };
  const bacId = mutationData.bac_id;
  const revision = mutationData.revision;
  const requestId = mutationData.requestId;
  if (typeof bacId !== 'string' || typeof revision !== 'string' || typeof requestId !== 'string') {
    throw new Error('Companion mutation response missing required fields.');
  }

  return { bac_id: bacId, revision, requestId };
};

const parseStringArray = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
};

const parseChecklist = (value: unknown): WorkstreamProjectionRecord['checklist'] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = item.id;
    const text = item.text;
    const checked = item.checked;
    const createdAt = item.createdAt;
    const updatedAt = item.updatedAt;
    if (
      typeof id !== 'string' ||
      typeof text !== 'string' ||
      typeof checked !== 'boolean' ||
      typeof createdAt !== 'string' ||
      typeof updatedAt !== 'string'
    ) {
      return [];
    }
    return [{ id, text, checked, createdAt, updatedAt }];
  });
};

const parsePrivacy = (value: unknown): WorkstreamProjectionRecord['privacy'] | undefined =>
  value === 'private' || value === 'shared' || value === 'public' ? value : undefined;

const parseWorkstreamProjectionRecord = (value: unknown): WorkstreamProjectionRecord => {
  if (!isRecord(value)) {
    throw new Error('Workstream projection record was not an object.');
  }
  const bacId = value.bac_id;
  const title = value.title;
  if (typeof bacId !== 'string' || typeof title !== 'string') {
    throw new Error('Workstream projection record missing bac_id/title.');
  }
  const parentId = value.parentId;
  const privacy = parsePrivacy(value.privacy);
  const screenShareSensitive = value.screenShareSensitive;
  const description = value.description;
  return {
    bac_id: bacId,
    title,
    ...(typeof parentId === 'string' ? { parentId } : {}),
    ...(privacy === undefined ? {} : { privacy }),
    ...(typeof screenShareSensitive === 'boolean' ? { screenShareSensitive } : {}),
    tags: parseStringArray(value.tags),
    children: parseStringArray(value.children),
    checklist: parseChecklist(value.checklist),
    ...(typeof description === 'string' ? { description } : {}),
  };
};

const parseWorkstreamProjectionRegister = (value: unknown): WorkstreamProjection['record'] => {
  if (!isRecord(value)) {
    throw new Error('Workstream projection register was not an object.');
  }
  if (value.status === 'resolved') {
    return value.value === undefined
      ? { status: 'resolved' }
      : { status: 'resolved', value: parseWorkstreamProjectionRecord(value.value) };
  }
  if (value.status === 'conflict') {
    const candidates = Array.isArray(value.candidates)
      ? value.candidates.flatMap((candidate) =>
          isRecord(candidate) ? [{ value: parseWorkstreamProjectionRecord(candidate.value) }] : [],
        )
      : [];
    return { status: 'conflict', candidates };
  }
  throw new Error('Workstream projection register status was invalid.');
};

const parseWorkstreamProjections = (value: unknown): readonly WorkstreamProjection[] => {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error('Workstream projections response missing data array.');
  }
  return value.data.map((item) => {
    if (!isRecord(item)) {
      throw new Error('Workstream projection was not an object.');
    }
    const bacId = item.bac_id;
    if (typeof bacId !== 'string') {
      throw new Error('Workstream projection missing bac_id.');
    }
    return {
      bac_id: bacId,
      record: parseWorkstreamProjectionRegister(item.record),
      deleted: item.deleted === true,
    };
  });
};

export class HttpCompanionClient implements CompanionClient {
  private readonly baseUrl: string;

  constructor(private readonly settings: CompanionSettings) {
    this.baseUrl = `http://127.0.0.1:${String(settings.port)}/v1`;
  }

  async status(): Promise<CompanionStatus> {
    // Companion catchUp on a real-world vault (5K+ events on cold
    // start) can pin the SW main thread for 30+ s before the HTTP
    // listener gets a slot. Observed: first /status call took 39 s
    // against a freshly-spawned companion, every call after was sub-
    // 250 ms. A 5-second timeout on the cheap probe falsely flags
    // the companion as dead during startup; the panel keeps showing
    // "Companion: disconnected" until the user retries. Give /status
    // a longer budget — the panel poll cadence is 15 s anyway, so a
    // 45-second timeout still bounds the worst case to one extra
    // poll window.
    return parseStatus(await this.request('/status', { method: 'GET' }, 45_000));
  }

  async appendEvent(event: CaptureEvent, idempotencyKey: string): Promise<MutationResult> {
    return parseMutationResult(
      await this.request('/events', {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify(event),
      }),
    );
  }

  async upsertThread(thread: ThreadUpsert): Promise<MutationResult> {
    return parseMutationResult(
      await this.request('/threads', {
        method: 'POST',
        body: JSON.stringify(thread),
      }),
    );
  }

  async createWorkstream(workstream: WorkstreamCreate): Promise<MutationResult> {
    return parseMutationResult(
      await this.request('/workstreams', {
        method: 'POST',
        body: JSON.stringify(workstream),
      }),
    );
  }

  async listWorkstreamProjections(): Promise<readonly WorkstreamProjection[]> {
    return parseWorkstreamProjections(
      await this.request('/workstreams/projections', {
        method: 'GET',
      }),
    );
  }

  async updateWorkstream(workstreamId: string, update: WorkstreamUpdate): Promise<MutationResult> {
    return parseMutationResult(
      await this.request(`/workstreams/${encodeURIComponent(workstreamId)}`, {
        method: 'PATCH',
        body: JSON.stringify(update),
      }),
    );
  }

  async deleteWorkstream(
    workstreamId: string,
  ): Promise<{ readonly bac_id: string; readonly detachedThreadIds: readonly string[] }> {
    const raw = await this.request(`/workstreams/${encodeURIComponent(workstreamId)}`, {
      method: 'DELETE',
    });
    const body = raw as {
      readonly data?: {
        readonly bac_id?: unknown;
        readonly detachedThreadIds?: unknown;
      };
    };
    const bacId = body.data?.bac_id;
    const detached = body.data?.detachedThreadIds;
    if (typeof bacId !== 'string' || !Array.isArray(detached)) {
      throw new Error('Companion delete-workstream response was malformed.');
    }
    return {
      bac_id: bacId,
      detachedThreadIds: detached.filter((id): id is string => typeof id === 'string'),
    };
  }

  async createQueueItem(item: QueueCreate, idempotencyKey: string): Promise<MutationResult> {
    return parseMutationResult(
      await this.request('/queue', {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify(item),
      }),
    );
  }

  async createReminder(reminder: ReminderCreate): Promise<MutationResult> {
    return parseMutationResult(
      await this.request('/reminders', {
        method: 'POST',
        body: JSON.stringify(reminder),
      }),
    );
  }

  async updateReminder(reminderId: string, reminder: ReminderUpdate): Promise<MutationResult> {
    return parseMutationResult(
      await this.request(`/reminders/${encodeURIComponent(reminderId)}`, {
        method: 'PATCH',
        body: JSON.stringify(reminder),
      }),
    );
  }

  async createCodingAttachToken(
    request: CodingAttachTokenCreate,
  ): Promise<CodingAttachTokenRecord> {
    const value = await this.request('/coding-sessions/attach-tokens', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    if (!isRecord(value) || !isRecord((value as { data?: unknown }).data)) {
      throw new Error('Companion attach-token response missing data.');
    }
    return (value as { data: CodingAttachTokenRecord }).data;
  }

  async listCodingSessions(query: {
    readonly token?: string;
    readonly workstreamId?: string;
  }): Promise<readonly CodingSession[]> {
    const params = new URLSearchParams();
    if (query.token !== undefined) {
      params.set('token', query.token);
    }
    if (query.workstreamId !== undefined) {
      params.set('workstreamId', query.workstreamId);
    }
    const suffix = params.toString().length === 0 ? '' : `?${params.toString()}`;
    const value = await this.request(`/coding-sessions${suffix}`, { method: 'GET' });
    if (!isRecord(value) || !Array.isArray((value as { data?: unknown }).data)) {
      throw new Error('Companion coding-sessions response missing data array.');
    }
    return (value as { data: CodingSession[] }).data;
  }

  async detachCodingSession(codingSessionId: string): Promise<CodingSession> {
    const value = await this.request(`/coding-sessions/${encodeURIComponent(codingSessionId)}`, {
      method: 'DELETE',
    });
    if (!isRecord(value) || !isRecord((value as { data?: unknown }).data)) {
      throw new Error('Companion detach response missing data.');
    }
    return (value as { data: CodingSession }).data;
  }

  private async request(
    path: string,
    init: RequestInit,
    timeoutMs: number = 5_000,
  ): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');
    headers.set('x-bac-bridge-key', this.settings.bridgeKey);

    // Fixes: side panel stuck on "Companion: disconnected" even when the
    // full tab is fine. Root cause: no fetch timeout here meant a slow
    // companion (catchUp on a 5K-event vault) would hang the SW's
    // getWorkboardState handler beyond Chrome's "message port closed
    // before a response was received" ceiling. The panel's sendMessage
    // resolved as undefined → isRuntimeResponse() false → refresh()
    // threw → silent catch → panel kept whatever initial state it had
    // (default: 'disconnected'). Bounding the fetch ensures the SW
    // handler always returns within `timeoutMs` with EITHER the parsed
    // status OR a thrown error that withCompanionStatus catches and
    // surfaces as 'disconnected' WITH state, so the panel always gets a
    // fresh state payload and the next 15s poll can recover when the
    // companion unblocks. Default 5 s for write/list paths; callers
    // pass a longer budget for cold-start probes like /status (45 s)
    // where the catchUp queue legitimately exceeds the default.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      const value = (await response.json()) as unknown;
      if (!response.ok) {
        throw new Error(parseProblemMessage(value) ?? `Companion HTTP ${String(response.status)}`);
      }
      return value;
    } catch (error) {
      // Translate AbortError into something users can act on; otherwise
      // surface the underlying network error.
      if (error instanceof Error && error.name === 'AbortError') {
        const seconds = Math.round(timeoutMs / 1000);
        throw new Error(
          `Companion did not respond within ${String(seconds)}s on ${path}. It may be busy (catchUp on a large vault). Retry in a few seconds.`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export const createCompanionClient = (settings: CompanionSettings): CompanionClient =>
  new HttpCompanionClient(settings);

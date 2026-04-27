import type {
  CaptureEvent,
  CompanionSettings,
  CompanionStatus,
  MutationResult,
  Problem,
  QueueCreate,
  ReminderCreate,
  ThreadUpsert,
  WorkstreamCreate,
  WorkstreamUpdate,
} from './model';

export interface CompanionClient {
  readonly status: () => Promise<CompanionStatus>;
  readonly appendEvent: (event: CaptureEvent, idempotencyKey: string) => Promise<MutationResult>;
  readonly upsertThread: (thread: ThreadUpsert) => Promise<MutationResult>;
  readonly createWorkstream: (workstream: WorkstreamCreate) => Promise<MutationResult>;
  readonly updateWorkstream: (
    workstreamId: string,
    update: WorkstreamUpdate,
  ) => Promise<MutationResult>;
  readonly createQueueItem: (item: QueueCreate, idempotencyKey: string) => Promise<MutationResult>;
  readonly createReminder: (reminder: ReminderCreate) => Promise<MutationResult>;
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

  return { companion: 'running', vault, requestId };
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

export class HttpCompanionClient implements CompanionClient {
  private readonly baseUrl: string;

  constructor(private readonly settings: CompanionSettings) {
    this.baseUrl = `http://127.0.0.1:${String(settings.port)}/v1`;
  }

  async status(): Promise<CompanionStatus> {
    return parseStatus(await this.request('/status', { method: 'GET' }));
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

  async updateWorkstream(workstreamId: string, update: WorkstreamUpdate): Promise<MutationResult> {
    return parseMutationResult(
      await this.request(`/workstreams/${encodeURIComponent(workstreamId)}`, {
        method: 'PATCH',
        body: JSON.stringify(update),
      }),
    );
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

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');
    headers.set('x-bac-bridge-key', this.settings.bridgeKey);

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });
    const value = (await response.json()) as unknown;
    if (!response.ok) {
      throw new Error(parseProblemMessage(value) ?? `Companion HTTP ${String(response.status)}`);
    }
    return value;
  }
}

export const createCompanionClient = (settings: CompanionSettings): CompanionClient =>
  new HttpCompanionClient(settings);

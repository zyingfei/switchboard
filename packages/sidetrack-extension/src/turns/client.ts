import type { CompanionSettings, Problem } from '../companion/model';

export type TurnRole = 'user' | 'assistant' | 'system' | 'unknown';

export interface CapturedTurnRecord {
  readonly role: TurnRole;
  readonly text: string;
  readonly formattedText?: string;
  readonly ordinal: number;
  readonly capturedAt: string;
  readonly sourceSelector?: string;
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

const parseListResponse = (value: unknown): readonly CapturedTurnRecord[] => {
  if (!isRecord(value)) {
    throw new Error('Turns response was not an object.');
  }
  const envelope = value as { readonly data?: unknown };
  if (!Array.isArray(envelope.data)) {
    throw new Error('Turns response missing data array.');
  }
  return envelope.data as readonly CapturedTurnRecord[];
};

export interface TurnsClient {
  readonly recentForThread: (
    threadUrl: string,
    options?: { readonly limit?: number; readonly role?: TurnRole },
  ) => Promise<readonly CapturedTurnRecord[]>;
}

export class HttpTurnsClient implements TurnsClient {
  private readonly baseUrl: string;

  constructor(private readonly settings: CompanionSettings) {
    this.baseUrl = `http://127.0.0.1:${String(settings.port)}/v1`;
  }

  async recentForThread(
    threadUrl: string,
    options?: { readonly limit?: number; readonly role?: TurnRole },
  ): Promise<readonly CapturedTurnRecord[]> {
    const params = new URLSearchParams();
    params.set('threadUrl', threadUrl);
    if (options?.limit !== undefined) {
      params.set('limit', String(options.limit));
    }
    if (options?.role !== undefined) {
      params.set('role', options.role);
    }
    const path = `/turns?${params.toString()}`;
    return parseListResponse(await this.request(path));
  }

  private async request(path: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': this.settings.bridgeKey,
      },
    });
    const value = (await response.json()) as unknown;
    if (!response.ok) {
      throw new Error(parseProblemMessage(value) ?? `Companion HTTP ${String(response.status)}`);
    }
    return value;
  }
}

export const createTurnsClient = (settings: CompanionSettings): TurnsClient =>
  new HttpTurnsClient(settings);

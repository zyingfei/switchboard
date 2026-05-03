import type { CompanionSettings, Problem } from './model';

export interface RecallTurnInput {
  readonly id: string;
  readonly threadId: string;
  readonly capturedAt: string;
  readonly text: string;
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

export class RecallClient {
  private readonly baseUrl: string;

  constructor(private readonly settings: CompanionSettings) {
    this.baseUrl = `http://127.0.0.1:${String(settings.port)}/v1`;
  }

  async indexTurn(item: RecallTurnInput): Promise<void> {
    const response = await fetch(`${this.baseUrl}/recall/index`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': this.settings.bridgeKey,
      },
      body: JSON.stringify({ items: [item] }),
    });
    if (!response.ok) {
      const value = (await response.json().catch(() => ({}))) as unknown;
      throw new Error(parseProblemMessage(value) ?? `Companion HTTP ${String(response.status)}`);
    }
  }
}

export const createRecallClient = (settings: CompanionSettings): RecallClient =>
  new RecallClient(settings);

import type { CompanionSettings, Problem } from '../companion/model';
import type { SerializedAnchor } from './anchors';

export interface Annotation {
  readonly bac_id: string;
  readonly url: string;
  readonly pageTitle: string;
  readonly anchor: SerializedAnchor;
  readonly note: string;
  readonly createdAt: string;
}

const SETTINGS_KEY = 'sidetrack.settings';

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

const readCompanionSettings = async (): Promise<CompanionSettings | undefined> => {
  const result = await chrome.storage.local.get({ [SETTINGS_KEY]: undefined });
  const settings = result[SETTINGS_KEY];
  if (!isRecord(settings) || !isRecord(settings.companion)) {
    return undefined;
  }
  const companion = settings.companion;
  if (typeof companion.port !== 'number' || typeof companion.bridgeKey !== 'string') {
    return undefined;
  }
  if (companion.bridgeKey.trim().length === 0) {
    return undefined;
  }
  return { port: companion.port, bridgeKey: companion.bridgeKey };
};

class AnnotationClient {
  private readonly baseUrl: string;

  constructor(private readonly settings: CompanionSettings) {
    this.baseUrl = `http://127.0.0.1:${String(settings.port)}/v1`;
  }

  async createAnnotation(payload: {
    readonly url: string;
    readonly pageTitle: string;
    readonly anchor: SerializedAnchor;
    readonly note: string;
  }): Promise<Annotation> {
    const value = await this.request('/annotations', {
      method: 'POST',
      headers: { 'idempotency-key': `annotation-${crypto.randomUUID()}` },
      body: JSON.stringify(payload),
    });
    if (!isRecord(value) || !isRecord(value.data)) {
      throw new Error('Companion annotation response missing data.');
    }
    return value.data as unknown as Annotation;
  }

  async listAnnotationsForUrl(url: string): Promise<readonly Annotation[]> {
    const value = await this.request(`/annotations?url=${encodeURIComponent(url)}`, {
      method: 'GET',
    });
    if (!isRecord(value) || !Array.isArray(value.data)) {
      throw new Error('Companion annotation list response missing data array.');
    }
    return value.data as readonly Annotation[];
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');
    headers.set('x-bac-bridge-key', this.settings.bridgeKey);
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    const value = (await response.json()) as unknown;
    if (!response.ok) {
      throw new Error(parseProblemMessage(value) ?? `Companion HTTP ${String(response.status)}`);
    }
    return value;
  }
}

export const createAnnotationClient = async (): Promise<AnnotationClient | undefined> => {
  const settings = await readCompanionSettings();
  return settings === undefined ? undefined : new AnnotationClient(settings);
};

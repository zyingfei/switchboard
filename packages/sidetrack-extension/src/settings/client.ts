import type { CompanionSettings, Problem } from '../companion/model';
import type { SettingsDocument, SettingsPatch } from './types';

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

const parseProviderOptIn = (value: unknown): SettingsDocument['autoSendOptIn'] => {
  if (!isRecord(value)) {
    throw new Error('Settings autoSendOptIn missing.');
  }
  if (typeof value.chatgpt !== 'boolean' || typeof value.claude !== 'boolean' || typeof value.gemini !== 'boolean') {
    throw new Error('Settings autoSendOptIn missing required boolean per provider.');
  }
  return { chatgpt: value.chatgpt, claude: value.claude, gemini: value.gemini };
};

const parseDocument = (value: unknown): SettingsDocument => {
  if (!isRecord(value)) {
    throw new Error('Settings response was not an object.');
  }
  const envelope = value as { readonly data?: unknown };
  if (!isRecord(envelope.data)) {
    throw new Error('Settings response missing data envelope.');
  }
  const data = envelope.data;
  if (typeof data.revision !== 'string') {
    throw new Error('Settings response missing revision.');
  }
  if (typeof data.defaultPacketKind !== 'string') {
    throw new Error('Settings response missing defaultPacketKind.');
  }
  if (typeof data.defaultDispatchTarget !== 'string') {
    throw new Error('Settings response missing defaultDispatchTarget.');
  }
  if (typeof data.screenShareSafeMode !== 'boolean') {
    throw new Error('Settings response missing screenShareSafeMode.');
  }
  return {
    autoSendOptIn: parseProviderOptIn(data.autoSendOptIn),
    defaultPacketKind: data.defaultPacketKind as SettingsDocument['defaultPacketKind'],
    defaultDispatchTarget: data.defaultDispatchTarget as SettingsDocument['defaultDispatchTarget'],
    screenShareSafeMode: data.screenShareSafeMode,
    revision: data.revision,
  };
};

export interface SettingsClient {
  readonly read: () => Promise<SettingsDocument>;
  readonly patch: (changes: SettingsPatch) => Promise<SettingsDocument>;
}

export class HttpSettingsClient implements SettingsClient {
  private readonly baseUrl: string;

  constructor(private readonly settings: CompanionSettings) {
    this.baseUrl = `http://127.0.0.1:${String(settings.port)}/v1`;
  }

  async read(): Promise<SettingsDocument> {
    return parseDocument(await this.request('/settings', { method: 'GET' }));
  }

  async patch(changes: SettingsPatch): Promise<SettingsDocument> {
    return parseDocument(
      await this.request('/settings', {
        method: 'PATCH',
        body: JSON.stringify(changes),
      }),
    );
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

export const createSettingsClient = (settings: CompanionSettings): SettingsClient =>
  new HttpSettingsClient(settings);

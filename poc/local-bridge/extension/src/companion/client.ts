import type { BridgeEvent, BridgeSettings, CompanionStatus } from '../shared/messages';

export interface CompanionClient {
  status(): Promise<CompanionStatus>;
  writeEvent(event: BridgeEvent): Promise<CompanionStatus>;
  startTick(): Promise<CompanionStatus>;
  stopTick(): Promise<CompanionStatus>;
}

interface CompanionEnvelope {
  readonly ok?: boolean;
  readonly status?: CompanionStatus;
  readonly error?: string;
}

const assertStatus = (value: CompanionEnvelope | CompanionStatus): CompanionStatus => {
  if ('runId' in value) {
    return value;
  }
  if (!value.ok || !value.status) {
    throw new Error(value.error ?? 'Companion request failed');
  }
  return value.status;
};

class HttpCompanionClient implements CompanionClient {
  private readonly baseUrl: string;

  constructor(private readonly settings: BridgeSettings) {
    this.baseUrl = `http://127.0.0.1:${settings.port}`;
  }

  async status(): Promise<CompanionStatus> {
    return assertStatus(await this.request<CompanionStatus>('/status', { method: 'GET' }));
  }

  async writeEvent(event: BridgeEvent): Promise<CompanionStatus> {
    return assertStatus(
      await this.request<CompanionEnvelope>('/events', {
        method: 'POST',
        body: JSON.stringify(event),
      }),
    );
  }

  async startTick(): Promise<CompanionStatus> {
    return assertStatus(await this.request<CompanionStatus>('/tick/start', { method: 'POST', body: '{}' }));
  }

  async stopTick(): Promise<CompanionStatus> {
    return assertStatus(await this.request<CompanionStatus>('/tick/stop', { method: 'POST', body: '{}' }));
  }

  private async request<TValue>(path: string, init: RequestInit): Promise<TValue> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': this.settings.key ?? '',
        ...init.headers,
      },
    });
    const value = (await response.json()) as CompanionEnvelope | TValue;
    if (!response.ok) {
      throw new Error(
        typeof value === 'object' && value !== null && 'error' in value && value.error
          ? value.error
          : `Companion HTTP ${response.status}`,
      );
    }
    return value as TValue;
  }
}

class NativeMessagingCompanionClient implements CompanionClient {
  constructor(private readonly settings: BridgeSettings) {}

  async status(): Promise<CompanionStatus> {
    return assertStatus(await this.send('status'));
  }

  async writeEvent(event: BridgeEvent): Promise<CompanionStatus> {
    return assertStatus(await this.send('event', { event }));
  }

  async startTick(): Promise<CompanionStatus> {
    return assertStatus(await this.send('tick.start'));
  }

  async stopTick(): Promise<CompanionStatus> {
    return assertStatus(await this.send('tick.stop'));
  }

  private async send(type: string, extra: Record<string, unknown> = {}): Promise<CompanionEnvelope> {
    const host = this.settings.nativeHost || 'com.browser_ai_companion.local_bridge';
    return await new Promise((resolve, reject) => {
      chrome.runtime.sendNativeMessage(
        host,
        {
          id: crypto.randomUUID(),
          type,
          ...extra,
        },
        (response: CompanionEnvelope) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            reject(new Error(lastError.message));
            return;
          }
          resolve(response);
        },
      );
    });
  }
}

export const createCompanionClient = (settings: BridgeSettings): CompanionClient =>
  settings.transport === 'nativeMessaging'
    ? new NativeMessagingCompanionClient(settings)
    : new HttpCompanionClient(settings);

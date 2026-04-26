export const localBridgeMessages = {
  configure: 'BAC_LOCAL_BRIDGE_CONFIGURE',
  getState: 'BAC_LOCAL_BRIDGE_GET_STATE',
  writeTestEvent: 'BAC_LOCAL_BRIDGE_WRITE_TEST_EVENT',
  startTick: 'BAC_LOCAL_BRIDGE_START_TICK',
  stopTick: 'BAC_LOCAL_BRIDGE_STOP_TICK',
  drainQueue: 'BAC_LOCAL_BRIDGE_DRAIN_QUEUE',
} as const;

export type TransportKind = 'http' | 'nativeMessaging';

export interface BridgeSettings {
  readonly transport: TransportKind;
  readonly port: number;
  readonly key?: string;
  readonly nativeHost?: string;
}

export interface BridgeEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly sequenceNumber: number;
  readonly payload: 'synthetic';
  readonly source: 'manual' | 'tick' | 'queue-replay';
}

export interface CompanionStatus {
  readonly ok: true;
  readonly transport: TransportKind;
  readonly vaultPath: string;
  readonly startedAt: string;
  readonly runId: string;
  readonly tickRunning: boolean;
  readonly tickSequence: number;
  readonly lastWrite?: {
    readonly at: string;
    readonly latencyMs: number;
    readonly ok: boolean;
    readonly path?: string;
    readonly error?: string;
  };
}

export interface BridgeState {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly queueCount: number;
  readonly droppedCount: number;
  readonly settings?: Omit<BridgeSettings, 'key'> & { keyPresent: boolean };
  readonly companion?: CompanionStatus;
  readonly lastError?: string;
  readonly lastAction?: string;
}

export type LocalBridgeRequest =
  | { type: typeof localBridgeMessages.configure; settings: BridgeSettings }
  | { type: typeof localBridgeMessages.getState }
  | { type: typeof localBridgeMessages.writeTestEvent }
  | { type: typeof localBridgeMessages.startTick }
  | { type: typeof localBridgeMessages.stopTick }
  | { type: typeof localBridgeMessages.drainQueue };

export type LocalBridgeResponse =
  | { ok: true; state: BridgeState }
  | { ok: false; error: string; state: BridgeState };

export const isLocalBridgeRequest = (message: unknown): message is LocalBridgeRequest =>
  typeof message === 'object' &&
  message !== null &&
  'type' in message &&
  (Object.values(localBridgeMessages) as string[]).includes((message as { type: string }).type);

export const sendLocalBridgeMessage = async (
  message: LocalBridgeRequest,
  timeoutMs = 10_000,
): Promise<LocalBridgeResponse> =>
  await new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`Timed out waiting for ${message.type}`)), timeoutMs);
    chrome.runtime.sendMessage(message, (response: LocalBridgeResponse) => {
      window.clearTimeout(timer);
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(response);
    });
  });

export const buildSyntheticEvent = (sequenceNumber: number, source: BridgeEvent['source']): BridgeEvent => ({
  id: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  sequenceNumber,
  payload: 'synthetic',
  source,
});

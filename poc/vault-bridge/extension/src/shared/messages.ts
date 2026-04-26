export const bridgeMessages = {
  getState: 'BAC_VAULT_BRIDGE_GET_STATE',
  handleUpdated: 'BAC_VAULT_BRIDGE_HANDLE_UPDATED',
  writeTestEvent: 'BAC_VAULT_BRIDGE_WRITE_TEST_EVENT',
  startTick: 'BAC_VAULT_BRIDGE_START_TICK',
  stopTick: 'BAC_VAULT_BRIDGE_STOP_TICK',
} as const;

export type BridgeMessageType = (typeof bridgeMessages)[keyof typeof bridgeMessages];

export interface WriteOutcome {
  readonly at: string;
  readonly latencyMs: number;
  readonly ok: boolean;
  readonly kind: 'event' | 'observation';
  readonly path?: string;
  readonly browserVersion: string;
  readonly serviceWorkerState: string;
  readonly writeStrategy: string;
  readonly error?: string;
}

export interface BridgeState {
  readonly swStartedAt: string;
  readonly runId: string;
  readonly hasVaultHandle: boolean;
  readonly permission: PermissionState | 'unknown' | 'unavailable';
  readonly needsUserGrant: boolean;
  readonly tickRunning: boolean;
  readonly tickSequence: number;
  readonly observationPath: string;
  readonly lastEventPath?: string;
  readonly lastWrite?: WriteOutcome;
  readonly lastError?: string;
}

export type BridgeRequest =
  | { type: typeof bridgeMessages.getState }
  | { type: typeof bridgeMessages.handleUpdated }
  | { type: typeof bridgeMessages.writeTestEvent }
  | { type: typeof bridgeMessages.startTick }
  | { type: typeof bridgeMessages.stopTick };

export type BridgeResponse =
  | { ok: true; state: BridgeState }
  | { ok: false; error: string; state: BridgeState };

export const isBridgeRequest = (message: unknown): message is BridgeRequest =>
  typeof message === 'object' &&
  message !== null &&
  'type' in message &&
  Object.values(bridgeMessages).includes((message as { type: BridgeMessageType }).type);

export const sendBridgeMessage = async (message: BridgeRequest, timeoutMs = 10_000): Promise<BridgeResponse> =>
  await new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`Timed out waiting for ${message.type}`)), timeoutMs);
    chrome.runtime.sendMessage(message, (response: BridgeResponse) => {
      window.clearTimeout(timer);
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(response);
    });
  });

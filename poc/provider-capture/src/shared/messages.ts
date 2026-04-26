import type { ActiveTabSummary, CaptureState, ProviderCapture } from '../capture/model';

export const providerMessages = {
  getState: 'BAC_PROVIDER_GET_STATE',
  reset: 'BAC_PROVIDER_RESET',
  captureActiveTab: 'BAC_PROVIDER_CAPTURE_ACTIVE_TAB',
  captureVisibleThread: 'BAC_PROVIDER_CAPTURE_VISIBLE_THREAD',
  clearCaptures: 'BAC_PROVIDER_CLEAR_CAPTURES',
  storeCapture: 'BAC_PROVIDER_STORE_CAPTURE',
} as const;

export type ProviderMessageType = (typeof providerMessages)[keyof typeof providerMessages];

export type ProviderRequest =
  | { type: typeof providerMessages.getState }
  | { type: typeof providerMessages.reset }
  | { type: typeof providerMessages.captureActiveTab }
  | { type: typeof providerMessages.captureVisibleThread }
  | { type: typeof providerMessages.clearCaptures }
  | { type: typeof providerMessages.storeCapture; capture: ProviderCapture };

export type ProviderResponse =
  | { ok: true; state: CaptureState; activeTab?: ActiveTabSummary | null; capture?: ProviderCapture }
  | { ok: true; capture: ProviderCapture }
  | { ok: false; error: string; state?: CaptureState };

export const isProviderRequest = (message: unknown): message is ProviderRequest =>
  typeof message === 'object' &&
  message !== null &&
  'type' in message &&
  Object.values(providerMessages).includes((message as { type: ProviderMessageType }).type);

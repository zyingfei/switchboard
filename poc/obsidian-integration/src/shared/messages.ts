import type { ObsidianConnection, ThinSliceResult, VaultFileSummary } from '../obsidian/model';

export interface ObsidianPocState {
  connection: ObsidianConnection | null;
  result: ThinSliceResult | null;
  files: VaultFileSummary[];
  error: string;
}

export type ObsidianPocRequest =
  | { type: 'OBSIDIAN_GET_STATE' }
  | { type: 'OBSIDIAN_CONNECT'; connection: ObsidianConnection }
  | { type: 'OBSIDIAN_RUN_THIN_SLICE'; connection: ObsidianConnection }
  | { type: 'OBSIDIAN_RESET' };

export type ObsidianPocResponse =
  | { status: 'ok'; state: ObsidianPocState }
  | { status: 'error'; reason: string };

export const EMPTY_STATE: ObsidianPocState = {
  connection: null,
  result: null,
  files: [],
  error: '',
};

export const isObsidianPocRequest = (value: unknown): value is ObsidianPocRequest =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';

export const sendRuntimeMessage = async <TResponse extends ObsidianPocResponse>(
  message: ObsidianPocRequest,
  timeoutMs = 10_000,
): Promise<TResponse> =>
  await new Promise<TResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${message.type}`));
    }, timeoutMs);
    chrome.runtime.sendMessage(message, (rawResponse: TResponse) => {
      clearTimeout(timer);
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(rawResponse);
    });
  });

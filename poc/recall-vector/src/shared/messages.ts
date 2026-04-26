import type { ObsidianConnection } from '../obsidian/model';
import type { RecallBuildReport, RecallQueryReport, RuntimeDevice, RecencyWindow } from '../recall/model';

export interface BuildRecallIndexMessage {
  type: 'bac.recall.build';
  connection: ObsidianConnection;
  device?: RuntimeDevice;
}

export interface RunRecallQueryMessage {
  type: 'bac.recall.query';
  connection: ObsidianConnection;
  device?: RuntimeDevice;
  query: string;
  window: RecencyWindow;
  topK?: number;
  maskSnippets?: boolean;
}

export type RecallMessage = BuildRecallIndexMessage | RunRecallQueryMessage;

export interface RecallErrorResponse {
  ok: false;
  kind: 'error';
  error: string;
}

export interface BuildRecallIndexResponse {
  ok: true;
  kind: 'build';
  report: RecallBuildReport;
}

export interface RunRecallQueryResponse {
  ok: true;
  kind: 'query';
  report: RecallQueryReport;
}

export type RecallResponse =
  | RecallErrorResponse
  | BuildRecallIndexResponse
  | RunRecallQueryResponse;

export const sendRecallMessage = async (message: RecallMessage): Promise<RecallResponse> =>
  (await chrome.runtime.sendMessage(message)) as RecallResponse;

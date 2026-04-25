import type { DispatchPreflight } from '../preflight/dispatchPreflight';
import type { PatchMode } from '../patch/markdownPatch';
import type { PromptRun, WorkstreamNode } from '../graph/model';
import type { MockChatRuntimeMessage } from '../adapters/mockChatAdapter';
import type { ForkProvider } from '../adapters/providers';
import type { ContextPack } from '../context/contextPack';
import type { JsonRpcResponse } from '../mcp/server';
import type { DejaVuHit } from '../recall/dejaVu';
import type { ThreadRegistryEntry } from '../registry/threadRegistry';
import type { VaultProjection } from '../vault/projection';

export interface RunView {
  id: string;
  provider: string;
  title: string;
  status: PromptRun['status'];
  tabId?: number;
  url?: string;
  promptText: string;
  response?: {
    id: string;
    content: string;
  };
  failureReason?: string;
}

export interface WorkflowState {
  note: WorkstreamNode | null;
  runs: RunView[];
  responses: WorkstreamNode[];
  adoptedSources: WorkstreamNode[];
  threadRegistry: ThreadRegistryEntry[];
  preflights: DispatchPreflight[];
  patchPreview: {
    mode: PatchMode;
    original: string;
    proposed: string;
  } | null;
  vaultProjection: VaultProjection | null;
  contextPack: ContextPack | null;
  dejaVuHits: DejaVuHit[];
  mcpSmoke: JsonRpcResponse | null;
  eventCount: number;
}

export type PocRequest =
  | { type: 'POC_GET_STATE' }
  | { type: 'POC_SAVE_NOTE'; content: string }
  | { type: 'POC_FORK'; providers: ForkProvider[]; noteContent: string; autoSend: boolean }
  | { type: 'POC_OPEN_THREAD_FIXTURES' }
  | { type: 'POC_REFRESH_THREAD_REGISTRY' }
  | { type: 'POC_ADOPT_ACTIVE_TAB' }
  | { type: 'POC_BUILD_VAULT_PROJECTION' }
  | { type: 'POC_BUILD_CONTEXT_PACK' }
  | { type: 'POC_CHECK_DEJA_VU'; probeText: string }
  | { type: 'POC_MCP_SMOKE' }
  | { type: 'POC_BUILD_PATCH'; mode: PatchMode }
  | { type: 'POC_ACCEPT_PATCH' }
  | { type: 'POC_REJECT_PATCH' }
  | { type: 'POC_FOCUS_TAB'; tabId: number }
  | { type: 'POC_RESET' }
  | MockChatRuntimeMessage;

export type PocResponse =
  | { status: 'ok'; state: WorkflowState }
  | { status: 'ok' }
  | { status: 'error'; reason: string };

export const isPocRequest = (value: unknown): value is PocRequest =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';

export const sendRuntimeMessage = async <TResponse extends PocResponse>(
  message: PocRequest,
  timeoutMs = 5_000,
): Promise<TResponse> => {
  const response = await new Promise<TResponse>((resolve, reject) => {
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
  return response;
};

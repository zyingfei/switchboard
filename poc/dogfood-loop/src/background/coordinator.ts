import {
  MOCK_CHAT_CONFIGS,
  type MockChatProvider,
  createMockChatAdapter,
  type MockChatRuntimeMessage,
} from '../adapters/mockChatAdapter';
import type { ForkProvider } from '../adapters/providers';
import {
  SEARCH_PROVIDER_CONFIGS,
  buildSearchArtifact,
  buildSearchDispatch,
  buildSearchUrl,
  isSearchProvider,
} from '../adapters/searchAdapter';
import { buildDispatchPreflight, type DispatchPreflight } from '../preflight/dispatchPreflight';
import type { PatchMode } from '../patch/markdownPatch';
import type { GraphStore, JsonValue, WorkstreamNode } from '../graph/model';
import { buildContextPack as buildContextPackArtifact, type ContextPack } from '../context/contextPack';
import {
  acceptActivePatch,
  appendEvent,
  attachThreadTab,
  buildPromptText,
  createForkForTargets,
  createOrUpdateCurrentNote,
  createPatchPreview,
  getActivePatchPreview,
  getCurrentNote,
  updatePromptRunStatus,
  recordChatResponse,
} from '../graph/operations';
import type { JsonRpcResponse } from '../mcp/contract';
import { handleMcpRequest } from '../mcp/server';
import { findDejaVuHits, type DejaVuHit } from '../recall/dejaVu';
import {
  classifyThreadTab,
  sortThreadRegistry,
  type ThreadRegistryEntry,
} from '../registry/threadRegistry';
import type { RunView, WorkflowState } from '../shared/messages';
import {
  buildMockChatUrl,
  getDiscussionCandidateTab,
  openThreadFixtureTabs,
  focusTab,
  openMockChatTab,
  openSearchTab,
  waitForTabComplete,
} from './tabLocator';
import type { MockChatTransport } from '../adapters/mockChatAdapter';
import { nowIso } from '../shared/time';
import { buildVaultProjection as buildVaultProjectionArtifact, type VaultProjection } from '../vault/projection';
import { createId } from '../shared/ids';

const LAST_PREFLIGHTS_META_KEY = 'lastPreflights';
const LAST_THREAD_REGISTRY_META_KEY = 'lastThreadRegistry';
const LAST_VAULT_PROJECTION_META_KEY = 'lastVaultProjection';
const LAST_CONTEXT_PACK_META_KEY = 'lastContextPack';
const LAST_DEJA_VU_HITS_META_KEY = 'lastDejaVuHits';
const LAST_MCP_SMOKE_META_KEY = 'lastMcpSmoke';

const isMockChatProvider = (value: string): value is MockChatProvider =>
  value === 'mock-chat-a' || value === 'mock-chat-b';

const getMetadataNumber = (node: WorkstreamNode | null, key: string): number | undefined => {
  const value = node?.metadata?.[key];
  return typeof value === 'number' ? value : undefined;
};

const getMetadataString = (node: WorkstreamNode | null, key: string): string | undefined => {
  const value = node?.metadata?.[key];
  return typeof value === 'string' ? value : undefined;
};

const sendWithRetry = async (
  action: () => Promise<void>,
  attempts = 30,
  delayMs = 100,
): Promise<void> => {
  let lastError: unknown = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      await action();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Timed out sending message to tab');
};

export interface WorkflowCoordinator {
  getState(): Promise<WorkflowState>;
  saveNote(content: string): Promise<WorkflowState>;
  forkToProviders(
    providers: ForkProvider[],
    noteContent: string,
    autoSend: boolean,
  ): Promise<WorkflowState>;
  openThreadFixtures(): Promise<WorkflowState>;
  refreshThreadRegistry(): Promise<WorkflowState>;
  adoptActiveTab(): Promise<WorkflowState>;
  buildVaultProjection(): Promise<WorkflowState>;
  buildContextPack(): Promise<WorkflowState>;
  checkDejaVu(probeText: string): Promise<WorkflowState>;
  runMcpSmoke(): Promise<WorkflowState>;
  recordMockChatMessage(message: MockChatRuntimeMessage): Promise<void>;
  buildPatch(mode: PatchMode): Promise<WorkflowState>;
  acceptPatch(): Promise<WorkflowState>;
  rejectPatch(): Promise<WorkflowState>;
  focusTab(tabId: number): Promise<void>;
  reset(): Promise<WorkflowState>;
}

export interface WorkflowCoordinatorOptions {
  mockChatTransport?: MockChatTransport;
}

export const createWorkflowCoordinator = (
  store: GraphStore,
  options: WorkflowCoordinatorOptions = {},
): WorkflowCoordinator => {
  const adapters = {
    'mock-chat-a': createMockChatAdapter(MOCK_CHAT_CONFIGS['mock-chat-a'], options.mockChatTransport),
    'mock-chat-b': createMockChatAdapter(MOCK_CHAT_CONFIGS['mock-chat-b'], options.mockChatTransport),
  };

  const getThreadRegistryMeta = async (): Promise<ThreadRegistryEntry[]> => {
    const registry = await store.getMeta<JsonValue>(LAST_THREAD_REGISTRY_META_KEY);
    return Array.isArray(registry) ? (registry as unknown as ThreadRegistryEntry[]) : [];
  };

  const getRuntimeData = async () => {
    const [nodes, edges, promptRuns, events, threadRegistry] = await Promise.all([
      store.listNodes(),
      store.listEdges(),
      store.listPromptRuns(),
      store.listEvents(),
      getThreadRegistryMeta(),
    ]);
    return { nodes, edges, promptRuns, events, threadRegistry };
  };

  const scanThreadRegistry = async (): Promise<ThreadRegistryEntry[]> => {
    const tabs = await chrome.tabs.query({});
    const at = nowIso();
    const registry = sortThreadRegistry(
      tabs
        .map((tab) => classifyThreadTab(tab, at))
        .filter((entry): entry is ThreadRegistryEntry => entry !== null),
    );
    await store.setMeta(LAST_THREAD_REGISTRY_META_KEY, registry as unknown as JsonValue);
    await appendEvent(store, 'thread_registry.refreshed', undefined, {
      count: registry.length,
    });
    return registry;
  };

  const getResponsesByRunId = async (): Promise<Map<string, WorkstreamNode>> => {
    const nodes = await store.listNodes();
    const responses = new Map<string, WorkstreamNode>();
    for (const node of nodes) {
      if (node.type !== 'chat_response') {
        continue;
      }
      const runId = getMetadataString(node, 'runId');
      if (runId && !responses.has(runId)) {
        responses.set(runId, node);
      }
    }
    return responses;
  };

  const getState = async (): Promise<WorkflowState> => {
    const [
      note,
      promptRuns,
      nodes,
      preflights,
      patchPreview,
      events,
      threadRegistry,
      vaultProjection,
      contextPack,
      dejaVuHits,
      mcpSmoke,
    ] = await Promise.all([
      getCurrentNote(store),
      store.listPromptRuns(),
      store.listNodes(),
      store.getMeta<JsonValue>(LAST_PREFLIGHTS_META_KEY),
      getActivePatchPreview(store),
      store.listEvents(),
      getThreadRegistryMeta(),
      store.getMeta<JsonValue>(LAST_VAULT_PROJECTION_META_KEY),
      store.getMeta<JsonValue>(LAST_CONTEXT_PACK_META_KEY),
      store.getMeta<JsonValue>(LAST_DEJA_VU_HITS_META_KEY),
      store.getMeta<JsonValue>(LAST_MCP_SMOKE_META_KEY),
    ]);
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const responsesByRunId = await getResponsesByRunId();
    const runs: RunView[] = promptRuns.map((run) => {
      const thread = nodesById.get(run.targetThreadId) ?? null;
      const response = responsesByRunId.get(run.id);
      return {
        id: run.id,
        provider: thread?.provider ?? 'unknown',
        title: thread?.title ?? 'Unknown target',
        status: run.status,
        tabId: getMetadataNumber(thread, 'tabId'),
        url: thread?.url,
        promptText: run.promptText,
        response: response
          ? {
              id: response.id,
              content: response.content ?? '',
            }
          : undefined,
        failureReason: run.failureReason,
      };
    });
    return {
      note,
      runs,
      responses: nodes.filter((node) => node.type === 'chat_response'),
      adoptedSources: nodes.filter((node) => node.type === 'source'),
      threadRegistry,
      preflights: Array.isArray(preflights) ? (preflights as unknown as DispatchPreflight[]) : [],
      patchPreview,
      vaultProjection: vaultProjection ? (vaultProjection as unknown as VaultProjection) : null,
      contextPack: contextPack ? (contextPack as unknown as ContextPack) : null,
      dejaVuHits: Array.isArray(dejaVuHits) ? (dejaVuHits as unknown as DejaVuHit[]) : [],
      mcpSmoke: mcpSmoke ? (mcpSmoke as unknown as JsonRpcResponse) : null,
      eventCount: events.length,
    };
  };

  const forkToProviders = async (
    providers: ForkProvider[],
    noteContent: string,
    autoSend: boolean,
  ): Promise<WorkflowState> => {
    const uniqueProviders = [...new Set(providers)];
    const targets = uniqueProviders.map((provider) => ({
      provider,
      title: isSearchProvider(provider)
        ? SEARCH_PROVIDER_CONFIGS[provider].title
        : MOCK_CHAT_CONFIGS[provider].title,
      targetUrl: isSearchProvider(provider)
        ? buildSearchDispatch(provider, noteContent).url
        : buildMockChatUrl(provider, 'pending'),
      promptText: isSearchProvider(provider)
        ? buildSearchDispatch(provider, noteContent).query
        : undefined,
    }));
    const fork = await createForkForTargets(store, noteContent, targets);
    const preflights: DispatchPreflight[] = [];

    for (const run of fork.promptRuns) {
      const thread = await store.getNode(run.targetThreadId);
      const provider = thread?.provider ?? '';
      if (!isMockChatProvider(provider) && !isSearchProvider(provider)) {
        await updatePromptRunStatus(store, run.id, 'failed', `Unsupported provider: ${provider}`);
        continue;
      }
      const targetUrl = isSearchProvider(provider)
        ? buildSearchUrl(provider, run.promptText)
        : buildMockChatUrl(provider, run.id);
      const preflight = buildDispatchPreflight({
        targetProvider: provider,
        targetUrl,
        promptText: run.promptText,
        autoSend,
      });
      preflights.push(preflight);
      try {
        if (isSearchProvider(provider)) {
          const dispatch = {
            provider,
            title: SEARCH_PROVIDER_CONFIGS[provider].title,
            query: run.promptText,
            url: targetUrl,
          };
          const tab = await openSearchTab(dispatch);
          await attachThreadTab(store, run.targetThreadId, tab.url, tab.tabId);
          await updatePromptRunStatus(store, run.id, 'injected');
          await appendEvent(store, 'search.dispatched', run.id, {
            provider,
            query: dispatch.query,
            url: dispatch.url,
          });
          await updatePromptRunStatus(store, run.id, 'waiting');
          const completedTab = await waitForTabComplete(tab.tabId);
          await recordChatResponse(
            store,
            run.id,
            provider,
            `${SEARCH_PROVIDER_CONFIGS[provider].title} artifact`,
            buildSearchArtifact({
              provider,
              title: SEARCH_PROVIDER_CONFIGS[provider].title,
              query: dispatch.query,
              requestedUrl: dispatch.url,
              finalUrl: completedTab.url ?? dispatch.url,
              tabTitle: completedTab.title,
            }),
          );
        } else {
          const tab = await openMockChatTab(provider, run.id);
          await attachThreadTab(store, run.targetThreadId, tab.url, tab.tabId);
          await updatePromptRunStatus(store, run.id, 'injected');
          await sendWithRetry(async () => {
            await adapters[provider].injectInput(tab.tabId, run.promptText, { send: autoSend });
          });
          await updatePromptRunStatus(store, run.id, 'waiting');
        }
      } catch (error) {
        await updatePromptRunStatus(
          store,
          run.id,
          'failed',
          error instanceof Error ? error.message : 'Unknown injection failure',
        );
      }
    }

    await store.setMeta(LAST_PREFLIGHTS_META_KEY, preflights as unknown as JsonValue);
    await appendEvent(store, 'fork.dispatched', fork.note.id, {
      providers: uniqueProviders,
      runCount: fork.promptRuns.length,
    });
    return await getState();
  };

  return {
    getState,
    async saveNote(content) {
      await createOrUpdateCurrentNote(store, content);
      return await getState();
    },
    forkToProviders,
    async openThreadFixtures() {
      const openedTabs = await openThreadFixtureTabs();
      await Promise.all(openedTabs.map((tab) => waitForTabComplete(tab.tabId, 5_000)));
      await appendEvent(store, 'thread_fixture.opened');
      await scanThreadRegistry();
      return await getState();
    },
    async refreshThreadRegistry() {
      await scanThreadRegistry();
      return await getState();
    },
    async adoptActiveTab() {
      const tab = await getDiscussionCandidateTab();
      if (!tab || typeof tab.id !== 'number' || !tab.url) {
        throw new Error('No active tab is available to adopt.');
      }
      const at = nowIso();
      const registryEntry = classifyThreadTab(tab, at);
      if (registryEntry) {
        const current = await getThreadRegistryMeta();
        const next = sortThreadRegistry([
          ...current.filter((entry) => entry.id !== registryEntry.id),
          registryEntry,
        ]);
        await store.setMeta(LAST_THREAD_REGISTRY_META_KEY, next as unknown as JsonValue);
        await appendEvent(store, 'active_tab.adopted_thread', registryEntry.id, {
          provider: registryEntry.provider,
          title: registryEntry.title,
          url: registryEntry.url,
        });
        return await getState();
      }

      const note = await getCurrentNote(store);
      const source = {
        id: createId('source'),
        type: 'source',
        title: tab.title || 'Adopted active tab',
        content: `Adopted existing tab without DOM capture.\n\nURL: ${tab.url}`,
        url: tab.url,
        provider: 'browser-tab',
        metadata: {
          tabId: tab.id,
          sourceNoteId: note?.id ?? '',
          privacy: 'title-url-only',
        },
        createdAt: at,
        updatedAt: at,
      } satisfies WorkstreamNode;
      await store.saveNode(source);
      await appendEvent(store, 'active_tab.adopted_source', source.id, {
        title: source.title,
        url: source.url ?? '',
        tabId: tab.id,
      });
      return await getState();
    },
    async buildVaultProjection() {
      const { nodes, edges, promptRuns, events, threadRegistry } = await getRuntimeData();
      const projection = buildVaultProjectionArtifact({
        nodes,
        edges,
        promptRuns,
        events,
        threadRegistry,
        generatedAt: nowIso(),
      });
      await store.setMeta(LAST_VAULT_PROJECTION_META_KEY, projection as unknown as JsonValue);
      await appendEvent(store, 'vault_projection.built', undefined, {
        fileCount: projection.files.length,
      });
      return await getState();
    },
    async buildContextPack() {
      const { nodes, promptRuns, events, threadRegistry } = await getRuntimeData();
      const pack = buildContextPackArtifact({
        note: nodes.find((node) => node.type === 'note') ?? null,
        responses: nodes.filter((node) => node.type === 'chat_response'),
        sources: nodes.filter((node) => node.type === 'source'),
        promptRuns,
        events,
        threadRegistry,
        generatedAt: nowIso(),
      });
      await store.setMeta(LAST_CONTEXT_PACK_META_KEY, pack as unknown as JsonValue);
      await appendEvent(store, 'context_pack.built', undefined, {
        eventCount: events.length,
      });
      return await getState();
    },
    async checkDejaVu(probeText) {
      const nodes = await store.listNodes();
      const hits = findDejaVuHits(probeText, nodes, new Date());
      await store.setMeta(LAST_DEJA_VU_HITS_META_KEY, hits as unknown as JsonValue);
      await appendEvent(store, 'recall.deja_vu_checked', undefined, {
        hitCount: hits.length,
      });
      return await getState();
    },
    async runMcpSmoke() {
      const { nodes, promptRuns, events, threadRegistry } = await getRuntimeData();
      const smoke = handleMcpRequest(
        {
          jsonrpc: '2.0',
          id: 'poc-smoke',
          method: 'tools/call',
          params: { name: 'bac.recent_threads', arguments: {} },
        },
        {
          nodes,
          promptRuns,
          events,
          threadRegistry,
          generatedAt: nowIso(),
        },
      );
      await store.setMeta(LAST_MCP_SMOKE_META_KEY, smoke as unknown as JsonValue);
      await appendEvent(store, 'mcp.smoke_called', undefined, {
        hasResult: smoke.error ? false : true,
      });
      return await getState();
    },
    async recordMockChatMessage(message) {
      if (message.type === 'MOCK_CHAT_TURN') {
        await appendEvent(store, 'response.streaming', message.runId, {
          provider: message.provider,
          length: message.turn.content.length,
        });
        return;
      }
      const existing = (await getResponsesByRunId()).get(message.runId);
      if (existing) {
        return;
      }
      await recordChatResponse(
        store,
        message.runId,
        message.provider,
        `${MOCK_CHAT_CONFIGS[message.provider].title} response`,
        message.turn.content,
      );
    },
    async buildPatch(mode) {
      await createPatchPreview(store, mode);
      return await getState();
    },
    async acceptPatch() {
      await acceptActivePatch(store);
      return await getState();
    },
    async rejectPatch() {
      await store.setMeta('activePatchId', null);
      await appendEvent(store, 'patch.rejected');
      return await getState();
    },
    async focusTab(tabId) {
      await focusTab(tabId);
    },
    async reset() {
      await store.clear();
      return await getState();
    },
  };
};

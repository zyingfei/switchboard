import { ObsidianRestClient } from '../obsidian/restClient';
import { createDefaultEmbeddingCache, type EmbeddingCacheStore } from '../recall/cache';
import { TransformersJsEmbedder, type Embedder } from '../recall/embedder';
import { buildRecallIndexFromVault } from '../recall/indexBuilder';
import type { RecallQueryReport, RuntimeDevice } from '../recall/model';
import { RecallVectorIndex } from '../recall/vectorIndex';
import type {
  BuildRecallIndexMessage,
  BuildRecallIndexResponse,
  RecallMessage,
  RecallResponse,
  RunRecallQueryMessage,
  RunRecallQueryResponse,
} from '../shared/messages';

interface RecallCoordinatorState {
  key: string;
  embedder: Embedder;
  index: RecallVectorIndex;
  report: BuildRecallIndexResponse['report'];
}

const connectionKey = (baseUrl: string, apiKey: string, device: RuntimeDevice): string =>
  `${baseUrl}|${apiKey}|${device}`;

const cleanError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

export const createRecallCoordinator = (
  cache: EmbeddingCacheStore = createDefaultEmbeddingCache(),
): {
  handle(message: RecallMessage): Promise<RecallResponse>;
} => {
  let state: RecallCoordinatorState | null = null;

  const buildIndex = async (
    message: BuildRecallIndexMessage | RunRecallQueryMessage,
    forceRebuild: boolean,
  ): Promise<RecallCoordinatorState> => {
    const device = message.device ?? 'wasm';
    const key = connectionKey(message.connection.baseUrl, message.connection.apiKey, device);
    if (!forceRebuild && state && state.key === key) {
      return state;
    }

    const nextEmbedder = new TransformersJsEmbedder({ device });
    try {
      const client = new ObsidianRestClient(message.connection);
      await client.probe();
      const build = await buildRecallIndexFromVault({
        client,
        cache,
        embedder: nextEmbedder,
      });
      if (state && state.embedder !== nextEmbedder) {
        await state.embedder.dispose().catch(() => undefined);
      }
      state = {
        key,
        embedder: nextEmbedder,
        index: new RecallVectorIndex(build.records),
        report: build.report,
      };
      return state;
    } catch (error) {
      await nextEmbedder.dispose().catch(() => undefined);
      throw error;
    }
  };

  const handleBuild = async (message: BuildRecallIndexMessage): Promise<BuildRecallIndexResponse> => {
    const current = await buildIndex(message, true);
    return {
      ok: true,
      kind: 'build',
      report: current.report,
    };
  };

  const handleQuery = async (message: RunRecallQueryMessage): Promise<RunRecallQueryResponse> => {
    const current = await buildIndex(message, false);
    const topK = message.topK ?? 5;
    const maskSnippets = message.maskSnippets === true;

    const queryStart = Date.now();
    const queryEmbedding = await current.embedder.embed([message.query.trim()]);
    const searchStart = Date.now();
    const hits = current.index.search(Float32Array.from(queryEmbedding.embeddings[0] ?? []), {
      window: message.window,
      topK,
      now: new Date(current.report.generatedAt),
    });

    const report: RecallQueryReport = {
      generatedAt: new Date().toISOString(),
      query: message.query.trim(),
      window: message.window,
      topK,
      masked: maskSnippets,
      queryEmbeddingMs: queryEmbedding.latencyMs,
      searchMs: Date.now() - searchStart,
      latencyMs: Date.now() - queryStart,
      hits: maskSnippets
        ? hits.map((hit) => ({ ...hit, snippet: '[masked in screen-share-safe mode]' }))
        : hits,
    };

    return {
      ok: true,
      kind: 'query',
      report,
    };
  };

  return {
    async handle(message: RecallMessage): Promise<RecallResponse> {
      try {
        if (message.type === 'bac.recall.build') {
          return await handleBuild(message);
        }
        if (message.type === 'bac.recall.query') {
          return await handleQuery(message);
        }
        return {
          ok: false,
          kind: 'error',
          error: `Unknown message type: ${(message as { type?: string }).type ?? 'unknown'}`,
        };
      } catch (error) {
        return {
          ok: false,
          kind: 'error',
          error: cleanError(error),
        };
      }
    },
  };
};

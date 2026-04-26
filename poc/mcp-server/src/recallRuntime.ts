import { buildRecallIndexFromDocuments } from '../../recall-vector/src/recall/indexBuilder';
import { MemoryEmbeddingCache } from '../../recall-vector/src/recall/cache';
import {
  HashingEmbedder,
  TransformersJsEmbedder,
  type Embedder,
} from '../../recall-vector/src/recall/embedder';
import { loadVaultCorpus } from '../../recall-vector/src/recall/vaultCorpus';
import { RecallVectorIndex } from '../../recall-vector/src/recall/vectorIndex';
import type { RecallDocument, VectorRecord } from '../../recall-vector/src/recall/model';
import type { BacRecallRequest, BacRecallResponse } from '../../dogfood-loop/src/mcp/contract';

import type { ServerConfig } from './config';
import { computeVaultSignature, FsVaultClient } from './fsVaultClient';
import { maskSensitiveText } from './mask';

type RecallState = {
  readonly signature: string;
  readonly embedderKey: string;
  readonly embedder: Embedder;
  readonly records: VectorRecord[];
  readonly documentsById: Map<string, RecallDocument>;
};

const embedderKey = (config: ServerConfig): string => `${config.embedder.kind}:${config.embedder.device}`;

const matchesDocumentFilter = (
  document: RecallDocument | undefined,
  request: Pick<BacRecallRequest, 'project' | 'bucket'>,
): boolean => {
  if (!document) {
    return false;
  }
  if (request.project && document.metadata?.project !== request.project) {
    return false;
  }
  if (
    request.bucket &&
    document.metadata?.bucket !== request.bucket &&
    document.metadata?.topic !== request.bucket &&
    document.metadata?.bac_type !== request.bucket
  ) {
    return false;
  }
  return true;
};

const toRecencyBucket = (value: string): '0-3d' | '4-21d' | '22-90d' | '91d+' =>
  value === '0-3d' || value === '4-21d' || value === '22-90d' ? value : '91d+';

export class RecallRuntime {
  private readonly cache = new MemoryEmbeddingCache();
  private state: RecallState | null = null;

  constructor(
    private readonly config: ServerConfig,
    private readonly client = new FsVaultClient(config.vaultPath),
  ) {}

  private createEmbedder(): Embedder {
    return this.config.embedder.kind === 'transformers'
      ? new TransformersJsEmbedder({ device: this.config.embedder.device })
      : new HashingEmbedder(this.config.embedder.device);
  }

  private async buildState(): Promise<RecallState> {
    const signature = await computeVaultSignature(this.config.vaultPath);
    const key = embedderKey(this.config);
    if (this.state && this.state.signature === signature && this.state.embedderKey === key) {
      return this.state;
    }

    const documents = await loadVaultCorpus(this.client);
    const nextEmbedder = this.createEmbedder();
    try {
      const build = await buildRecallIndexFromDocuments({
        documents,
        cache: this.cache,
        embedder: nextEmbedder,
      });
      if (this.state) {
        await this.state.embedder.dispose().catch(() => undefined);
      }
      this.state = {
        signature,
        embedderKey: key,
        embedder: nextEmbedder,
        records: build.records,
        documentsById: new Map(documents.map((document) => [document.id, document])),
      };
      return this.state;
    } catch (error) {
      await nextEmbedder.dispose().catch(() => undefined);
      throw error;
    }
  }

  async query(request: BacRecallRequest): Promise<BacRecallResponse> {
    const state = await this.buildState();
    const filteredRecords = state.records.filter((record) =>
      matchesDocumentFilter(state.documentsById.get(record.sourceId), request),
    );
    const generatedAt = new Date().toISOString();

    if (filteredRecords.length === 0) {
      return {
        hits: [],
        generatedAt,
      };
    }

    const queryEmbedding = await state.embedder.embed([request.query.trim()]);
    const index = new RecallVectorIndex(filteredRecords);
    const hits = index.search(Float32Array.from(queryEmbedding.embeddings[0] ?? []), {
      window: request.recencyWindow ?? '3w',
      topK: request.topK ?? 5,
      now: new Date(),
    });

    return {
      hits: hits.map((hit) => ({
        title: hit.title,
        sourcePath: hit.sourcePath,
        capturedAt: hit.capturedAt,
        score: hit.score,
        snippet: this.config.screenShareSafe ? maskSensitiveText(hit.snippet) : hit.snippet,
        recencyBucket: toRecencyBucket(hit.recencyBucket),
      })),
      generatedAt,
    };
  }

  async close(): Promise<void> {
    if (this.state) {
      await this.state.embedder.dispose().catch(() => undefined);
    }
  }
}

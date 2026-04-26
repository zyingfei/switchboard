import { hashText } from './hash';
import type { RuntimeDevice } from './model';

export interface EmbedResult {
  embeddings: number[][];
  latencyMs: number;
}

export interface Embedder {
  readonly modelId: string;
  readonly requestedDevice: RuntimeDevice;
  readonly resolvedDevice: RuntimeDevice;
  embed(texts: string[]): Promise<EmbedResult>;
  dispose(): Promise<void>;
}

const normalize = (values: number[]): number[] => {
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) {
    return values;
  }
  return values.map((value) => value / magnitude);
};

const isNodeRuntime = (): boolean =>
  typeof process !== 'undefined' &&
  typeof process.release?.name === 'string' &&
  process.release.name === 'node';

export class HashingEmbedder implements Embedder {
  readonly modelId = 'hashing-test-embedder';
  readonly resolvedDevice: RuntimeDevice;

  constructor(readonly requestedDevice: RuntimeDevice = 'wasm') {
    this.resolvedDevice = requestedDevice;
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    const start = Date.now();
    const embeddings = texts.map((text) => {
      const digest = hashText(text);
      const values = Array.from({ length: 32 }, (_, index) => {
        const pair = digest.slice((index % 4) * 2, (index % 4) * 2 + 2);
        const parsed = Number.parseInt(pair || '00', 16);
        return ((parsed + index * 17) % 255) / 255;
      });
      return normalize(values);
    });
    return {
      embeddings,
      latencyMs: Date.now() - start,
    };
  }

  async dispose(): Promise<void> {
    return;
  }
}

export class TransformersJsEmbedder implements Embedder {
  readonly modelId: string;
  readonly requestedDevice: RuntimeDevice;
  resolvedDevice: RuntimeDevice;
  private extractorPromise: Promise<any> | null = null;

  constructor(options: { device?: RuntimeDevice; modelId?: string } = {}) {
    this.modelId = options.modelId ?? 'onnx-community/all-MiniLM-L6-v2-ONNX';
    this.requestedDevice = options.device ?? 'wasm';
    this.resolvedDevice = this.requestedDevice;
  }

  private async getExtractor() {
    if (this.extractorPromise) {
      return await this.extractorPromise;
    }
    this.extractorPromise = (async () => {
      const { env, pipeline } = await import('@huggingface/transformers');
      env.allowRemoteModels = true;
      env.allowLocalModels = false;
      env.useBrowserCache = typeof caches !== 'undefined';
      env.useFSCache = isNodeRuntime();
      const runtimeDevice =
        isNodeRuntime() && this.requestedDevice === 'wasm' ? 'cpu' : this.requestedDevice;
      this.resolvedDevice = runtimeDevice;
      try {
        return (await pipeline('feature-extraction', this.modelId, {
          device: runtimeDevice,
        })) as any;
      } catch (error) {
        if (this.requestedDevice === 'webgpu') {
          this.resolvedDevice = 'wasm';
          return (await pipeline('feature-extraction', this.modelId, {
            device: 'wasm',
          })) as any;
        }
        throw error;
      }
    })();
    return await this.extractorPromise;
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    const extractor = await this.getExtractor();
    const start = Date.now();
    const embeddings: number[][] = [];
    for (const text of texts) {
      const output = (await extractor(text, { pooling: 'mean', normalize: true })) as {
        data: Float32Array | number[];
      };
      embeddings.push(Array.from(output.data));
    }
    return {
      embeddings,
      latencyMs: Date.now() - start,
    };
  }

  async dispose(): Promise<void> {
    const extractor = await this.extractorPromise;
    if (extractor) {
      await extractor.dispose();
    }
  }
}

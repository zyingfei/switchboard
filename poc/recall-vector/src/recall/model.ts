export type RuntimeDevice = 'wasm' | 'webgpu' | 'cpu';
export type RecencyWindow = '3d' | '3w' | '3m' | '3y';
export type RecallSourceKind = 'markdown' | 'event';
export type StorageKind = 'indexeddb' | 'memory';

export interface RecallDocument {
  id: string;
  sourcePath: string;
  sourceKind: RecallSourceKind;
  title: string;
  text: string;
  capturedAt: string;
  metadata?: Record<string, string>;
}

export interface RecallChunk {
  id: string;
  digest: string;
  sourceId: string;
  sourcePath: string;
  sourceKind: RecallSourceKind;
  title: string;
  text: string;
  capturedAt: string;
  chunkIndex: number;
}

export interface EmbeddingCacheEntry {
  digest: string;
  text: string;
  embedding: number[];
  dimension: number;
  createdAt: string;
}

export interface VectorRecord extends RecallChunk {
  embedding: Float32Array;
}

export interface RecallTimings {
  loadMs: number;
  chunkMs: number;
  cacheMs: number;
  embedMs: number;
  hydrateMs: number;
  totalMs: number;
}

export interface RecallBuildReport {
  generatedAt: string;
  storage: StorageKind;
  modelId: string;
  requestedDevice: RuntimeDevice;
  resolvedDevice: RuntimeDevice;
  documents: number;
  chunks: number;
  uniqueDigests: number;
  embeddedDigests: number;
  cachedDigests: number;
  dimension: number;
  timings: RecallTimings;
}

export interface RecallHit {
  chunkId: string;
  title: string;
  sourcePath: string;
  sourceKind: RecallSourceKind;
  capturedAt: string;
  ageDays: number;
  recencyBucket: string;
  similarity: number;
  freshnessBoost: number;
  score: number;
  snippet: string;
}

export interface RecallQueryReport {
  generatedAt: string;
  query: string;
  window: RecencyWindow;
  topK: number;
  masked: boolean;
  queryEmbeddingMs: number;
  searchMs: number;
  latencyMs: number;
  hits: RecallHit[];
}

export interface RecallBuildResult {
  report: RecallBuildReport;
  records: VectorRecord[];
}

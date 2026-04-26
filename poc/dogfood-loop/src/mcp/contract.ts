import type { ContextPack } from '../context/contextPack';
import type { PromptRun, WorkstreamEvent, WorkstreamNode } from '../graph/model';
import type { DejaVuHit } from '../recall/dejaVu';
import type { ThreadRegistryEntry } from '../registry/threadRegistry';

export type BacToolName =
  | 'bac.recent_threads'
  | 'bac.workstream'
  | 'bac.context_pack'
  | 'bac.recall'
  | 'bac.search';

export interface BacRecentThreadsRequest {
  limit?: number;
}

export interface BacRecentThreadsResponse {
  threads: ThreadRegistryEntry[];
  generatedAt: string;
}

export interface BacWorkstreamRequest {
  includeEvents?: boolean;
}

export interface BacWorkstreamResponse {
  nodes: WorkstreamNode[];
  promptRuns: PromptRun[];
  events?: WorkstreamEvent[];
  generatedAt: string;
}

export type BacContextPackRequest = Record<string, never>;

export interface BacContextPackResponse {
  pack: ContextPack;
}

export interface BacRecallRequest {
  query: string;
  recencyWindow?: '3d' | '3w' | '3m' | '3y';
  topK?: number;
  project?: string;
  bucket?: string;
}

export interface BacRecallHit {
  title: string;
  sourcePath: string;
  capturedAt: string;
  score: number;
  snippet: string;
  recencyBucket: '0-3d' | '4-21d' | '22-90d' | '91d+';
}

export interface BacRecallResponse {
  hits: BacRecallHit[];
  generatedAt: string;
}

export interface BacSearchRequest {
  query: string;
  minAgeDays?: number;
  maxAgeDays?: number;
}

export interface BacSearchResponse {
  hits: DejaVuHit[];
  generatedAt: string;
}

export interface BacToolRequestMap {
  'bac.recent_threads': BacRecentThreadsRequest;
  'bac.workstream': BacWorkstreamRequest;
  'bac.context_pack': BacContextPackRequest;
  'bac.recall': BacRecallRequest;
  'bac.search': BacSearchRequest;
}

export interface BacToolResponseMap {
  'bac.recent_threads': BacRecentThreadsResponse;
  'bac.workstream': BacWorkstreamResponse;
  'bac.context_pack': BacContextPackResponse;
  'bac.recall': BacRecallResponse;
  'bac.search': BacSearchResponse;
}

export interface BacToolCallParams<TName extends BacToolName = BacToolName> {
  name: TName;
  arguments?: BacToolRequestMap[TName];
}

export interface McpRuntimeData {
  nodes: WorkstreamNode[];
  promptRuns: PromptRun[];
  events: WorkstreamEvent[];
  threadRegistry: ThreadRegistryEntry[];
  generatedAt: string;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export interface JsonContent<TValue> {
  type: 'json';
  json: TValue;
}

export interface TextContent {
  type: 'text';
  text: string;
}

export interface McpJsonToolResult<TValue> {
  content: [JsonContent<TValue>];
}

export interface McpTextToolResult<TValue> {
  content: [TextContent];
  structuredContent: TValue;
}

export type BacToolResult<TName extends BacToolName> =
  TName extends 'bac.context_pack'
    ? McpTextToolResult<BacToolResponseMap[TName]>
    : McpJsonToolResult<BacToolResponseMap[TName]>;

export interface McpToolDefinition<TName extends BacToolName = BacToolName> {
  name: TName;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: boolean;
  };
}

export const BAC_MCP_TOOL_DEFINITIONS = [
  {
    name: 'bac.recent_threads',
    description: 'Return observed browser AI threads from the local BAC registry.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bac.workstream',
    description: 'Return current workstream nodes and prompt runs.',
    inputSchema: {
      type: 'object',
      properties: {
        includeEvents: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bac.context_pack',
    description: 'Return a portable markdown Context Pack for the current workstream.',
    inputSchema: {
      type: 'object',
      properties: {
        includeEventLog: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bac.recall',
    description: 'Run calibrated-freshness semantic recall across the vault-backed BAC memory cache.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        recencyWindow: { type: 'string', enum: ['3d', '3w', '3m', '3y'] },
        topK: { type: 'number', minimum: 1 },
        project: { type: 'string' },
        bucket: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'bac.search',
    description: 'Run lexical local recall across BAC notes and branch artifacts.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        minAgeDays: { type: 'number', minimum: 0 },
        maxAgeDays: { type: 'number', minimum: 0 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
] as const satisfies readonly McpToolDefinition[];

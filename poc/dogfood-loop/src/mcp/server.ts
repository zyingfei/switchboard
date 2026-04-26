import { buildContextPack } from '../context/contextPack';
import { findDejaVuHits } from '../recall/dejaVu';
import {
  BAC_MCP_TOOL_DEFINITIONS,
  type BacContextPackResponse,
  type BacRecallRequest,
  type BacRecentThreadsRequest,
  type BacRecentThreadsResponse,
  type BacSearchRequest,
  type BacSearchResponse,
  type BacToolCallParams,
  type BacWorkstreamRequest,
  type BacWorkstreamResponse,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpJsonToolResult,
  type McpRuntimeData,
  type McpTextToolResult,
} from './contract';

export type { JsonRpcRequest, JsonRpcResponse, McpRuntimeData } from './contract';

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const readToolCall = (params: unknown): { name: string; args: Record<string, unknown> } => {
  const call = asRecord(params) as Partial<BacToolCallParams>;
  return {
    name: typeof call.name === 'string' ? call.name : '',
    args: asRecord(call.arguments),
  };
};

const readPositiveInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;

const readNonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

const jsonResult = <TValue>(json: TValue): McpJsonToolResult<TValue> => ({
  content: [{ type: 'json', json }],
});

const textResult = <TValue>(text: string, structuredContent: TValue): McpTextToolResult<TValue> => ({
  content: [{ type: 'text', text }],
  structuredContent,
});

export const handleMcpRequest = (
  request: JsonRpcRequest,
  data: McpRuntimeData,
): JsonRpcResponse => {
  const id = request.id ?? null;
  if (request.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: BAC_MCP_TOOL_DEFINITIONS },
    };
  }
  if (request.method !== 'tools/call') {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Unknown method: ${request.method}` },
    };
  }

  const { name, args } = readToolCall(request.params);
  if (name === 'bac.recent_threads') {
    const toolRequest: BacRecentThreadsRequest = {
      limit: readPositiveInteger(args.limit),
    };
    const response: BacRecentThreadsResponse = {
      threads: toolRequest.limit
        ? data.threadRegistry.slice(0, toolRequest.limit)
        : data.threadRegistry,
      generatedAt: data.generatedAt,
    };
    return {
      jsonrpc: '2.0',
      id,
      result: jsonResult(response),
    };
  }

  if (name === 'bac.workstream') {
    const toolRequest: BacWorkstreamRequest = {
      includeEvents: args.includeEvents === true,
    };
    const response: BacWorkstreamResponse = {
      nodes: data.nodes,
      promptRuns: data.promptRuns,
      generatedAt: data.generatedAt,
    };
    if (toolRequest.includeEvents) {
      response.events = data.events;
    }
    return {
      jsonrpc: '2.0',
      id,
      result: jsonResult(response),
    };
  }

  if (name === 'bac.context_pack') {
    const note = data.nodes.find((node) => node.type === 'note') ?? null;
    const responses = data.nodes.filter((node) => node.type === 'chat_response');
    const sources = data.nodes.filter((node) => node.type === 'source');
    const pack = buildContextPack({
      note,
      responses,
      sources,
      promptRuns: data.promptRuns,
      events: data.events,
      threadRegistry: data.threadRegistry,
      generatedAt: data.generatedAt,
    });
    const response: BacContextPackResponse = { pack };
    return {
      jsonrpc: '2.0',
      id,
      result: textResult(pack.markdown, response),
    };
  }

  if (name === 'bac.search') {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'bac.search requires a non-empty query' },
      };
    }
    const toolRequest: BacSearchRequest = {
      query,
      minAgeDays: readNonNegativeNumber(args.minAgeDays),
      maxAgeDays: readNonNegativeNumber(args.maxAgeDays),
    };
    const response: BacSearchResponse = {
      hits: findDejaVuHits(
        toolRequest.query,
        data.nodes,
        new Date(data.generatedAt),
        toolRequest.minAgeDays,
        toolRequest.maxAgeDays,
      ),
      generatedAt: data.generatedAt,
    };
    return {
      jsonrpc: '2.0',
      id,
      result: jsonResult(response),
    };
  }

  if (name === 'bac.recall') {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'bac.recall requires a non-empty query' },
      };
    }
    const _toolRequest: BacRecallRequest = {
      query,
      recencyWindow:
        args.recencyWindow === '3d' ||
        args.recencyWindow === '3w' ||
        args.recencyWindow === '3m' ||
        args.recencyWindow === '3y'
          ? args.recencyWindow
          : undefined,
      topK: readPositiveInteger(args.topK),
      project: typeof args.project === 'string' ? args.project : undefined,
      bucket: typeof args.bucket === 'string' ? args.bucket : undefined,
    };
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32004,
        message: 'bac.recall is owned by poc/recall-vector and is not wired into dogfood-loop yet',
      },
    };
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32602, message: `Unknown BAC tool: ${name}` },
  };
};

import { buildContextPack } from '../context/contextPack';
import type { PromptRun, WorkstreamEvent, WorkstreamNode } from '../graph/model';
import type { ThreadRegistryEntry } from '../registry/threadRegistry';

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

const tools = [
  {
    name: 'bac.recent_threads',
    description: 'Return observed browser AI threads from the local BAC registry.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'bac.workstream',
    description: 'Return current workstream nodes and prompt runs.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'bac.context_pack',
    description: 'Return a portable markdown Context Pack for the current workstream.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export const handleMcpRequest = (
  request: JsonRpcRequest,
  data: McpRuntimeData,
): JsonRpcResponse => {
  const id = request.id ?? null;
  if (request.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools },
    };
  }
  if (request.method !== 'tools/call') {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Unknown method: ${request.method}` },
    };
  }
  const params = request.params as { name?: unknown } | undefined;
  const name = typeof params?.name === 'string' ? params.name : '';
  if (name === 'bac.recent_threads') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'json', json: data.threadRegistry }],
      },
    };
  }
  if (name === 'bac.workstream') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'json',
            json: {
              nodes: data.nodes,
              promptRuns: data.promptRuns,
            },
          },
        ],
      },
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
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: pack.markdown }],
      },
    };
  }
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32602, message: `Unknown BAC tool: ${name}` },
  };
};

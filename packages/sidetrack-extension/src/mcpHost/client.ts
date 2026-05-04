import { getServer } from './registry';
import type { McpResult, McpTool, McpToolCall } from './types';

export class TimeoutError extends Error {
  constructor() {
    super('MCP host request timed out.');
    this.name = 'TimeoutError';
  }
}

export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

const requestJson = async (
  url: string,
  init: RequestInit,
  timeoutMs = 10_000,
): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new TransportError(`MCP server returned ${String(response.status)}.`);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new TimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const headersFor = (bearerToken: string | undefined): HeadersInit => ({
  'content-type': 'application/json',
  ...(bearerToken === undefined ? {} : { authorization: `Bearer ${bearerToken}` }),
});

const toolsFromResponse = (value: unknown): readonly McpTool[] => {
  if (typeof value !== 'object' || value === null) {
    throw new ProtocolError('MCP tools/list response was not an object.');
  }
  const tools = (value as { readonly tools?: unknown }).tools;
  if (!Array.isArray(tools)) {
    throw new ProtocolError('MCP tools/list response missing tools array.');
  }
  return tools.filter((tool): tool is McpTool => {
    if (typeof tool !== 'object' || tool === null || Array.isArray(tool)) {
      return false;
    }
    return typeof (tool as { readonly name?: unknown }).name === 'string';
  });
};

const requireServer = async (serverId: string) => {
  const server = await getServer(serverId);
  if (server === undefined) {
    throw new TransportError(`MCP server ${serverId} is not configured.`);
  }
  if (server.transport === 'sse') {
    throw new TransportError('SSE MCP host transport is not implemented yet.');
  }
  return server;
};

export const listTools = async (serverId: string): Promise<readonly McpTool[]> => {
  const server = await requireServer(serverId);
  const body = await requestJson(`${server.url.replace(/\/$/u, '')}/tools/list`, {
    method: 'POST',
    headers: headersFor(server.bearerToken),
    body: JSON.stringify({}),
  });
  return toolsFromResponse(body);
};

export const callTool = async (call: McpToolCall): Promise<McpResult> => {
  const server = await requireServer(call.serverId);
  const body = await requestJson(`${server.url.replace(/\/$/u, '')}/tools/call`, {
    method: 'POST',
    headers: headersFor(server.bearerToken),
    body: JSON.stringify({ name: call.tool, arguments: call.input }),
  });
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ProtocolError('MCP tools/call response was not an object.');
  }
  const record = body as { readonly content?: unknown; readonly structuredContent?: unknown; readonly error?: unknown };
  if (typeof record.error === 'string') {
    return { ok: false, error: record.error };
  }
  return {
    ok: true,
    content: record.content,
    ...(record.structuredContent === undefined ? {} : { structuredContent: record.structuredContent }),
  };
};

export interface McpServerConfig {
  readonly id: string;
  readonly url: string;
  readonly transport: 'http' | 'sse';
  readonly bearerToken?: string;
}

export interface McpToolCall {
  readonly serverId: string;
  readonly tool: string;
  readonly input: unknown;
}

export interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export type McpResult =
  | { readonly ok: true; readonly content: unknown; readonly structuredContent?: unknown }
  | { readonly ok: false; readonly error: string };

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export declare const sidetrackMcpWebSocketPath = "/mcp";
export declare const sidetrackMcpWebSocketPort = 8721;
export declare const mcpAuthenticationRequiredCode = -32001;
export interface WebSocketMcpServerOptions {
    readonly host?: string;
    readonly port?: number;
    readonly path?: string;
    readonly authKey?: string;
    readonly createServer: () => McpServer;
}
export interface StartedWebSocketMcpServer {
    readonly url: string;
    readonly close: () => Promise<void>;
}
export declare const startWebSocketMcpServer: (options: WebSocketMcpServerOptions) => Promise<StartedWebSocketMcpServer>;
//# sourceMappingURL=websocketServer.d.ts.map
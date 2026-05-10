import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export declare const sidetrackMcpHttpPath = "/mcp";
export declare const sidetrackMcpHttpPort = 8721;
export declare const mcpAuthenticationRequiredCode = -32001;
export interface StreamableHttpMcpServerOptions {
    readonly host?: string;
    readonly port?: number;
    readonly path?: string;
    readonly authKey?: string;
    readonly createServer: () => McpServer;
}
export interface StartedStreamableHttpMcpServer {
    readonly url: string;
    readonly close: () => Promise<void>;
}
export declare const startStreamableHttpMcpServer: (options: StreamableHttpMcpServerOptions) => Promise<StartedStreamableHttpMcpServer>;
//# sourceMappingURL=streamableHttpServer.d.ts.map
import { Client } from '../../../../sidetrack-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../../../sidetrack-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { createSidetrackMcpServer, type CompanionWriteClient } from '../../../../sidetrack-mcp/src/server/mcpServer.js';
import { LiveVaultReader } from '../../../../sidetrack-mcp/src/vault/liveVaultReader.js';

export interface InProcessMcp {
  readonly callTool: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  readonly close: () => Promise<void>;
}

export const startInProcessMcp = async (options: {
  readonly vaultPath: string;
  readonly companionClient?: CompanionWriteClient;
}): Promise<InProcessMcp> => {
  const server = createSidetrackMcpServer(
    new LiveVaultReader(options.vaultPath),
    options.companionClient,
  );
  const client = new Client({ name: 'sidetrack-extension-e2e', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    async callTool(name: string, args: Record<string, unknown> = {}) {
      return await client.callTool({ name, arguments: args });
    },
    async close() {
      await Promise.all([client.close(), server.close()]);
    },
  };
};

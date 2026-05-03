import { ensureBridgeKey } from '../auth/bridgeKey.js';
import { createIdempotencyStore } from '../http/idempotency.js';
import {
  createCompanionHttpServer,
  startHttpServer,
  type StartedHttpServer,
} from '../http/server.js';
import { createVaultWriter } from '../vault/writer.js';

export interface CompanionRuntimeOptions {
  readonly vaultPath: string;
  readonly port: number;
}

export interface CompanionRuntime {
  readonly url: string;
  readonly vaultPath: string;
  readonly bridgeKey: string;
  readonly bridgeKeyPath: string;
  readonly bridgeKeyCreated: boolean;
  readonly close: () => Promise<void>;
}

export const startCompanion = async (
  options: CompanionRuntimeOptions,
): Promise<CompanionRuntime> => {
  const ensured = await ensureBridgeKey(options.vaultPath);
  const vaultWriter = createVaultWriter(options.vaultPath);
  const server = createCompanionHttpServer({
    bridgeKey: ensured.key,
    vaultWriter,
    idempotencyStore: createIdempotencyStore(options.vaultPath),
  });
  const started: StartedHttpServer = await startHttpServer(server, options.port);

  return {
    url: started.url,
    vaultPath: options.vaultPath,
    bridgeKey: ensured.key,
    bridgeKeyPath: ensured.path,
    bridgeKeyCreated: ensured.created,
    close: started.close,
  };
};

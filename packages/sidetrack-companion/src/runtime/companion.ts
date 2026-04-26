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
  readonly close: () => Promise<void>;
}

export const startCompanion = async (
  options: CompanionRuntimeOptions,
): Promise<CompanionRuntime> => {
  const bridgeKey = await ensureBridgeKey(options.vaultPath);
  const vaultWriter = createVaultWriter(options.vaultPath);
  const server = createCompanionHttpServer({
    bridgeKey,
    vaultWriter,
    idempotencyStore: createIdempotencyStore(options.vaultPath),
  });
  const started: StartedHttpServer = await startHttpServer(server, options.port);

  return {
    url: started.url,
    close: started.close,
  };
};

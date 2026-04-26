import type { McpRuntimeData } from '../../dogfood-loop/src/mcp/contract';

import type { ServerConfig } from './config';
import { FsVaultClient } from './fsVaultClient';
import { loadProviderCaptures, capturesToPromptRuns, capturesToResponseNodes, capturesToSourceNodes, capturesToThreadRegistryEntries } from './readers/providerCapture';
import { loadVaultWorkstream } from './readers/workstream';
import { RecallRuntime } from './recallRuntime';

export class BacRuntime {
  readonly config: ServerConfig;
  private readonly vaultClient: FsVaultClient;
  private readonly recallRuntime: RecallRuntime;

  constructor(config: ServerConfig) {
    this.config = config;
    this.vaultClient = new FsVaultClient(config.vaultPath);
    this.recallRuntime = new RecallRuntime(config, this.vaultClient);
  }

  async readRuntimeData(): Promise<McpRuntimeData> {
    const captures = await loadProviderCaptures(this.config.providerCapturesPath);
    const vault = await loadVaultWorkstream(this.vaultClient, {
      project: this.config.project,
      currentNotePath: this.config.currentNotePath,
    });

    const noteId = vault.currentNote?.id ?? 'note:current';
    return {
      nodes: [
        ...(vault.currentNote ? [vault.currentNote] : []),
        ...capturesToResponseNodes(captures),
        ...capturesToSourceNodes(captures),
        ...vault.relatedSources,
      ],
      promptRuns: capturesToPromptRuns(captures, noteId),
      events: vault.events,
      threadRegistry: capturesToThreadRegistryEntries(captures),
      generatedAt: new Date().toISOString(),
    };
  }

  async recall(request: Parameters<RecallRuntime['query']>[0]) {
    return await this.recallRuntime.query(request);
  }

  async close(): Promise<void> {
    await this.recallRuntime.close();
  }
}

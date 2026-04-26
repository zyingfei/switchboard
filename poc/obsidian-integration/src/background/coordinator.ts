import { ObsidianRestClient } from '../obsidian/restClient';
import { runThinSliceProof } from '../obsidian/vaultSync';
import { nowIso } from '../shared/time';
import { EMPTY_STATE, type ObsidianPocState } from '../shared/messages';
import type { ObsidianConnection } from '../obsidian/model';

const STORAGE_KEY = 'obsidianPocState';

const readState = async (): Promise<ObsidianPocState> => {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return {
    ...EMPTY_STATE,
    ...((stored[STORAGE_KEY] as Partial<ObsidianPocState> | undefined) ?? {}),
  };
};

const writeState = async (state: ObsidianPocState): Promise<ObsidianPocState> => {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  return state;
};

const clientFor = (connection: ObsidianConnection): ObsidianRestClient =>
  new ObsidianRestClient(connection);

export interface ObsidianCoordinator {
  getState(): Promise<ObsidianPocState>;
  connect(connection: ObsidianConnection): Promise<ObsidianPocState>;
  runThinSlice(connection: ObsidianConnection): Promise<ObsidianPocState>;
  reset(): Promise<ObsidianPocState>;
}

export const createObsidianCoordinator = (): ObsidianCoordinator => ({
  async getState() {
    return await readState();
  },
  async connect(connection) {
    const client = clientFor(connection);
    const plugin = await client.probe();
    const files = await client.listFiles().catch(() => []);
    return await writeState({
      connection,
      result: {
        generatedAt: nowIso(),
        plugin,
        bacId: '',
        originalPath: '',
        movedPath: '',
        dashboardPath: '',
        canvasPath: '',
        basePath: '',
        evidence: [
          {
            id: 'connect',
            label: 'A1/A2 auth and plugin detection',
            status: plugin.ok ? 'passed' : 'failed',
            detail: `${plugin.service} ${plugin.version}`,
          },
        ],
        foundRecord: null,
        dashboardMatches: [],
        latencyMs: 0,
      },
      files,
      error: '',
    });
  },
  async runThinSlice(connection) {
    const client = clientFor(connection);
    const result = await runThinSliceProof(client, nowIso());
    const files = await client.listFiles().catch(() => []);
    return await writeState({
      connection,
      result,
      files,
      error: '',
    });
  },
  async reset() {
    await chrome.storage.local.remove(STORAGE_KEY);
    return EMPTY_STATE;
  },
});

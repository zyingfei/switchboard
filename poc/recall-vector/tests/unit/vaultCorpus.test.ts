import { describe, expect, it } from 'vitest';
import { loadVaultCorpus } from '../../src/recall/vaultCorpus';
import type { PluginProbe, VaultClient, VaultFileSummary } from '../../src/obsidian/model';

const listDirectory = (files: Map<string, string>, prefix: string): VaultFileSummary[] => {
  const normalizedPrefix = prefix ? `${prefix.replace(/\/+$/u, '')}/` : '';
  const children = new Set<string>();
  for (const path of files.keys()) {
    if (!path.startsWith(normalizedPrefix)) {
      continue;
    }
    const relativePath = path.slice(normalizedPrefix.length);
    if (!relativePath) {
      continue;
    }
    const [firstPart, ...rest] = relativePath.split('/');
    if (!firstPart) {
      continue;
    }
    children.add(rest.length > 0 ? `${firstPart}/` : firstPart);
  }
  return Array.from(children).sort().map((entry) => ({
    path: prefix ? `${prefix}/${entry}` : entry,
    type: entry.endsWith('/') ? 'folder' : 'file',
  }));
};

class MemoryVaultClient implements VaultClient {
  constructor(private readonly files: Map<string, string>) {}

  async probe(): Promise<PluginProbe> {
    return {
      ok: true,
      version: 'fixture',
      service: 'fixture',
    };
  }

  async listFiles(prefix = ''): Promise<VaultFileSummary[]> {
    return listDirectory(this.files, prefix.replace(/^\/+|\/+$/gu, ''));
  }

  async readFile(path: string): Promise<string> {
    const file = this.files.get(path);
    if (file === undefined) {
      throw new Error(`Missing fixture file: ${path}`);
    }
    return file;
  }
}

describe('loadVaultCorpus', () => {
  it('reads markdown notes and event logs from a vault-shaped corpus', async () => {
    const client = new MemoryVaultClient(
      new Map([
        [
          'Projects/SwitchBoard/Recall.md',
          [
            '---',
            'title: Recall note',
            'bac_type: thread',
            'bac_generated_at: "2026-04-24T09:00:00.000Z"',
            '---',
            '',
            '# Recall note',
            '',
            'Calibrated freshness keeps recent work nearby while still letting older context show up when it is semantically strong.',
          ].join('\n'),
        ],
        [
          '_BAC/events/2026-04-25.jsonl',
          `${JSON.stringify({ id: 'evt_1', type: 'note.created', entityId: 'Recall.md', createdAt: '2026-04-25T11:00:00.000Z' })}\n`,
        ],
      ]),
    );

    const documents = await loadVaultCorpus(client);

    expect(documents).toHaveLength(2);
    expect(documents[0]?.sourceKind).toBe('event');
    expect(documents[1]?.title).toBe('Recall note');
    expect(documents[1]?.capturedAt).toBe('2026-04-24T09:00:00.000Z');
  });
});

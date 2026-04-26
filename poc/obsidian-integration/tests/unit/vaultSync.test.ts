import { describe, expect, it } from 'vitest';
import type { FrontmatterValue, PluginProbe, VaultFileSummary } from '../../src/obsidian/model';
import { setFrontmatterField } from '../../src/obsidian/frontmatter';
import { appendUnderHeading } from '../../src/obsidian/headingPatch';
import { runThinSliceProof, type VaultClient } from '../../src/obsidian/vaultSync';

class MemoryVaultClient implements VaultClient {
  readonly files = new Map<string, string>();

  async probe(): Promise<PluginProbe> {
    return {
      ok: true,
      service: 'Memory Obsidian Fixture',
      version: 'unit',
    };
  }

  async listFiles(prefix = ''): Promise<VaultFileSummary[]> {
    const normalizedPrefix = prefix.replace(/^\/+|\/+$/gu, '');
    const directoryPrefix = normalizedPrefix ? `${normalizedPrefix}/` : '';
    const children = new Map<string, VaultFileSummary>();
    for (const [path, content] of this.files.entries()) {
      if (!path.startsWith(directoryPrefix)) {
        continue;
      }
      const relativePath = path.slice(directoryPrefix.length);
      if (!relativePath) {
        continue;
      }
      const [firstPart, ...rest] = relativePath.split('/');
      if (!firstPart) {
        continue;
      }
      const isFolder = rest.length > 0;
      const childPath = normalizedPrefix ? `${normalizedPrefix}/${firstPart}` : firstPart;
      children.set(childPath, {
        path: childPath,
        type: isFolder ? 'folder' : 'file',
        size: isFolder ? undefined : content.length,
      });
    }
    return Array.from(children.values()).sort((left, right) => left.path.localeCompare(right.path));
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`Missing file ${path}`);
    }
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async deleteFile(path: string): Promise<void> {
    this.files.delete(path);
  }

  async patchFrontmatter(path: string, key: string, value: FrontmatterValue): Promise<void> {
    this.files.set(path, setFrontmatterField(await this.readFile(path), key, value));
  }

  async patchHeading(path: string, heading: string, markdown: string): Promise<void> {
    this.files.set(path, appendUnderHeading(await this.readFile(path), heading, markdown));
  }
}

describe('thin-slice vault sync proof', () => {
  it('proves patch-frontmatter, heading append, bac_id scan, canvas, and base writes', async () => {
    const client = new MemoryVaultClient();
    const result = await runThinSliceProof(client, '2026-04-25T12:00:00.000Z');

    expect(result.evidence.every((item) => item.status === 'passed')).toBe(true);
    expect(result.originalPath).toBe('_BAC/inbox/2026-04-25/Claude - Browser-owned MCP.md');
    expect(result.movedPath).toBe('Projects/SwitchBoard/MCP discussion.md');
    expect(result.foundRecord?.topic).toBe('Security');
    expect(client.files.get(result.movedPath)).toContain('bac_id: thread_obsidian_poc_001');
    expect(client.files.get(result.canvasPath)).toContain('"type": "file"');
    expect(client.files.get(result.basePath)).toContain('project == "SwitchBoard"');
  });
});

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { FrontmatterValue, PluginProbe, VaultFileSummary } from '../../obsidian-integration/src/obsidian/model';

const normalizeVaultPath = (vaultPath = ''): string =>
  vaultPath
    .replace(/\\/gu, '/')
    .replace(/^\/+|\/+$/gu, '');

const toFsPath = (rootPath: string, vaultPath = ''): string => {
  const normalized = normalizeVaultPath(vaultPath);
  const resolved = path.resolve(rootPath, normalized);
  const relative = path.relative(rootPath, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Vault path escapes root: ${vaultPath}`);
  }
  return resolved;
};

const isReadableContentPath = (entryPath: string): boolean =>
  entryPath.endsWith('.md') || entryPath.endsWith('.jsonl');

const collectSignatureEntries = async (
  rootPath: string,
  vaultPath = '',
): Promise<string[]> => {
  const directory = toFsPath(rootPath, vaultPath);
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const rows: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childVaultPath = normalizeVaultPath(path.posix.join(vaultPath, entry.name));
    if (entry.isDirectory()) {
      rows.push(...(await collectSignatureEntries(rootPath, childVaultPath)));
      continue;
    }
    if (!entry.isFile() || !isReadableContentPath(childVaultPath)) {
      continue;
    }
    const stats = await fs.stat(toFsPath(rootPath, childVaultPath));
    rows.push(`${childVaultPath}:${stats.size}:${stats.mtimeMs}`);
  }

  return rows;
};

export const computeVaultSignature = async (rootPath: string): Promise<string> =>
  (await collectSignatureEntries(rootPath)).join('|');

export class FsVaultClient {
  constructor(private readonly rootPath: string) {}

  async probe(): Promise<PluginProbe> {
    await fs.access(this.rootPath);
    return {
      ok: true,
      version: process.version,
      service: 'Local FS Vault',
    };
  }

  async listFiles(prefix = ''): Promise<VaultFileSummary[]> {
    const normalizedPrefix = normalizeVaultPath(prefix);
    const directory = toFsPath(this.rootPath, normalizedPrefix);
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);

    const files = await Promise.all(
      entries.map(async (entry) => {
        const childPath = normalizeVaultPath(path.posix.join(normalizedPrefix, entry.name));
        if (entry.isDirectory()) {
          return {
            path: childPath,
            type: 'folder' as const,
          };
        }
        const stats = await fs.stat(toFsPath(this.rootPath, childPath));
        return {
          path: childPath,
          type: 'file' as const,
          size: stats.size,
        };
      }),
    );

    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  async readFile(vaultPath: string): Promise<string> {
    return await fs.readFile(toFsPath(this.rootPath, vaultPath), 'utf8');
  }

  async writeFile(_path: string, _content: string): Promise<void> {
    throw new Error('FsVaultClient is read-only in the MCP server POC');
  }

  async deleteFile(_path: string): Promise<void> {
    throw new Error('FsVaultClient is read-only in the MCP server POC');
  }

  async patchFrontmatter(_path: string, _key: string, _value: FrontmatterValue): Promise<void> {
    throw new Error('FsVaultClient is read-only in the MCP server POC');
  }

  async patchHeading(_path: string, _heading: string, _markdown: string): Promise<void> {
    throw new Error('FsVaultClient is read-only in the MCP server POC');
  }
}

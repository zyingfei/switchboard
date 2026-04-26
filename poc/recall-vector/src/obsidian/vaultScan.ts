import { stripFrontmatter } from './frontmatter';
import type { VaultClient, VaultFileSummary } from './model';

const MARKDOWN_RE = /\.md$/iu;
const normalizeVaultPath = (path: string): string => path.replace(/^\/+|\/+$/gu, '');

export const listVaultFilesRecursive = async (
  client: VaultClient,
  prefix = '',
  visitedFolders = new Set<string>(),
): Promise<VaultFileSummary[]> => {
  const normalizedPrefix = normalizeVaultPath(prefix);
  if (visitedFolders.has(normalizedPrefix)) {
    return [];
  }
  visitedFolders.add(normalizedPrefix);

  const entries = await client.listFiles(normalizedPrefix);
  const files: VaultFileSummary[] = [];
  for (const entry of entries) {
    const normalizedPath = normalizeVaultPath(entry.path);
    if (!normalizedPath) {
      continue;
    }
    if (entry.type === 'folder') {
      files.push({ ...entry, path: normalizedPath });
      files.push(...(await listVaultFilesRecursive(client, normalizedPath, visitedFolders)));
      continue;
    }
    files.push({ ...entry, path: normalizedPath });
  }
  return files;
};

export const listVaultMarkdownFiles = async (client: VaultClient): Promise<VaultFileSummary[]> =>
  (await listVaultFilesRecursive(client)).filter((entry) => entry.type === 'file' && MARKDOWN_RE.test(entry.path));

const firstHeading = (markdown: string): string | undefined => {
  const match = /^#\s+(.+)$/mu.exec(stripFrontmatter(markdown));
  return match?.[1]?.trim();
};

export const inferMarkdownTitle = (path: string, markdown: string): string =>
  firstHeading(markdown) ?? path.split('/').pop()?.replace(/\.md$/iu, '') ?? path;

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const normalizeVaultPath = (vaultPath = ''): string =>
  vaultPath.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');

export class VaultBinding {
  constructor(readonly vaultPath: string) {}

  resolve(vaultRelativePath: string): string {
    const normalized = normalizeVaultPath(vaultRelativePath);
    const resolved = path.resolve(this.vaultPath, normalized);
    const relative = path.relative(this.vaultPath, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Vault path escapes root: ${vaultRelativePath}`);
    }
    return resolved;
  }

  async atomicWrite(vaultRelativePath: string, content: string): Promise<string> {
    const target = this.resolve(vaultRelativePath);
    await mkdir(path.dirname(target), { recursive: true });
    const temp = path.join(
      path.dirname(target),
      `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
    );
    await writeFile(temp, content, 'utf8');
    await rename(temp, target).catch(async (error) => {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    });
    return normalizeVaultPath(path.relative(this.vaultPath, target));
  }

  async writeNote(vaultRelativePath: string, markdown: string): Promise<string> {
    return await this.atomicWrite(vaultRelativePath, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
  }

  async patchFrontmatter(vaultRelativePath: string, patch: Record<string, string | number | boolean>): Promise<string> {
    const target = this.resolve(vaultRelativePath);
    const original = await readFile(target, 'utf8').catch(() => '');
    const next = mergeFrontmatter(original, patch);
    return await this.atomicWrite(vaultRelativePath, next);
  }

  async attachToTrack(trackId: string, payload: unknown): Promise<string> {
    const safeTrackId = trackId.replace(/[^a-z0-9_.-]/giu, '-').slice(0, 80) || 'default';
    const target = `_BAC/tracks/${safeTrackId}.jsonl`;
    const existing = await readFile(this.resolve(target), 'utf8').catch(() => '');
    const next = `${existing}${JSON.stringify(payload)}\n`;
    return await this.atomicWrite(target, next);
  }
}

const renderFrontmatter = (values: Record<string, string | number | boolean>): string =>
  Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n');

export const mergeFrontmatter = (
  markdown: string,
  patch: Record<string, string | number | boolean>,
): string => {
  if (!markdown.startsWith('---\n')) {
    return `---\n${renderFrontmatter(patch)}\n---\n\n${markdown}`;
  }

  const end = markdown.indexOf('\n---', 4);
  if (end === -1) {
    return `---\n${renderFrontmatter(patch)}\n---\n\n${markdown}`;
  }

  const frontmatter = markdown.slice(4, end).trim();
  const body = markdown.slice(end + '\n---'.length).replace(/^\n/u, '');
  const values: Record<string, string | number | boolean> = {};
  for (const line of frontmatter.split('\n')) {
    const match = /^([^:#]+):\s*(.*)$/u.exec(line);
    if (!match) {
      continue;
    }
    values[match[1].trim()] = match[2].trim().replace(/^"|"$/gu, '');
  }
  Object.assign(values, patch);
  return `---\n${renderFrontmatter(values)}\n---\n${body.startsWith('\n') ? '' : '\n'}${body}`;
};

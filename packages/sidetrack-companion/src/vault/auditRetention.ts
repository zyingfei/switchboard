import { createGzip } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

export interface AuditRetentionResult {
  readonly removed: number;
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_AGE_DAYS = 90;
const MAX_ROTATIONS = 12;

const gzipFile = async (path: string, target: string): Promise<void> => {
  await pipeline(createReadStream(path), createGzip(), createWriteStream(target));
};

export const enforceRetention = async (
  vaultRoot: string,
  opts: { readonly maxBytes?: number; readonly maxAgeDays?: number } = {},
  now: Date = new Date(),
): Promise<AuditRetentionResult> => {
  const auditRoot = join(vaultRoot, '_BAC', 'audit');
  await mkdir(auditRoot, { recursive: true });
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxAgeMs = (opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 86_400_000;
  let removed = 0;
  const names = await readdir(auditRoot).catch(() => []);
  for (const name of names.filter((candidate) => candidate.endsWith('.jsonl'))) {
    const path = join(auditRoot, name);
    const info = await stat(path);
    if (info.size <= maxBytes && now.getTime() - info.mtimeMs <= maxAgeMs) {
      continue;
    }
    const rotated = join(
      auditRoot,
      `${basename(name, '.jsonl')}.${now.toISOString().replace(/[:.]/gu, '-')}.jsonl.gz`,
    );
    await gzipFile(path, rotated);
    await unlink(path);
  }
  const rotations = (await readdir(auditRoot).catch(() => []))
    .filter((candidate) => candidate.endsWith('.jsonl.gz'))
    .sort()
    .reverse();
  for (const stale of rotations.slice(MAX_ROTATIONS)) {
    await unlink(join(auditRoot, stale));
    removed += 1;
  }
  return { removed };
};

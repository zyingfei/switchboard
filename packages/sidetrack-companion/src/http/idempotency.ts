import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface IdempotencyRecord {
  readonly status: number;
  readonly body: unknown;
  readonly expiresAt?: string;
}

export interface IdempotencyStore {
  readonly read: (route: string, key: string) => Promise<IdempotencyRecord | undefined>;
  readonly write: (route: string, key: string, record: IdempotencyRecord) => Promise<void>;
  readonly gcExpired?: (now: Date) => Promise<{ readonly removed: number }>;
}

const TTL_MS = 24 * 60 * 60 * 1000;

const recordPath = (vaultPath: string, route: string, key: string): string => {
  const digest = createHash('sha256').update(`${route}\n${key}`).digest('hex');
  return join(vaultPath, '_BAC', '.config', 'idempotency', `${digest}.json`);
};

export const createIdempotencyStore = (vaultPath: string): IdempotencyStore => ({
  async read(route, key) {
    const path = recordPath(vaultPath, route, key);
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return undefined;
      }
      const record = parsed as { readonly status?: unknown; readonly body?: unknown };
      if (
        typeof (record as { readonly expiresAt?: unknown }).expiresAt === 'string' &&
        Date.parse((record as { readonly expiresAt: string }).expiresAt) <= Date.now()
      ) {
        return undefined;
      }
      return typeof record.status === 'number'
        ? {
            status: record.status,
            body: record.body,
            ...((record as { readonly expiresAt?: unknown }).expiresAt === undefined
              ? {}
              : { expiresAt: (record as { readonly expiresAt: string }).expiresAt }),
          }
        : undefined;
    } catch {
      return undefined;
    }
  },
  async write(route, key, record) {
    const path = recordPath(vaultPath, route, key);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify(
        { ...record, expiresAt: record.expiresAt ?? new Date(Date.now() + TTL_MS).toISOString() },
        null,
        2,
      )}\n`,
      'utf8',
    );
  },
  async gcExpired(now) {
    const root = join(vaultPath, '_BAC', '.config', 'idempotency');
    const names = await readdir(root).catch(() => []);
    let removed = 0;
    for (const name of names.filter((candidate) => candidate.endsWith('.json'))) {
      const path = join(root, name);
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as { readonly expiresAt?: unknown };
        if (typeof parsed.expiresAt === 'string' && Date.parse(parsed.expiresAt) <= now.getTime()) {
          await unlink(path);
          removed += 1;
        }
      } catch {
        await unlink(path).catch(() => undefined);
        removed += 1;
      }
    }
    return { removed };
  },
});

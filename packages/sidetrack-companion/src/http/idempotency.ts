import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface IdempotencyRecord {
  readonly status: number;
  readonly body: unknown;
}

export interface IdempotencyStore {
  readonly read: (route: string, key: string) => Promise<IdempotencyRecord | undefined>;
  readonly write: (route: string, key: string, record: IdempotencyRecord) => Promise<void>;
}

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
      return typeof record.status === 'number'
        ? { status: record.status, body: record.body }
        : undefined;
    } catch {
      return undefined;
    }
  },
  async write(route, key, record) {
    const path = recordPath(vaultPath, route, key);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  },
});

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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

// Idempotency receipts make a *retry* of the same request return the
// same result — real retries land within seconds, not days. The old
// 24h TTL kept a full day of response bodies on disk and let the
// receipt dir balloon to multiple GiB under heavy use; GC only removed
// already-expired entries, so the floor was "24h of traffic". 1h
// covers any realistic retry window — a later replay simply re-runs
// the operation (idempotency keys are per client attempt anyway).
const TTL_MS = 60 * 60 * 1000;

// Hard ceiling on receipt count. Even unexpired receipts are evicted
// oldest-first once the dir exceeds this, so a burst within the TTL
// window cannot grow the dir without bound.
const MAX_RECEIPTS = 5000;
const MAX_RECEIPT_DIR_BYTES = 128 * 1024 * 1024;

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
    await mkdir(dirname(path), { recursive: true });
    // Compact JSON — receipts are machine-read only; pretty-printing
    // inflated every body ~1.5× on disk for no benefit.
    await writeFile(
      path,
      `${JSON.stringify({
        expiresAt: record.expiresAt ?? new Date(Date.now() + TTL_MS).toISOString(),
        status: record.status,
        body: record.body,
      })}\n`,
      'utf8',
    );
  },
  async gcExpired(now) {
    const root = join(vaultPath, '_BAC', '.config', 'idempotency');
    const names = (await readdir(root).catch(() => [])).filter((candidate) =>
      candidate.endsWith('.json'),
    );
    let removed = 0;
    const rows: { path: string; mtimeMs: number; bytes: number }[] = [];
    for (const name of names) {
      const path = join(root, name);
      try {
        const info = await stat(path);
        if (info.isFile()) rows.push({ path, mtimeMs: info.mtimeMs, bytes: info.size });
      } catch {
        await unlink(path).catch(() => undefined);
        removed += 1;
      }
    }

    const budgetEvictions = new Set<string>();
    let survivorCount = rows.length;
    let survivorBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
    for (const row of [...rows].sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      if (survivorCount <= MAX_RECEIPTS && survivorBytes <= MAX_RECEIPT_DIR_BYTES) break;
      budgetEvictions.add(row.path);
      survivorCount -= 1;
      survivorBytes -= row.bytes;
    }
    for (const path of budgetEvictions) {
      await unlink(path).catch(() => undefined);
      removed += 1;
    }

    for (const row of rows) {
      if (budgetEvictions.has(row.path)) continue;
      try {
        const parsed = JSON.parse(await readFile(row.path, 'utf8')) as {
          readonly expiresAt?: unknown;
        };
        if (typeof parsed.expiresAt === 'string' && Date.parse(parsed.expiresAt) <= now.getTime()) {
          await unlink(row.path);
          removed += 1;
        }
      } catch {
        await unlink(row.path).catch(() => undefined);
        removed += 1;
      }
    }
    return { removed };
  },
});

import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export type GcGroup =
  | 'connections-temp'
  | 'visit-similarity-revisions'
  | 'topic-revisions'
  | 'diagnostics-history'
  | 'debug-dumps'
  | 'expired-idempotency'
  | 'closest-visit-revisions';

export interface GcPlanEntry {
  readonly path: string;
  readonly group: GcGroup;
  readonly bytes: number;
  readonly reason: string;
}

export interface GcPlan {
  readonly vaultRoot: string;
  readonly producedAt: string;
  readonly entries: readonly GcPlanEntry[];
  readonly totalBytes: number;
}

export interface BuildGcPlanOptions {
  readonly now?: Date;
  readonly keepRecentRevisions?: number;
  readonly keepDiagnostics?: number;
  readonly keepDebugDumps?: number;
}

export interface GcInventory {
  readonly producedAt: string;
  readonly groups: Record<GcGroup, { readonly count: number; readonly bytes: number }>;
  readonly totalCount: number;
  readonly totalBytes: number;
}

const fileInfo = async (
  path: string,
): Promise<{ readonly path: string; readonly mtimeMs: number; readonly bytes: number } | null> => {
  const info = await stat(path).catch(() => null);
  if (info === null || !info.isFile()) return null;
  return { path, mtimeMs: info.mtimeMs, bytes: info.size };
};

const listFiles = async (
  dir: string,
): Promise<
  readonly { readonly path: string; readonly mtimeMs: number; readonly bytes: number }[]
> => {
  const names = await readdir(dir).catch(() => []);
  const rows = await Promise.all(names.map((name) => fileInfo(join(dir, name))));
  return rows.filter((row): row is NonNullable<typeof row> => row !== null);
};

const listFilesRecursive = async (
  dir: string,
): Promise<
  readonly { readonly path: string; readonly mtimeMs: number; readonly bytes: number }[]
> => {
  const names = await readdir(dir).catch(() => []);
  const out: { path: string; mtimeMs: number; bytes: number }[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (info === null) continue;
    if (info.isDirectory()) {
      out.push(...(await listFilesRecursive(path)));
    } else if (info.isFile()) {
      out.push({ path, mtimeMs: info.mtimeMs, bytes: info.size });
    }
  }
  return out;
};

const oldRevisions = (
  rows: readonly { readonly path: string; readonly mtimeMs: number; readonly bytes: number }[],
  keep: number,
  protectedBasenames: ReadonlySet<string>,
): readonly { readonly path: string; readonly mtimeMs: number; readonly bytes: number }[] =>
  rows
    .filter((row) => row.path.endsWith('.json'))
    .filter((row) => !protectedBasenames.has(row.path.split('/').at(-1) ?? ''))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(Math.max(0, keep));

const appendEntries = (
  entries: GcPlanEntry[],
  rows: readonly { readonly path: string; readonly bytes: number }[],
  group: GcGroup,
  reason: string,
): void => {
  for (const row of rows) {
    entries.push({ path: row.path, group, bytes: row.bytes, reason });
  }
};

const expiredIdempotency = async (
  vaultRoot: string,
  now: Date,
): Promise<readonly { readonly path: string; readonly bytes: number }[]> => {
  const root = join(vaultRoot, '_BAC', '.config', 'idempotency');
  const rows = await listFiles(root);
  const expired: { path: string; bytes: number }[] = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(await readFile(row.path, 'utf8')) as {
        readonly expiresAt?: unknown;
      };
      if (typeof parsed.expiresAt === 'string' && Date.parse(parsed.expiresAt) <= now.getTime()) {
        expired.push({ path: row.path, bytes: row.bytes });
      }
    } catch {
      expired.push({ path: row.path, bytes: row.bytes });
    }
  }
  return expired;
};

export const buildGcPlan = async (
  vaultRoot: string,
  options: BuildGcPlanOptions = {},
): Promise<GcPlan> => {
  const now = options.now ?? new Date();
  const keepRecentRevisions = options.keepRecentRevisions ?? 20;
  const keepDiagnostics = options.keepDiagnostics ?? 500;
  const keepDebugDumps = options.keepDebugDumps ?? 10;
  const entries: GcPlanEntry[] = [];

  const connectionsRoot = join(vaultRoot, '_BAC', 'connections');
  const tempCutoff = now.getTime() - 10 * 60 * 1000;
  appendEntries(
    entries,
    (await listFilesRecursive(connectionsRoot)).filter(
      (row) => row.path.endsWith('.tmp') && row.mtimeMs <= tempCutoff,
    ),
    'connections-temp',
    'stale atomic-write temp file older than 10 minutes',
  );

  appendEntries(
    entries,
    oldRevisions(
      await listFiles(join(connectionsRoot, 'visit-similarity')),
      keepRecentRevisions,
      new Set(['current.json']),
    ),
    'visit-similarity-revisions',
    `derived visit-similarity revision outside newest ${String(keepRecentRevisions)}`,
  );

  appendEntries(
    entries,
    oldRevisions(
      await listFiles(join(connectionsRoot, 'topics')),
      keepRecentRevisions,
      new Set(['current.json', 'current.shadow.json']),
    ),
    'topic-revisions',
    `derived topic revision outside newest ${String(keepRecentRevisions)}`,
  );

  appendEntries(
    entries,
    oldRevisions(
      await listFiles(join(connectionsRoot, 'diagnostics')),
      keepDiagnostics,
      new Set(['latest.json']),
    ),
    'diagnostics-history',
    `diagnostics snapshot outside newest ${String(keepDiagnostics)}`,
  );

  appendEntries(
    entries,
    oldRevisions(
      await listFiles(join(vaultRoot, '_BAC', 'debug-dumps')),
      keepDebugDumps,
      new Set(['latest.json']),
    ),
    'debug-dumps',
    `debug dump outside newest ${String(keepDebugDumps)}`,
  );

  appendEntries(
    entries,
    oldRevisions(
      await listFiles(join(connectionsRoot, 'closest-visit')),
      keepRecentRevisions,
      new Set(['current.json', 'current.model.b64']),
    ),
    'closest-visit-revisions',
    `derived closest-visit ranker file outside newest ${String(keepRecentRevisions)}`,
  );

  appendEntries(
    entries,
    await expiredIdempotency(vaultRoot, now),
    'expired-idempotency',
    'expired idempotency replay record',
  );

  const sorted = entries.sort(
    (left, right) => left.group.localeCompare(right.group) || left.path.localeCompare(right.path),
  );
  return {
    vaultRoot,
    producedAt: now.toISOString(),
    entries: sorted,
    totalBytes: sorted.reduce((sum, entry) => sum + entry.bytes, 0),
  };
};

export const applyGcPlan = async (
  plan: GcPlan,
): Promise<{
  readonly removed: number;
  readonly bytes: number;
  readonly errors: readonly string[];
}> => {
  let removed = 0;
  let bytes = 0;
  const errors: string[] = [];
  for (const entry of plan.entries) {
    try {
      await unlink(entry.path);
      removed += 1;
      bytes += entry.bytes;
    } catch (error) {
      errors.push(`${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { removed, bytes, errors };
};

const ALL_GC_GROUPS: readonly GcGroup[] = [
  'connections-temp',
  'visit-similarity-revisions',
  'topic-revisions',
  'diagnostics-history',
  'debug-dumps',
  'expired-idempotency',
  'closest-visit-revisions',
];

export const gcInventory = async (
  vaultRoot: string,
  options: BuildGcPlanOptions = {},
): Promise<GcInventory> => {
  const plan = await buildGcPlan(vaultRoot, options);

  const groups = Object.fromEntries(
    ALL_GC_GROUPS.map((group) => [group, { count: 0, bytes: 0 }]),
  ) as Record<GcGroup, { count: number; bytes: number }>;

  for (const entry of plan.entries) {
    const bucket = groups[entry.group];
    bucket.count += 1;
    bucket.bytes += entry.bytes;
  }

  return {
    producedAt: plan.producedAt,
    groups,
    totalCount: plan.entries.length,
    totalBytes: plan.totalBytes,
  };
};

// Plan follow-up #15: gcInventory walks ~thousands of derived files on
// a real vault and exceeds any sane synchronous HTTP budget, so the
// hygiene-status endpoint was honestly-but-permanently `unavailable`.
// Fix: a per-vault TTL cache with background refresh. The endpoint
// reads O(1); the expensive walk happens off the request. Honesty
// preserved: `unavailable` until the first compute lands, `stale` while
// a refresh is in flight on an expired entry, `ok` when fresh.

export const GC_INVENTORY_TTL_MS = 5 * 60_000;

export interface GcInventoryCached {
  readonly value: GcInventory | null;
  readonly asOf: string | null;
  readonly availability: 'ok' | 'stale' | 'unavailable';
}

interface GcInventoryCacheEntry {
  readonly value: GcInventory;
  readonly computedAt: number;
}

const gcInventoryCache = new Map<string, GcInventoryCacheEntry>();
const gcInventoryInFlight = new Map<string, Promise<void>>();

/** Test-only: drop cached state so timing-sensitive tests are deterministic. */
export const __resetGcInventoryCache = (): void => {
  gcInventoryCache.clear();
  gcInventoryInFlight.clear();
};

const refreshGcInventory = (vaultRoot: string, options: BuildGcPlanOptions): Promise<void> => {
  const existing = gcInventoryInFlight.get(vaultRoot);
  if (existing !== undefined) return existing;
  const run = (async () => {
    try {
      const value = await gcInventory(vaultRoot, options);
      gcInventoryCache.set(vaultRoot, { value, computedAt: Date.now() });
    } catch {
      // Keep the previous cache entry (if any); a failed refresh must
      // not erase a usable older value.
    } finally {
      gcInventoryInFlight.delete(vaultRoot);
    }
  })();
  gcInventoryInFlight.set(vaultRoot, run);
  return run;
};

export const gcInventoryCached = async (
  vaultRoot: string,
  options: BuildGcPlanOptions = {},
  opts: { readonly ttlMs?: number; readonly awaitFresh?: boolean } = {},
): Promise<GcInventoryCached> => {
  const ttlMs = opts.ttlMs ?? GC_INVENTORY_TTL_MS;
  const cached = gcInventoryCache.get(vaultRoot);
  const fresh = cached !== undefined && Date.now() - cached.computedAt < ttlMs;

  if (fresh) {
    return {
      value: cached.value,
      asOf: new Date(cached.computedAt).toISOString(),
      availability: 'ok',
    };
  }

  const refresh = refreshGcInventory(vaultRoot, options);
  if (opts.awaitFresh === true) {
    await refresh;
    const after = gcInventoryCache.get(vaultRoot);
    return after === undefined
      ? { value: null, asOf: null, availability: 'unavailable' }
      : {
          value: after.value,
          asOf: new Date(after.computedAt).toISOString(),
          availability: 'ok',
        };
  }

  // Non-blocking: serve the previous (stale) value if we have one,
  // otherwise an honest `unavailable` while the first compute runs.
  return cached === undefined
    ? { value: null, asOf: null, availability: 'unavailable' }
    : {
        value: cached.value,
        asOf: new Date(cached.computedAt).toISOString(),
        availability: 'stale',
      };
};

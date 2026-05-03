export interface UpdateAdvisory {
  readonly current: string;
  readonly latest: string | null;
  readonly behind: boolean;
  readonly ageDays: number | null;
  readonly releasedAt: string | null;
  readonly warning?: string;
}

interface CacheEntry {
  readonly checkedAtMs: number;
  readonly advisory: UpdateAdvisory;
}

const CACHE_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 5_000;
let cache: CacheEntry | undefined;

const parseVersion = (value: string): readonly [number, number, number] => {
  const [major = '0', minor = '0', patch = '0'] = value.replace(/^v/u, '').split('.');
  return [
    Number.parseInt(major, 10) || 0,
    Number.parseInt(minor, 10) || 0,
    Number.parseInt(patch, 10) || 0,
  ];
};

// Tiny major/minor/patch comparator: companion publishes plain npm
// semver today, and avoiding a semver dep keeps this advisory read-only
// path lightweight.
export const isBehind = (current: string, latest: string): boolean => {
  const currentParts = parseVersion(current);
  const latestParts = parseVersion(latest);
  for (let index = 0; index < 3; index += 1) {
    const currentPart = currentParts[index] ?? 0;
    const latestPart = latestParts[index] ?? 0;
    if (currentPart < latestPart) {
      return true;
    }
    if (currentPart > latestPart) {
      return false;
    }
  }
  return false;
};

const registryResponse = (
  value: unknown,
): { readonly version: string; readonly time?: string } | null => {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as { readonly version?: unknown; readonly time?: unknown };
  if (typeof record.version !== 'string') {
    return null;
  }
  return {
    version: record.version,
    ...(typeof record.time === 'string' ? { time: record.time } : {}),
  };
};

export const clearVersionCheckCache = (): void => {
  cache = undefined;
};

export const checkLatestVersion = async (
  currentVersion: string,
  fetchPort: typeof globalThis.fetch = globalThis.fetch,
  now: Date = new Date(),
): Promise<UpdateAdvisory> => {
  if (cache !== undefined && now.getTime() - cache.checkedAtMs < CACHE_MS) {
    return cache.advisory;
  }
  try {
    const controller = new AbortController();
    // Five seconds keeps the status endpoint responsive when npm or the
    // network is unavailable; failure returns a warning instead of throwing.
    const timeout = setTimeout(() => {
      controller.abort();
    }, TIMEOUT_MS);
    const response = await fetchPort('https://registry.npmjs.org/@sidetrack/companion/latest', {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      throw new Error(`npm registry returned ${String(response.status)}`);
    }
    const parsed = registryResponse(await response.json());
    if (parsed === null) {
      throw new Error('npm registry response missing version');
    }
    const releasedAt = parsed.time ?? null;
    const advisory: UpdateAdvisory = {
      current: currentVersion,
      latest: parsed.version,
      behind: isBehind(currentVersion, parsed.version),
      releasedAt,
      ageDays:
        releasedAt === null
          ? null
          : Math.max(0, Math.floor((now.getTime() - Date.parse(releasedAt)) / 86_400_000)),
    };
    cache = { checkedAtMs: now.getTime(), advisory };
    return advisory;
  } catch (error) {
    return {
      current: currentVersion,
      latest: null,
      behind: false,
      ageDays: null,
      releasedAt: null,
      warning: error instanceof Error ? error.message : 'version check failed',
    };
  }
};

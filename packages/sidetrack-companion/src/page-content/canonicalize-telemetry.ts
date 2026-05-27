const MAX_TRACKED_HOSTS = 500;
const MAX_TRACKED_PAIRS_PER_HOST = 50;
const MAX_SUSPICIOUS_PAIR_SAMPLES = 3;
const SUSPICIOUS_RAW_COLLAPSE_COUNT = 4;

export interface CanonicalCollisionSamplePair {
  readonly canonicalUrl: string;
  readonly rawUrls: readonly string[];
}

export interface CanonicalCollisionHostSnapshot {
  readonly canonicalCount: number;
  readonly rawCount: number;
  readonly suspiciousPairs: readonly CanonicalCollisionSamplePair[];
}

export interface CanonicalCollisionSnapshot {
  readonly byHost: Readonly<Record<string, CanonicalCollisionHostSnapshot>>;
}

interface CanonicalPairEntry {
  readonly rawUrl: string;
  readonly canonicalUrl: string;
}

const pairsByHost = new Map<string, Map<string, CanonicalPairEntry>>();

const hostFromRawUrl = (rawUrl: string): string | null => {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const pairKey = (rawUrl: string, canonicalUrl: string): string => `${rawUrl}\n${canonicalUrl}`;

const touchHost = (host: string): Map<string, CanonicalPairEntry> => {
  const existing = pairsByHost.get(host);
  if (existing !== undefined) {
    pairsByHost.delete(host);
    pairsByHost.set(host, existing);
    return existing;
  }
  const created = new Map<string, CanonicalPairEntry>();
  pairsByHost.set(host, created);
  while (pairsByHost.size > MAX_TRACKED_HOSTS) {
    const oldestHost = pairsByHost.keys().next().value;
    if (oldestHost === undefined) break;
    pairsByHost.delete(oldestHost);
  }
  return created;
};

export const recordCanonicalCollision = (rawUrl: string, canonicalUrl: string): void => {
  const host = hostFromRawUrl(rawUrl);
  if (host === null) return;
  const pairs = touchHost(host);
  const key = pairKey(rawUrl, canonicalUrl);
  if (pairs.has(key)) pairs.delete(key);
  pairs.set(key, { rawUrl, canonicalUrl });
  while (pairs.size > MAX_TRACKED_PAIRS_PER_HOST) {
    const oldestPair = pairs.keys().next().value;
    if (oldestPair === undefined) break;
    pairs.delete(oldestPair);
  }
};

const suspiciousPairsFor = (
  pairs: ReadonlyMap<string, CanonicalPairEntry>,
): readonly CanonicalCollisionSamplePair[] => {
  const rawUrlsByCanonical = new Map<string, Set<string>>();
  for (const pair of pairs.values()) {
    const raws = rawUrlsByCanonical.get(pair.canonicalUrl) ?? new Set<string>();
    raws.add(pair.rawUrl);
    rawUrlsByCanonical.set(pair.canonicalUrl, raws);
  }
  return [...rawUrlsByCanonical.entries()]
    .filter(([, rawUrls]) => rawUrls.size >= SUSPICIOUS_RAW_COLLAPSE_COUNT)
    .sort(([leftCanonical, leftRaws], [rightCanonical, rightRaws]) => {
      const rawDelta = rightRaws.size - leftRaws.size;
      return rawDelta !== 0 ? rawDelta : leftCanonical.localeCompare(rightCanonical);
    })
    .slice(0, MAX_SUSPICIOUS_PAIR_SAMPLES)
    .map(([canonicalUrl, rawUrls]) => ({
      canonicalUrl,
      rawUrls: [...rawUrls].sort().slice(0, MAX_SUSPICIOUS_PAIR_SAMPLES),
    }));
};

export const getCanonicalCollisionSnapshot = (): CanonicalCollisionSnapshot => {
  const byHost: Record<string, CanonicalCollisionHostSnapshot> = {};
  for (const [host, pairs] of pairsByHost) {
    const rawUrls = new Set<string>();
    const canonicalUrls = new Set<string>();
    for (const pair of pairs.values()) {
      rawUrls.add(pair.rawUrl);
      canonicalUrls.add(pair.canonicalUrl);
    }
    byHost[host] = {
      canonicalCount: canonicalUrls.size,
      rawCount: rawUrls.size,
      suspiciousPairs: suspiciousPairsFor(pairs),
    };
  }
  return { byHost };
};

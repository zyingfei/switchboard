// Persisted domain-tombstone list.
//
// The tombstone route appends the tombstone to the append-only event
// log (audit + sync) AND upserts it here, a small JSON artifact at the
// vault root that every READ boundary loads (with a short TTL cache) to
// build a DomainTombstoneSet. We keep a materialized list rather than
// re-scanning the event log per read because tombstone filtering runs
// on the hot serve path (timeline, recall, connections, context packs).
//
// Same small-JSON state-file pattern as workGraphHealthArtifact.ts:
// tmp+rename atomic write, lenient schemaVersion-checked reader that
// treats a corrupt/mismatched/missing file as an empty list.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  isDomainTombstonePayload,
  type DomainTombstonePayload,
} from './domainTombstone.js';

export const DOMAIN_TOMBSTONE_ARTIFACT_SCHEMA_VERSION = 1;

const DOMAIN_TOMBSTONE_RELATIVE_PATH = '_BAC/privacy/domain-tombstones.json';

interface DomainTombstoneArtifact {
  readonly schemaVersion: number;
  readonly updatedAt: string;
  readonly tombstones: readonly DomainTombstonePayload[];
}

export const domainTombstoneArtifactPath = (vaultRoot: string): string =>
  join(vaultRoot, DOMAIN_TOMBSTONE_RELATIVE_PATH);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const writeAtomic = async (path: string, body: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
};

// Lenient reader — missing / corrupt / schema-mismatch ⇒ [] (an empty
// list means "nothing hidden", which is the safe default for a privacy
// gate: it never HIDES more than an intact list would; the tombstone is
// also durably in the event log for a rebuild).
export const readDomainTombstones = async (
  vaultRoot: string,
): Promise<readonly DomainTombstonePayload[]> => {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(domainTombstoneArtifactPath(vaultRoot), 'utf8'),
    );
    if (!isRecord(parsed)) return [];
    if (parsed['schemaVersion'] !== DOMAIN_TOMBSTONE_ARTIFACT_SCHEMA_VERSION) return [];
    const list = parsed['tombstones'];
    if (!Array.isArray(list)) return [];
    return list.filter(isDomainTombstonePayload);
  } catch {
    return [];
  }
};

// Upsert a tombstone (dedupe by kind+domain — a repeated purge is a
// no-op that refreshes tombstonedAt). Returns the full list.
export const upsertDomainTombstone = async (
  vaultRoot: string,
  tombstone: DomainTombstonePayload,
): Promise<readonly DomainTombstonePayload[]> => {
  const existing = await readDomainTombstones(vaultRoot);
  const filtered = existing.filter(
    (candidate) => !(candidate.kind === tombstone.kind && candidate.domain === tombstone.domain),
  );
  const next = [...filtered, tombstone];
  const artifact: DomainTombstoneArtifact = {
    schemaVersion: DOMAIN_TOMBSTONE_ARTIFACT_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    tombstones: next,
  };
  await writeAtomic(
    domainTombstoneArtifactPath(vaultRoot),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  return next;
};

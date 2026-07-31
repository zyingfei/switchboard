// S2 — proof-gated retirement of non-canonical storage duplicates.
//
// This module is deliberately separate from gc/plan.ts. The ordinary GC plan
// owns bounded derived revisions and may tolerate a missing file between plan
// and apply. These candidates are larger and historically load-bearing, so
// apply requires an explicitly confirmed plan id, rebuilds the complete plan,
// revalidates every proof/fingerprint, and fails closed if anything moved.
// Canonical `_BAC/log` bytes are rejected at the final path boundary.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, readdir, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  discardShadowGeneration,
  generationDbPath,
  readPointer,
  surveyGenerations,
  withPublishLock,
} from '../connections/generationBuffer.js';
import { parseGenerationProgressCheckpoint } from '../connections/progressCheckpoint.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { eventStoreEnabled } from '../sync/eventStore.js';
import { isAcceptedEvent } from '../sync/eventLog.js';
import { planIngressRetention } from './ingressRetention.js';

export type StorageRetirementArtifact =
  | 'legacy-current-db'
  | 'ingress-spool-day'
  | 'event-store-mirror'
  | 'generation-orphan';

export type RetirementProofStatus = 'absent' | 'refuted' | 'verified';

export interface RetirementProof {
  readonly status: RetirementProofStatus;
  readonly evidence: string;
  readonly checkedAt: string;
}

export interface StorageRetirementCandidate {
  readonly id: string;
  readonly artifact: StorageRetirementArtifact;
  /** Every path the apply step may unlink for this candidate. */
  readonly paths: readonly string[];
  readonly bytes: number;
  /** Stat/content identity used to reject a stale report at apply time. */
  readonly fingerprint: string | null;
  readonly proof: RetirementProof;
  readonly recoverableFrom: string;
}

export interface StorageRetirementPlan {
  readonly schemaVersion: 1;
  readonly vaultRoot: string;
  readonly producedAt: string;
  /** Stable across report/apply when no candidate bytes or proof changed. */
  readonly planId: string;
  readonly candidates: readonly StorageRetirementCandidate[];
  readonly reclaimableBytes: number;
  readonly verifiedCount: number;
  readonly canonicalLogDeletionPermitted: false;
}

export interface ApplyStorageRetirementResult {
  readonly planId: string;
  readonly removedCandidates: readonly string[];
  readonly removedPaths: readonly string[];
  readonly bytes: number;
  readonly errors: readonly string[];
}

interface SqliteStatement {
  readonly get: (...params: readonly unknown[]) => unknown;
  readonly all: (...params: readonly unknown[]) => readonly unknown[];
}

interface SqliteDatabase {
  readonly query: (sql: string) => SqliteStatement;
  readonly close: () => void;
}

interface SqliteModule {
  readonly Database: new (
    filename: string,
    options?: { readonly readonly?: boolean },
  ) => SqliteDatabase;
}

const loadSqlite = async (): Promise<SqliteModule> => {
  const specifier = 'bun:sqlite';
  const module = (await import(specifier)) as Partial<SqliteModule>;
  if (typeof module.Database !== 'function') throw new Error('bun:sqlite is unavailable');
  return { Database: module.Database };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const missingPath = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

interface PathIdentity {
  readonly path: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

const identities = async (paths: readonly string[]): Promise<readonly PathIdentity[]> => {
  const out: PathIdentity[] = [];
  for (const path of paths) {
    const info = await stat(path).catch(() => null);
    if (info !== null && info.isFile()) {
      out.push({ path, bytes: info.size, mtimeMs: Math.trunc(info.mtimeMs) });
    }
  }
  return out;
};

const fingerprintFor = (rows: readonly PathIdentity[]): string | null =>
  rows.length === 0 ? null : sha256(stableJson(rows));

const sizeFingerprintFor = (rows: readonly PathIdentity[]): string | null =>
  rows.length === 0
    ? null
    : sha256(stableJson(rows.map((row) => ({ path: row.path, bytes: row.bytes }))));

const proof = (
  status: RetirementProofStatus,
  evidence: string,
  checkedAt: string,
): RetirementProof => ({ status, evidence, checkedAt });

const currentDbPaths = (vaultRoot: string): readonly string[] => {
  const base = join(vaultRoot, '_BAC', 'connections', 'current.db');
  return [base, `${base}-wal`, `${base}-shm`, `${base}.reconciled-from`];
};

const eventStorePaths = (vaultRoot: string): readonly string[] => {
  const base = join(vaultRoot, '_BAC', 'connections', 'event-store.db');
  return [base, `${base}-wal`, `${base}-shm`];
};

const rowText = (row: unknown, field: string): string | null => {
  if (!isRecord(row)) return null;
  const value = row[field];
  return typeof value === 'string' ? value : null;
};

const quickCheckOk = (db: SqliteDatabase): boolean => {
  const row = db.query('PRAGMA quick_check').get();
  if (!isRecord(row)) return false;
  return Object.values(row).some((value) => value === 'ok');
};

interface ActiveGenerationProof {
  readonly status: RetirementProofStatus;
  readonly evidence: string;
  readonly generationId: string | null;
}

/** S1 proof used by BOTH current.db retirement and generation GC arming. */
const proveActiveGeneration = async (vaultRoot: string): Promise<ActiveGenerationProof> => {
  if (process.env['SIDETRACK_CONNECTIONS_DOUBLE_BUFFER'] === '0') {
    return {
      status: 'refuted',
      evidence: 'legacy single-file mode is active; current.db may be the served graph',
      generationId: null,
    };
  }
  const connectionsDir = join(vaultRoot, '_BAC', 'connections');
  const before = readPointer(connectionsDir);
  if (before === null) {
    return { status: 'absent', evidence: 'current.gen is absent', generationId: null };
  }
  const activePath = generationDbPath(connectionsDir, before);
  if (!existsSync(activePath)) {
    return {
      status: 'refuted',
      evidence: `current.gen names missing generation ${before}`,
      generationId: before,
    };
  }
  try {
    const { Database } = await loadSqlite();
    const db = new Database(activePath, { readonly: true });
    let metadataText: string | null = null;
    let integrityOk = false;
    try {
      integrityOk = quickCheckOk(db);
      metadataText = rowText(
        db.query('SELECT data FROM metadata WHERE key = ?').get('current'),
        'data',
      );
    } finally {
      db.close();
    }
    if (!integrityOk || metadataText === null) {
      return {
        status: 'refuted',
        evidence: 'served generation failed quick_check or has no metadata.current row',
        generationId: before,
      };
    }
    const metadata: unknown = JSON.parse(metadataText);
    const contentSignature = isRecord(metadata) ? metadata['contentSignature'] : undefined;
    if (typeof contentSignature !== 'string' || !/^[a-f0-9]{64}$/u.test(contentSignature)) {
      return {
        status: 'refuted',
        evidence: 'served generation lacks the S1 strong content signature',
        generationId: before,
      };
    }
    const checkpointPath = join(connectionsDir, 'progress.checkpoint.json');
    try {
      const checkpointRaw: unknown = JSON.parse(await readFile(checkpointPath, 'utf8'));
      const checkpoint = parseGenerationProgressCheckpoint(checkpointRaw);
      if (checkpoint === null || checkpoint.generationId !== before) {
        return {
          status: 'refuted',
          evidence: 'progress checkpoint exists but is invalid or bound to another generation',
          generationId: before,
        };
      }
    } catch (error) {
      if (!missingPath(error)) {
        return {
          status: 'refuted',
          evidence: `progress checkpoint could not be validated: ${errorMessage(error)}`,
          generationId: before,
        };
      }
    }
    const after = readPointer(connectionsDir);
    if (after !== before) {
      return {
        status: 'refuted',
        evidence: 'generation pointer changed during durable read-back',
        generationId: before,
      };
    }
    return {
      status: 'verified',
      evidence: `generation ${before} passed quick_check, carries an S1 content signature, and its checkpoint binding is valid`,
      generationId: before,
    };
  } catch (error) {
    return {
      status: 'refuted',
      evidence: `served generation read-back failed: ${errorMessage(error)}`,
      generationId: before,
    };
  }
};

const buildLegacyCurrentCandidate = async (
  vaultRoot: string,
  checkedAt: string,
  active: ActiveGenerationProof,
): Promise<StorageRetirementCandidate> => {
  const rows = await identities(currentDbPaths(vaultRoot));
  const liveSidecar = rows.some(
    (row) => row.path.endsWith('current.db-wal') || row.path.endsWith('current.db-shm'),
  );
  const status: RetirementProofStatus =
    rows.length === 0 ? 'absent' : liveSidecar ? 'refuted' : active.status;
  const evidence =
    rows.length === 0
      ? 'legacy current.db is already absent'
      : liveSidecar
        ? 'legacy current.db has WAL/SHM sidecars and may be open; retirement is refused'
        : active.evidence;
  return {
    id: 'legacy-current-db',
    artifact: 'legacy-current-db',
    paths: rows.map((row) => row.path),
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    fingerprint: fingerprintFor(rows),
    proof: proof(status, evidence, checkedAt),
    recoverableFrom:
      'the immutable generation named by current.gen; kill-switch startup recreates current.db via reconcileLegacyToPublished',
  };
};

const listCanonicalShards = async (vaultRoot: string): Promise<readonly string[]> => {
  const root = join(vaultRoot, '_BAC', 'log');
  const replicas = await readdir(root).catch(() => []);
  const paths: string[] = [];
  for (const replica of replicas.sort()) {
    const names = await readdir(join(root, replica)).catch(() => []);
    for (const name of names.sort()) {
      if (name.endsWith('.jsonl')) paths.push(join(root, replica, name));
    }
  }
  return paths;
};

interface CanonicalEventReadback {
  readonly status: RetirementProofStatus;
  readonly evidence: string;
  readonly eventsByDot: ReadonlyMap<string, string>;
}

const eventDotKey = (event: AcceptedEvent): string =>
  `${event.dot.replicaId}\u0000${String(event.dot.seq)}`;

const readCanonicalEvents = async (vaultRoot: string): Promise<CanonicalEventReadback> => {
  const shards = await listCanonicalShards(vaultRoot);
  if (shards.length === 0) {
    return { status: 'absent', evidence: 'canonical event log is absent', eventsByDot: new Map() };
  }
  const eventsByDot = new Map<string, string>();
  for (const shard of shards) {
    let raw: string;
    try {
      raw = await readFile(shard, 'utf8');
    } catch (error) {
      return {
        status: 'refuted',
        evidence: `canonical shard read failed: ${errorMessage(error)}`,
        eventsByDot,
      };
    }
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        return { status: 'refuted', evidence: `malformed canonical line in ${shard}`, eventsByDot };
      }
      if (!isAcceptedEvent(parsed)) {
        return {
          status: 'refuted',
          evidence: `structurally invalid canonical event in ${shard}`,
          eventsByDot,
        };
      }
      const key = eventDotKey(parsed);
      const value = sha256(stableJson(parsed));
      const existing = eventsByDot.get(key);
      if (existing !== undefined && existing !== value) {
        return { status: 'refuted', evidence: `canonical dot collision at ${key}`, eventsByDot };
      }
      eventsByDot.set(key, value);
    }
  }
  return {
    status: 'verified',
    evidence: `${String(eventsByDot.size)} canonical events read back from JSONL`,
    eventsByDot,
  };
};

const eventFromStoreRow = (row: unknown): AcceptedEvent | null => {
  if (!isRecord(row)) return null;
  try {
    const target: unknown = JSON.parse(String(row['target']));
    const hlc: unknown = JSON.parse(String(row['hlc']));
    const event: AcceptedEvent = {
      clientEventId: String(row['client_event_id']),
      dot: { replicaId: String(row['replica_id']), seq: Number(row['seq']) },
      deps: JSON.parse(String(row['deps'])) as AcceptedEvent['deps'],
      aggregateId: String(row['aggregate_id']),
      type: String(row['type']),
      payload: JSON.parse(String(row['payload'])) as unknown,
      acceptedAtMs: Number(row['accepted_at_ms']),
      ...(target === null ? {} : { target: target as NonNullable<AcceptedEvent['target']> }),
      ...(hlc === null ? {} : { hlc: hlc as NonNullable<AcceptedEvent['hlc']> }),
    };
    return isAcceptedEvent(event) ? event : null;
  } catch {
    return null;
  }
};

const proveEventStoreMirror = async (vaultRoot: string): Promise<ActiveGenerationProof> => {
  if (eventStoreEnabled()) {
    return {
      status: 'refuted',
      evidence: 'SIDETRACK_EVENT_STORE=1; the mirror is an active configured read source',
      generationId: null,
    };
  }
  const path = eventStorePaths(vaultRoot)[0] as string;
  if (!existsSync(path)) {
    return { status: 'absent', evidence: 'event-store.db is absent', generationId: null };
  }
  if (existsSync(`${path}-shm`)) {
    return {
      status: 'refuted',
      evidence: 'event-store.db-shm is present and may name a live SQLite user',
      generationId: null,
    };
  }
  const canonical = await readCanonicalEvents(vaultRoot);
  if (canonical.status !== 'verified') return { ...canonical, generationId: null };
  const proofDir = await mkdtemp(join(tmpdir(), 'sidetrack-event-store-proof-'));
  const proofPath = join(proofDir, 'event-store.db');
  try {
    // Inspect an isolated snapshot so the report never creates SQLite sidecars
    // in the vault. A pre-existing live -shm was refused above; copying the
    // main file plus its optional WAL is therefore a quiescent read-back.
    await copyFile(path, proofPath);
    if (existsSync(`${path}-wal`)) await copyFile(`${path}-wal`, `${proofPath}-wal`);
    const { Database } = await loadSqlite();
    const db = new Database(proofPath, { readonly: true });
    let rows: readonly unknown[] = [];
    let compactedReceiptRows = 0;
    try {
      if (!quickCheckOk(db)) {
        return {
          status: 'refuted',
          evidence: 'event-store.db failed quick_check',
          generationId: null,
        };
      }
      rows = db
        .query(
          `SELECT replica_id, seq, client_event_id, type, payload, accepted_at_ms,
                  deps, target, hlc, aggregate_id
             FROM events ORDER BY replica_id, seq`,
        )
        .all();
      // Newer event stores may carry compacted-dot accounting sourced from a
      // separate signed manifest. This S2 proof deliberately does not pretend
      // those rows came from JSONL. Until the manifest is added as a second
      // verified recovery input, their presence refutes the single-source
      // transition and keeps the mirror.
      try {
        const compacted = db.query('SELECT COUNT(*) AS count FROM compacted_events').get();
        compactedReceiptRows = Number(isRecord(compacted) ? compacted['count'] : Number.NaN);
      } catch {
        compactedReceiptRows = 0; // pre-compaction schema
      }
    } finally {
      db.close();
    }
    if (!Number.isSafeInteger(compactedReceiptRows) || compactedReceiptRows > 0) {
      return {
        status: 'refuted',
        evidence:
          'event-store.db contains compacted-dot receipts whose manifest recovery proof is not part of this single-source transition',
        generationId: null,
      };
    }
    for (const row of rows) {
      const event = eventFromStoreRow(row);
      if (event === null) {
        return {
          status: 'refuted',
          evidence: 'event-store.db contains an invalid row',
          generationId: null,
        };
      }
      if (canonical.eventsByDot.get(eventDotKey(event)) !== sha256(stableJson(event))) {
        return {
          status: 'refuted',
          evidence: `event-store.db row ${eventDotKey(event)} has no identical canonical JSONL event`,
          generationId: null,
        };
      }
    }
    return {
      status: 'verified',
      evidence: `${String(rows.length)} mirror rows read back identically from canonical JSONL; JSONL is the declared single source`,
      generationId: null,
    };
  } catch (error) {
    return {
      status: 'refuted',
      evidence: `event-store mirror read-back failed: ${errorMessage(error)}`,
      generationId: null,
    };
  } finally {
    await rm(proofDir, { recursive: true, force: true });
  }
};

const buildEventStoreCandidate = async (
  vaultRoot: string,
  checkedAt: string,
): Promise<StorageRetirementCandidate> => {
  const mirror = await proveEventStoreMirror(vaultRoot);
  // A readonly SQLite open may materialize a transient -shm on some builds.
  // Fingerprint only after proof/close so report and immediate revalidation see
  // the same complete footprint.
  const rows = await identities(eventStorePaths(vaultRoot));
  const sharedMemoryPresent = rows.some((row) => row.path.endsWith('event-store.db-shm'));
  const status: RetirementProofStatus =
    rows.length === 0 ? 'absent' : sharedMemoryPresent ? 'refuted' : mirror.status;
  const evidence = sharedMemoryPresent
    ? 'event-store.db-shm is present and may name a live SQLite user; retirement is refused'
    : mirror.evidence;
  return {
    id: 'event-store-mirror',
    artifact: 'event-store-mirror',
    paths: rows.map((row) => row.path),
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    // SQLite may touch a WAL mtime during a readonly quick_check. Semantic
    // row-vs-canonical verification above is the strong stale guard; sizes and
    // explicit path set prevent an unnoticed footprint change.
    fingerprint: sizeFingerprintFor(rows),
    proof: proof(status, evidence, checkedAt),
    recoverableFrom: 'the canonical append-only JSONL event log via rebuildFromJsonl',
  };
};

const buildIngressCandidates = async (
  vaultRoot: string,
  checkedAt: string,
  now: Date,
): Promise<readonly StorageRetirementCandidate[]> => {
  const plan = await planIngressRetention(vaultRoot, { now });
  return plan.days
    .filter((day) => day.pastRetention)
    .map((day) => ({
      id: `ingress-spool-day:${day.date}`,
      artifact: 'ingress-spool-day' as const,
      paths: [day.path],
      bytes: day.bytes,
      fingerprint: day.contentHash,
      proof: proof(day.proof, day.note, checkedAt),
      recoverableFrom: 'the identical capture.recorded event read back from canonical JSONL',
    }));
};

const buildGenerationCandidates = async (
  vaultRoot: string,
  checkedAt: string,
  active: ActiveGenerationProof,
  now: Date,
): Promise<readonly StorageRetirementCandidate[]> => {
  const connectionsDir = join(vaultRoot, '_BAC', 'connections');
  // S1 proof permits keeping only the pointer generation. The hour grace still
  // protects a recently-retired readonly handle; missing proof falls back to
  // the older pointer+prior policy and makes every candidate non-reclaimable.
  const survey = surveyGenerations(connectionsDir, {
    now,
    keepRecentGenerations: active.status === 'verified' ? 1 : 2,
  });
  const out: StorageRetirementCandidate[] = [];
  for (const entry of survey.entries) {
    if (entry.disposition !== 'orphan-collectable') continue;
    const base = generationDbPath(connectionsDir, entry.genId);
    const rows = await identities([base, `${base}-wal`, `${base}-shm`, `${base}.inflight`]);
    out.push({
      id: `generation-orphan:${entry.genId}`,
      artifact: 'generation-orphan',
      paths: rows.map((row) => row.path),
      bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
      fingerprint: fingerprintFor(rows),
      proof: proof(active.status, active.evidence, checkedAt),
      recoverableFrom: 'the immutable served generation plus canonical JSONL replay',
    });
  }
  return out;
};

const planIdentity = (candidates: readonly StorageRetirementCandidate[]): string =>
  sha256(
    stableJson(
      candidates.map((candidate) => ({
        id: candidate.id,
        artifact: candidate.artifact,
        paths: candidate.paths,
        bytes: candidate.bytes,
        fingerprint: candidate.fingerprint,
        proofStatus: candidate.proof.status,
        proofEvidence: candidate.proof.evidence,
      })),
    ),
  );

export const buildStorageRetirementPlan = async (
  vaultRoot: string,
  options: { readonly now?: Date } = {},
): Promise<StorageRetirementPlan> => {
  const root = resolve(vaultRoot);
  const now = options.now ?? new Date();
  const checkedAt = now.toISOString();
  const active = await proveActiveGeneration(root);
  const [legacy, ingress, eventStore, generations] = await Promise.all([
    buildLegacyCurrentCandidate(root, checkedAt, active),
    buildIngressCandidates(root, checkedAt, now),
    buildEventStoreCandidate(root, checkedAt),
    buildGenerationCandidates(root, checkedAt, active, now),
  ]);
  const candidates = [legacy, eventStore, ...ingress, ...generations].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const verified = candidates.filter((candidate) => candidate.proof.status === 'verified');
  return {
    schemaVersion: 1,
    vaultRoot: root,
    producedAt: checkedAt,
    planId: planIdentity(candidates),
    candidates,
    reclaimableBytes: verified.reduce((sum, candidate) => sum + candidate.bytes, 0),
    verifiedCount: verified.length,
    canonicalLogDeletionPermitted: false,
  };
};

const assertRetirementPath = (vaultRoot: string, path: string): void => {
  if (!isAbsolute(path)) throw new Error(`retirement path is not absolute: ${path}`);
  const bacRoot = resolve(vaultRoot, '_BAC');
  const resolved = resolve(path);
  const rel = relative(bacRoot, resolved);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`retirement path escapes _BAC: ${path}`);
  }
  if (rel === 'log' || rel.startsWith(`log${sep}`)) {
    throw new Error(`canonical log deletion is forbidden: ${path}`);
  }
};

const unlinkCandidatePaths = async (
  candidate: StorageRetirementCandidate,
  removedPaths: string[],
): Promise<void> => {
  for (const path of candidate.paths) {
    try {
      await unlink(path);
      removedPaths.push(path);
    } catch (error) {
      if (!missingPath(error)) throw error;
    }
  }
};

const candidateFingerprintNow = async (
  vaultRoot: string,
  candidate: StorageRetirementCandidate,
): Promise<string | null> => {
  switch (candidate.artifact) {
    case 'legacy-current-db':
      return fingerprintFor(await identities(currentDbPaths(vaultRoot)));
    case 'event-store-mirror':
      return sizeFingerprintFor(await identities(eventStorePaths(vaultRoot)));
    case 'ingress-spool-day': {
      const path = candidate.paths[0];
      if (path === undefined) return null;
      try {
        return sha256(await readFile(path, 'utf8'));
      } catch (error) {
        if (missingPath(error)) return null;
        throw error;
      }
    }
    case 'generation-orphan':
      return candidate.fingerprint; // re-surveyed under the publish lock below
  }
};

/** Apply exactly the reviewed plan. Any changed candidate/proof invalidates the
 * whole operation before the first unlink; partial apply is limited to an I/O
 * error after validation and is reported path-by-path. */
export const applyStorageRetirementPlan = async (
  plan: StorageRetirementPlan,
  input: { readonly confirmPlanId: string },
): Promise<ApplyStorageRetirementResult> => {
  if (input.confirmPlanId !== plan.planId) {
    throw new Error('storage-retirement plan id was not explicitly confirmed');
  }
  const fresh = await buildStorageRetirementPlan(plan.vaultRoot);
  if (fresh.planId !== plan.planId) {
    const reviewedById = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]));
    const currentById = new Map(fresh.candidates.map((candidate) => [candidate.id, candidate]));
    const changedIds = new Set([...reviewedById.keys(), ...currentById.keys()]);
    const changed = [...changedIds].filter((id) => {
      const left = reviewedById.get(id);
      const right = currentById.get(id);
      return (
        left === undefined || right === undefined || planIdentity([left]) !== planIdentity([right])
      );
    });
    throw new Error(
      `storage-retirement plan is stale; reviewed=${plan.planId} current=${fresh.planId} changed=${changed.join(',')}`,
    );
  }
  for (const candidate of fresh.candidates) {
    for (const path of candidate.paths) assertRetirementPath(fresh.vaultRoot, path);
  }

  const removedCandidates: string[] = [];
  const removedPaths: string[] = [];
  const errors: string[] = [];
  let bytes = 0;
  const generationCandidates = fresh.candidates.filter(
    (candidate) =>
      candidate.artifact === 'generation-orphan' && candidate.proof.status === 'verified',
  );
  for (const candidate of fresh.candidates) {
    if (candidate.proof.status !== 'verified' || candidate.artifact === 'generation-orphan') {
      continue;
    }
    try {
      const fingerprint = await candidateFingerprintNow(fresh.vaultRoot, candidate);
      if (fingerprint !== candidate.fingerprint) {
        throw new Error('candidate changed after proof revalidation');
      }
      await unlinkCandidatePaths(candidate, removedPaths);
      removedCandidates.push(candidate.id);
      bytes += candidate.bytes;
    } catch (error) {
      errors.push(`${candidate.id}: ${errorMessage(error)}`);
    }
  }

  if (generationCandidates.length > 0) {
    const connectionsDir = join(fresh.vaultRoot, '_BAC', 'connections');
    try {
      withPublishLock(
        connectionsDir,
        () => {
          const survey = surveyGenerations(connectionsDir, { keepRecentGenerations: 1 });
          const collectable = new Set(
            survey.entries
              .filter((entry) => entry.disposition === 'orphan-collectable')
              .map((entry) => entry.genId),
          );
          for (const candidate of generationCandidates) {
            const genId = candidate.id.slice('generation-orphan:'.length);
            if (!collectable.has(genId) || readPointer(connectionsDir) === genId) {
              throw new Error(`generation ${genId} lost its collectable proof`);
            }
            discardShadowGeneration(connectionsDir, genId);
            removedCandidates.push(candidate.id);
            removedPaths.push(...candidate.paths);
            bytes += candidate.bytes;
          }
        },
        { failClosed: true },
      );
    } catch (error) {
      errors.push(`generation-orphans: ${errorMessage(error)}`);
    }
  }

  return {
    planId: fresh.planId,
    removedCandidates,
    removedPaths,
    bytes,
    errors,
  };
};

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

import { isPageContentExtractedPayload } from '../page-content/events.js';
import {
  readPageContentCoverage,
  rebuildPageContentManifests,
  writePageContentExtracted,
} from '../page-content/store.js';
import type { PageContentExtractedPayload } from '../page-content/types.js';
import {
  readCurrentBodyEvidence,
  scrubBodyEvidencePayload,
  withBodyEvidenceUrlLock,
} from './bodyEvidenceQueue.js';
import {
  pageEvidenceStorageStats,
  readPageEvidence,
  writeExtractedPageEvidenceFast,
} from './store.js';
import type { PageEvidenceExtractedRequest } from './types.js';

const BODY_EVIDENCE_WORKER_KIND = 'sidetrack.body-evidence.materialize.v1' as const;
const DEFAULT_WORKER_TIMEOUT_MS = 60_000;
export const BODY_EVIDENCE_COVERAGE_TARGET = 0.8;

export interface BodyEvidenceMaterializationInput {
  readonly jobId: string;
  readonly payload: PageContentExtractedPayload;
}

export interface BodyEvidenceMaterializationResult {
  readonly jobId: string;
  readonly ok: boolean;
  /** Queue revision changed before the write lock was acquired; nothing was written. */
  readonly superseded?: true;
  readonly coverageState?: string;
  readonly evidenceTier?: string;
  readonly failureCategory?: 'materialization_failed' | 'readback_failed';
}

export type BodyEvidenceCoverage =
  | {
      readonly state: 'absent';
      readonly target: typeof BODY_EVIDENCE_COVERAGE_TARGET;
      readonly bodyEligibleCount: null;
      readonly bodyMaterializedCount: null;
      readonly bodyCoverageRatio: null;
      readonly vectorEligibleCount: null;
      readonly vectorReadyCount: null;
      readonly vectorCoverageRatio: null;
      readonly atOrAboveBodyTarget: null;
      readonly atOrAboveVectorTarget: null;
    }
  | {
      readonly state: 'empty' | 'measured';
      readonly target: typeof BODY_EVIDENCE_COVERAGE_TARGET;
      readonly bodyEligibleCount: number;
      readonly bodyMaterializedCount: number;
      readonly bodyCoverageRatio: number | null;
      readonly vectorEligibleCount: number;
      readonly vectorReadyCount: number;
      readonly vectorCoverageRatio: number | null;
      readonly atOrAboveBodyTarget: boolean | null;
      readonly atOrAboveVectorTarget: boolean | null;
    };

export interface BodyEvidenceWorkerResult {
  readonly results: readonly BodyEvidenceMaterializationResult[];
  readonly coverage: BodyEvidenceCoverage;
}

interface BodyEvidenceWorkerJob {
  readonly kind: typeof BODY_EVIDENCE_WORKER_KIND;
  readonly vaultRoot: string;
  readonly items: readonly BodyEvidenceMaterializationInput[];
}

const pageEvidenceRoot = (vaultRoot: string): string => join(vaultRoot, '_BAC', 'page-evidence');

const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : Number((numerator / denominator).toFixed(4));

export const readBodyEvidenceCoverage = async (
  vaultRoot: string,
): Promise<BodyEvidenceCoverage> => {
  const root = await stat(pageEvidenceRoot(vaultRoot)).catch(() => null);
  if (root === null) {
    return {
      state: 'absent',
      target: BODY_EVIDENCE_COVERAGE_TARGET,
      bodyEligibleCount: null,
      bodyMaterializedCount: null,
      bodyCoverageRatio: null,
      vectorEligibleCount: null,
      vectorReadyCount: null,
      vectorCoverageRatio: null,
      atOrAboveBodyTarget: null,
      atOrAboveVectorTarget: null,
    };
  }
  const stats = await pageEvidenceStorageStats(vaultRoot);
  const bodyEligibleCount = stats.featuresOnlyCount + stats.indexedChunkCount;
  const bodyCoverageRatio = ratio(stats.indexedChunkCount, bodyEligibleCount);
  const vectorEligibleCount = bodyEligibleCount;
  const vectorCoverageRatio = ratio(stats.contentVectorReadyCount, vectorEligibleCount);
  return {
    state: bodyEligibleCount === 0 ? 'empty' : 'measured',
    target: BODY_EVIDENCE_COVERAGE_TARGET,
    bodyEligibleCount,
    bodyMaterializedCount: stats.indexedChunkCount,
    bodyCoverageRatio,
    vectorEligibleCount,
    vectorReadyCount: stats.contentVectorReadyCount,
    vectorCoverageRatio,
    atOrAboveBodyTarget:
      bodyCoverageRatio === null ? null : bodyCoverageRatio >= BODY_EVIDENCE_COVERAGE_TARGET,
    atOrAboveVectorTarget:
      vectorCoverageRatio === null ? null : vectorCoverageRatio >= BODY_EVIDENCE_COVERAGE_TARGET,
  };
};

const evidenceRequest = (payload: PageContentExtractedPayload): PageEvidenceExtractedRequest => ({
  payloadVersion: 1,
  canonicalUrl: payload.canonicalUrl,
  url: payload.url,
  ...(payload.title === undefined ? {} : { title: payload.title }),
  ...(payload.provider === undefined ? {} : { provider: payload.provider }),
  extractedAt: payload.extractedAt,
  extractionSource: payload.extractionSource,
  extractionPolicy: payload.extractionPolicy,
  quality: payload.quality,
  qualitySignals: payload.qualitySignals,
  content: payload.content,
  storageMode: 'indexed_chunks',
});

const materializeOne = async (
  vaultRoot: string,
  input: BodyEvidenceMaterializationInput,
): Promise<BodyEvidenceMaterializationResult> => {
  return await withBodyEvidenceUrlLock(vaultRoot, input.payload.canonicalUrl, async () => {
    // Tombstone/manual-index routes remove or replace the queue entry while
    // holding this same lock. Checking inside it closes the TOCTOU window in
    // which an already-running worker could otherwise resurrect stale body
    // data after the user's newer decision.
    const current = await readCurrentBodyEvidence(vaultRoot, input.payload.canonicalUrl);
    if (current === null || current.jobId !== input.jobId) {
      return { jobId: input.jobId, ok: false, superseded: true };
    }
    // The durable queue is the authoritative filesystem/process boundary.
    // Reapply the complete minimization + safety transform to that read-back
    // payload—not the worker message copy—so a malformed/tampered message or
    // manually modified queue item cannot bypass redaction/injection handling.
    const payload = scrubBodyEvidencePayload(current.payload).payload;
    try {
      await writePageContentExtracted(vaultRoot, payload, {
        rebuildManifestsAfterWrite: false,
      });
      // INTENTIONALLY left as skip-forever, not switched to
      // manifestUpdate:'incremental'. This function runs INSIDE the
      // materialize-batch worker_threads Worker (see runBodyEvidenceWorker
      // below + the isMainThread branch at the bottom of this file) — a
      // separate V8 isolate with its OWN instance of page-evidence/store.ts
      // and therefore its OWN `evidenceManifestUpsertLocks` Map. That lock
      // only serializes callers within one isolate; it does not span the
      // thread boundary. If this called the incremental upsert, it would
      // race the main thread's HTTP-route and background-embedding-lane
      // upserts on the same physical manifest.json (read-modify-write from
      // two isolates, unordered) and could silently drift byTier/recordCount
      // (a lost-update, not a crash — much harder to notice). The one-shot
      // full rebuild this used to pay per record was itself self-healing
      // under that same concurrency (it recomputes fresh from disk, so a
      // "stale" rebuild is still internally consistent) but too slow to run
      // per record; skipping it here trades a stale-but-harmless
      // page-evidence manifest.json (no runtime reader was found for it —
      // unlike the page-content manifest, which IS part of the served read
      // model, see rebuildPageContentManifests below) for correctness. If a
      // reader ever needs this manifest fresh after body-evidence writes,
      // rebuild it ONCE per batch on the main thread after the worker
      // returns (mirroring rebuildPageContentManifests), not per record
      // inside the worker.
      await writeExtractedPageEvidenceFast(vaultRoot, evidenceRequest(payload), {
        rebuildManifestAfterWrite: false,
      });
    } catch {
      return { jobId: input.jobId, ok: false, failureCategory: 'materialization_failed' };
    }
    try {
      // Rule 10: accept success only after reading back the exact artifacts the
      // recall/connection surfaces consume, not after the worker's write call.
      const [coverage, evidence] = await Promise.all([
        readPageContentCoverage(vaultRoot, payload.canonicalUrl),
        readPageEvidence(vaultRoot, payload.canonicalUrl),
      ]);
      const coverageReady =
        (coverage.state === 'indexed' ||
          coverage.state === 'indexed_low_quality' ||
          coverage.state === 'stale_index') &&
        coverage.contentHash === payload.content.contentHash;
      const evidenceReady =
        evidence.record?.evidenceTier === 'indexed_chunks' &&
        evidence.record.content?.contentHash === payload.content.contentHash;
      if (!coverageReady || !evidenceReady) {
        return { jobId: input.jobId, ok: false, failureCategory: 'readback_failed' };
      }
      return {
        jobId: input.jobId,
        ok: true,
        coverageState: coverage.state,
        evidenceTier: evidence.record.evidenceTier,
      };
    } catch {
      return { jobId: input.jobId, ok: false, failureCategory: 'readback_failed' };
    }
  });
};

/** Core worker operation, exported for deterministic integration tests. */
export const materializeBodyEvidenceBatch = async (
  job: Pick<BodyEvidenceWorkerJob, 'vaultRoot' | 'items'>,
): Promise<BodyEvidenceWorkerResult> => {
  let results: BodyEvidenceMaterializationResult[] = [];
  // Sequential by design: page-content manifest writes are single-writer.
  for (const item of job.items) results.push(await materializeOne(job.vaultRoot, item));
  if (results.some((result) => result.ok)) {
    try {
      // One O(records) rebuild for the whole bounded batch, not per page.
      await rebuildPageContentManifests(job.vaultRoot);
    } catch {
      // Manifests are part of the served read model. Leave every successful
      // item durable in the queue so the idempotent retry repairs the batch.
      results = results.map((result) =>
        result.ok ? { jobId: result.jobId, ok: false, failureCategory: 'readback_failed' } : result,
      );
    }
  }
  return { results, coverage: await readBodyEvidenceCoverage(job.vaultRoot) };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseWorkerJob = (value: unknown): BodyEvidenceWorkerJob | null => {
  if (!isRecord(value) || value['kind'] !== BODY_EVIDENCE_WORKER_KIND) return null;
  if (typeof value['vaultRoot'] !== 'string' || !Array.isArray(value['items'])) return null;
  const items: BodyEvidenceMaterializationInput[] = [];
  for (const raw of value['items']) {
    if (
      !isRecord(raw) ||
      typeof raw['jobId'] !== 'string' ||
      !isPageContentExtractedPayload(raw['payload'])
    ) {
      return null;
    }
    items.push({ jobId: raw['jobId'], payload: raw['payload'] });
  }
  return { kind: BODY_EVIDENCE_WORKER_KIND, vaultRoot: value['vaultRoot'], items };
};

const parseCoverage = (value: unknown): BodyEvidenceCoverage | null => {
  if (!isRecord(value) || value['target'] !== BODY_EVIDENCE_COVERAGE_TARGET) return null;
  const state = value['state'];
  if (state === 'absent') {
    const nullableKeys = [
      'bodyEligibleCount',
      'bodyMaterializedCount',
      'bodyCoverageRatio',
      'vectorEligibleCount',
      'vectorReadyCount',
      'vectorCoverageRatio',
      'atOrAboveBodyTarget',
      'atOrAboveVectorTarget',
    ] as const;
    if (nullableKeys.some((key) => value[key] !== null)) return null;
    return {
      state,
      target: BODY_EVIDENCE_COVERAGE_TARGET,
      bodyEligibleCount: null,
      bodyMaterializedCount: null,
      bodyCoverageRatio: null,
      vectorEligibleCount: null,
      vectorReadyCount: null,
      vectorCoverageRatio: null,
      atOrAboveBodyTarget: null,
      atOrAboveVectorTarget: null,
    };
  }
  if (state !== 'empty' && state !== 'measured') return null;
  const bodyEligibleCount = value['bodyEligibleCount'];
  const bodyMaterializedCount = value['bodyMaterializedCount'];
  const vectorEligibleCount = value['vectorEligibleCount'];
  const vectorReadyCount = value['vectorReadyCount'];
  const bodyCoverageRatio = value['bodyCoverageRatio'];
  const vectorCoverageRatio = value['vectorCoverageRatio'];
  const atOrAboveBodyTarget = value['atOrAboveBodyTarget'];
  const atOrAboveVectorTarget = value['atOrAboveVectorTarget'];
  if (
    !Number.isInteger(bodyEligibleCount) ||
    (bodyEligibleCount as number) < 0 ||
    !Number.isInteger(bodyMaterializedCount) ||
    (bodyMaterializedCount as number) < 0 ||
    !Number.isInteger(vectorEligibleCount) ||
    (vectorEligibleCount as number) < 0 ||
    !Number.isInteger(vectorReadyCount) ||
    (vectorReadyCount as number) < 0 ||
    (bodyCoverageRatio !== null &&
      (typeof bodyCoverageRatio !== 'number' || bodyCoverageRatio < 0 || bodyCoverageRatio > 1)) ||
    (vectorCoverageRatio !== null &&
      (typeof vectorCoverageRatio !== 'number' ||
        vectorCoverageRatio < 0 ||
        vectorCoverageRatio > 1)) ||
    (atOrAboveBodyTarget !== null && typeof atOrAboveBodyTarget !== 'boolean') ||
    (atOrAboveVectorTarget !== null && typeof atOrAboveVectorTarget !== 'boolean')
  ) {
    return null;
  }
  return {
    state,
    target: BODY_EVIDENCE_COVERAGE_TARGET,
    bodyEligibleCount: bodyEligibleCount as number,
    bodyMaterializedCount: bodyMaterializedCount as number,
    bodyCoverageRatio,
    vectorEligibleCount: vectorEligibleCount as number,
    vectorReadyCount: vectorReadyCount as number,
    vectorCoverageRatio,
    atOrAboveBodyTarget,
    atOrAboveVectorTarget,
  };
};

const parseWorkerResult = (value: unknown): BodyEvidenceWorkerResult | null => {
  if (!isRecord(value) || !Array.isArray(value['results']) || !isRecord(value['coverage'])) {
    return null;
  }
  // The worker is our code, but its message is still a process boundary.
  const results: BodyEvidenceMaterializationResult[] = [];
  for (const raw of value['results']) {
    if (!isRecord(raw) || typeof raw['jobId'] !== 'string' || typeof raw['ok'] !== 'boolean') {
      return null;
    }
    const superseded = raw['superseded'];
    if (
      (superseded !== undefined && superseded !== true) ||
      (superseded === true && raw['ok'] !== false)
    ) {
      return null;
    }
    const failure = raw['failureCategory'];
    if (
      failure !== undefined &&
      failure !== 'materialization_failed' &&
      failure !== 'readback_failed'
    ) {
      return null;
    }
    results.push({
      jobId: raw['jobId'],
      ok: raw['ok'],
      ...(superseded === true ? { superseded } : {}),
      ...(typeof raw['coverageState'] === 'string' ? { coverageState: raw['coverageState'] } : {}),
      ...(typeof raw['evidenceTier'] === 'string' ? { evidenceTier: raw['evidenceTier'] } : {}),
      ...(failure === undefined ? {} : { failureCategory: failure }),
    });
  }
  const coverage = parseCoverage(value['coverage']);
  if (coverage === null) return null;
  return { results, coverage };
};

export interface BodyEvidenceWorkerOptions {
  readonly entryPath?: string;
  readonly timeoutMs?: number;
}

export const runBodyEvidenceWorker = async (
  input: {
    readonly vaultRoot: string;
    readonly items: readonly BodyEvidenceMaterializationInput[];
  },
  options: BodyEvidenceWorkerOptions = {},
): Promise<BodyEvidenceWorkerResult> => {
  const entryPath = options.entryPath ?? fileURLToPath(import.meta.url);
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS));
  const job: BodyEvidenceWorkerJob = {
    kind: BODY_EVIDENCE_WORKER_KIND,
    vaultRoot: input.vaultRoot,
    items: input.items,
  };
  return await new Promise<BodyEvidenceWorkerResult>((resolve, reject) => {
    const worker = new Worker(entryPath, { workerData: job });
    let settled = false;
    const settle = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker.terminate().catch(() => undefined);
      operation();
    };
    const timeout = setTimeout(() => {
      settle(() => reject(new Error('body-evidence worker timed out')));
    }, timeoutMs);
    worker.on('message', (message: unknown) => {
      const result = parseWorkerResult(message);
      if (result === null) {
        settle(() => reject(new Error('body-evidence worker returned an invalid message')));
      } else {
        settle(() => resolve(result));
      }
    });
    worker.on('error', (error) => {
      settle(() => reject(error instanceof Error ? error : new Error(String(error))));
    });
    worker.on('exit', (code) => {
      if (settled) return;
      settle(() =>
        reject(new Error(`body-evidence worker exited with code ${String(code)} without a result`)),
      );
    });
  });
};

const workerJob = parseWorkerJob(workerData);
if (!isMainThread && workerJob !== null) {
  void materializeBodyEvidenceBatch(workerJob)
    .then((result) => parentPort?.postMessage(result))
    .catch(() =>
      parentPort?.postMessage({
        results: workerJob.items.map((item) => ({
          jobId: item.jobId,
          ok: false,
          failureCategory: 'materialization_failed',
        })),
        coverage: {
          state: 'absent',
          target: BODY_EVIDENCE_COVERAGE_TARGET,
          bodyEligibleCount: null,
          bodyMaterializedCount: null,
          bodyCoverageRatio: null,
          vectorEligibleCount: null,
          vectorReadyCount: null,
          vectorCoverageRatio: null,
          atOrAboveBodyTarget: null,
          atOrAboveVectorTarget: null,
        },
      }),
    );
}

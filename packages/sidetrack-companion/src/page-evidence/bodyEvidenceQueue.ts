import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { createRevision } from '../domain/ids.js';
import { isPageContentExtractedPayload } from '../page-content/events.js';
import type { PageContentExtractedPayload } from '../page-content/types.js';
import { redact } from '../safety/redaction.js';
import { canonicalizeEvidenceUrl } from './store.js';

const BODY_EVIDENCE_QUEUE_VERSION = 1 as const;
export const DEFAULT_BODY_EVIDENCE_QUEUE_CAP = 2_048;
const STALE_ADMISSION_LOCK_MS = 30_000;
const ADMISSION_LOCK_RETRIES = 10;
const STALE_URL_LOCK_MS = 120_000;
const URL_LOCK_RETRIES = 500;
const URL_LOCK_RETRY_MS = 10;

export type BodyEvidenceFailureCategory =
  | 'materialization_failed'
  | 'notification_failed'
  | 'readback_failed'
  | 'worker_unavailable';

export interface BodyEvidenceSafetyEnvelope {
  /** Page bodies are local evidence, never instructions. */
  readonly contentTrust: 'untrusted-page';
  /** Any future outbound consumer must run the RedactionPipeline. */
  readonly requiresRedactionBeforeOutbound: true;
  /** Any future outbound consumer must run the prompt-injection scrub. */
  readonly requiresInjectionScrubBeforeOutbound: true;
  readonly redactionApplied: boolean;
  readonly redactionRuleCount: number;
  readonly injectionScrubApplied: boolean;
  readonly injectionPatternCount: number;
}

export interface BodyEvidenceQueueItem {
  readonly schemaVersion: typeof BODY_EVIDENCE_QUEUE_VERSION;
  readonly jobId: string;
  readonly canonicalUrl: string;
  readonly queuedAtMs: number;
  readonly attempts: number;
  readonly nextAttemptAtMs: number;
  readonly lastFailureCategory?: BodyEvidenceFailureCategory;
  readonly safety: BodyEvidenceSafetyEnvelope;
  readonly payload: PageContentExtractedPayload;
}

export interface BodyEvidenceQueueSnapshot {
  /** Missing queue storage is distinct from an initialized, empty queue. */
  readonly source: 'absent' | 'present';
  readonly items: readonly BodyEvidenceQueueItem[];
  readonly invalidItemCount: number;
}

export interface BodyEvidenceQueueAdmission {
  readonly state: 'queued' | 'coalesced' | 'backpressure';
  readonly jobId: string;
  readonly pendingCount: number;
  readonly cap: number;
}

const queueRoot = (vaultRoot: string): string =>
  join(vaultRoot, '_BAC', 'page-evidence', 'body-evidence-queue');
const pendingDir = (vaultRoot: string): string => join(queueRoot(vaultRoot), 'pending');
const failedDir = (vaultRoot: string): string => join(queueRoot(vaultRoot), 'failed');
const admissionLockDir = (vaultRoot: string): string =>
  join(queueRoot(vaultRoot), '.admission-lock');
const urlLocksDir = (vaultRoot: string): string => join(queueRoot(vaultRoot), '.url-locks');

const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');
const fileNameForCanonicalUrl = (canonicalUrl: string): string => `${sha256(canonicalUrl)}.json`;
const pendingPath = (vaultRoot: string, canonicalUrl: string): string =>
  join(pendingDir(vaultRoot), fileNameForCanonicalUrl(canonicalUrl));
const failedPath = (vaultRoot: string, canonicalUrl: string): string =>
  join(failedDir(vaultRoot), fileNameForCanonicalUrl(canonicalUrl));

// Mirrors the extension's high-confidence outbound injection patterns. The
// queue wraps instead of deleting so local evidence stays inspectable while
// every future model-facing consumer sees an explicit untrusted boundary.
const INJECTION_PATTERNS: readonly RegExp[] = [
  /\bignore\s+(?:the\s+)?(?:previous|prior|all|above)/iu,
  /\bdisregard\s+(?:the\s+)?(?:previous|prior|all|above|system)/iu,
  /\bforget\s+(?:everything|your\s+(?:instructions|training|prompt))/iu,
  /\b(?:reveal|show|print|output|display)\s+(?:your\s+)?(?:system\s+prompt|instructions|guidelines)/iu,
  /^\s*(?:system|assistant|developer|admin)\s*[:>-]/imu,
  /<\s*\/?(?:system|instructions|context)\b/iu,
  /\bstop\s+following\s+(?:your|the)\s+(?:rules|guidelines|instructions)/iu,
];
const CONTEXT_OPEN = '<context untrusted="true">';
const CONTEXT_CLOSE = '</context>';

const scrubInjection = (
  input: string,
): { readonly output: string; readonly applied: boolean; readonly patternCount: number } => {
  const trimmed = input.trim();
  const alreadyWrapped = trimmed.startsWith(CONTEXT_OPEN) && trimmed.endsWith(CONTEXT_CLOSE);
  const inspected = alreadyWrapped
    ? trimmed.slice(CONTEXT_OPEN.length, -CONTEXT_CLOSE.length).trim()
    : input;
  const patternCount = INJECTION_PATTERNS.filter((pattern) => pattern.test(inspected)).length;
  return {
    output:
      patternCount > 0 && !alreadyWrapped ? `${CONTEXT_OPEN}\n${input}\n${CONTEXT_CLOSE}` : input,
    applied: patternCount > 0,
    patternCount,
  };
};

export interface ScrubbedBodyEvidencePayload {
  readonly payload: PageContentExtractedPayload;
  readonly safety: BodyEvidenceSafetyEnvelope;
}

/**
 * Minimize + scrub before the durable boundary. The raw URL, markdown copy,
 * dimensions, policy ids, and original body never enter the queue. Redaction
 * runs before injection wrapping, matching the outbound safety pipeline.
 */
export const scrubBodyEvidencePayload = (
  payload: PageContentExtractedPayload,
): ScrubbedBodyEvidencePayload => {
  const canonicalUrl = canonicalizeEvidenceUrl(payload.canonicalUrl);
  const redaction = redact(payload.content.text);
  const injection = scrubInjection(redaction.output);
  const output = injection.output;
  // Preserve prior safety provenance when this transform is applied at more
  // than one boundary (HTTP admission, durable queue, worker read). The text
  // transform is idempotent, and its metadata must be idempotent too.
  const rules = [...new Set([...(payload.redaction?.rules ?? []), ...redaction.categories])];
  const redactionApplied = payload.redaction?.applied === true || redaction.matched > 0;
  return {
    payload: {
      payloadVersion: 1,
      canonicalUrl,
      url: canonicalUrl,
      ...(payload.title === undefined ? {} : { title: redact(payload.title).output }),
      ...(payload.provider === undefined ? {} : { provider: payload.provider }),
      extractedAt: payload.extractedAt,
      extractionSource: payload.extractionSource,
      extractionPolicy: { trigger: payload.extractionPolicy.trigger },
      quality: payload.quality,
      qualitySignals: payload.qualitySignals,
      content: {
        text: output,
        contentHash: sha256(output),
        charCount: output.length,
      },
      redaction: { applied: redactionApplied, rules },
    },
    safety: {
      contentTrust: 'untrusted-page',
      requiresRedactionBeforeOutbound: true,
      requiresInjectionScrubBeforeOutbound: true,
      redactionApplied,
      redactionRuleCount: rules.length,
      injectionScrubApplied: injection.applied,
      injectionPatternCount: injection.patternCount,
    },
  };
};

const atomicWriteJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${basename(path)}.${createRevision()}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
};

const readUnknownJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFailureCategory = (value: unknown): value is BodyEvidenceFailureCategory =>
  value === 'materialization_failed' ||
  value === 'notification_failed' ||
  value === 'readback_failed' ||
  value === 'worker_unavailable';

export const parseBodyEvidenceQueueItem = (value: unknown): BodyEvidenceQueueItem | null => {
  if (!isRecord(value) || value['schemaVersion'] !== BODY_EVIDENCE_QUEUE_VERSION) return null;
  const safety = value['safety'];
  const payload = value['payload'];
  if (
    typeof value['jobId'] !== 'string' ||
    typeof value['canonicalUrl'] !== 'string' ||
    typeof value['queuedAtMs'] !== 'number' ||
    !Number.isFinite(value['queuedAtMs']) ||
    !Number.isInteger(value['attempts']) ||
    (value['attempts'] as number) < 0 ||
    typeof value['nextAttemptAtMs'] !== 'number' ||
    !Number.isFinite(value['nextAttemptAtMs']) ||
    (value['lastFailureCategory'] !== undefined &&
      !isFailureCategory(value['lastFailureCategory'])) ||
    !isRecord(safety) ||
    safety['contentTrust'] !== 'untrusted-page' ||
    safety['requiresRedactionBeforeOutbound'] !== true ||
    safety['requiresInjectionScrubBeforeOutbound'] !== true ||
    typeof safety['redactionApplied'] !== 'boolean' ||
    !Number.isInteger(safety['redactionRuleCount']) ||
    (safety['redactionRuleCount'] as number) < 0 ||
    typeof safety['injectionScrubApplied'] !== 'boolean' ||
    !Number.isInteger(safety['injectionPatternCount']) ||
    (safety['injectionPatternCount'] as number) < 0 ||
    !isPageContentExtractedPayload(payload)
  ) {
    return null;
  }
  const item = value as unknown as BodyEvidenceQueueItem;
  if (canonicalizeEvidenceUrl(item.payload.canonicalUrl) !== item.canonicalUrl) return null;
  return item;
};

const jsonNames = async (path: string): Promise<readonly string[]> =>
  (await readdir(path).catch(() => [])).filter((name) => name.endsWith('.json')).sort();

const wait = async (delayMs: number): Promise<void> =>
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });

/**
 * Serialize the queue decision and served page-content write for one URL.
 *
 * The body worker runs in a worker thread while tombstone/manual-index routes
 * run on the API thread. An atomic rename protects each individual file, but
 * not the cross-file invariant "privacy/newer capture wins". This filesystem
 * lock is shared by both threads/processes and makes that invariant explicit.
 */
export const withBodyEvidenceUrlLock = async <T>(
  vaultRoot: string,
  rawCanonicalUrl: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const canonicalUrl = canonicalizeEvidenceUrl(rawCanonicalUrl);
  const lock = join(urlLocksDir(vaultRoot), sha256(canonicalUrl));
  await mkdir(urlLocksDir(vaultRoot), { recursive: true });
  for (let attempt = 0; attempt < URL_LOCK_RETRIES; attempt += 1) {
    try {
      await mkdir(lock);
    } catch (error) {
      const lockStat = await stat(lock).catch(() => null);
      if (lockStat !== null && Date.now() - lockStat.mtimeMs >= STALE_URL_LOCK_MS) {
        await rm(lock, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      if (attempt === URL_LOCK_RETRIES - 1) throw error;
      await wait(URL_LOCK_RETRY_MS);
      continue;
    }
    try {
      return await operation();
    } finally {
      await rm(lock, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  throw new Error('body-evidence URL lock unavailable');
};

const acquireAdmissionLock = async (vaultRoot: string): Promise<() => Promise<void>> => {
  const root = queueRoot(vaultRoot);
  const lock = admissionLockDir(vaultRoot);
  await mkdir(root, { recursive: true });
  for (let attempt = 0; attempt < ADMISSION_LOCK_RETRIES; attempt += 1) {
    try {
      await mkdir(lock);
      return async () => await rm(lock, { recursive: true, force: true });
    } catch {
      const lockStat = await stat(lock).catch(() => null);
      if (lockStat !== null && Date.now() - lockStat.mtimeMs >= STALE_ADMISSION_LOCK_MS) {
        await rm(lock, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      await wait(2 * (attempt + 1));
    }
  }
  throw new Error('body-evidence queue admission lock unavailable');
};

export const enqueueBodyEvidence = async (
  vaultRoot: string,
  payload: PageContentExtractedPayload,
  options: { readonly cap?: number; readonly now?: () => number } = {},
): Promise<BodyEvidenceQueueAdmission> => {
  const cap = Math.max(1, Math.floor(options.cap ?? DEFAULT_BODY_EVIDENCE_QUEUE_CAP));
  const now = options.now ?? Date.now;
  const scrubbed = scrubBodyEvidencePayload(payload);
  const safePayload = scrubbed.payload;
  const canonicalUrl = safePayload.canonicalUrl;
  const jobId = sha256(
    `${canonicalUrl}\n${safePayload.content.contentHash}\n${safePayload.extractedAt}`,
  );
  return await withBodyEvidenceUrlLock(vaultRoot, canonicalUrl, async () => {
    const release = await acquireAdmissionLock(vaultRoot);
    try {
      const path = pendingPath(vaultRoot, canonicalUrl);
      const existed = await access(path).then(
        () => true,
        () => false,
      );
      const names = await jsonNames(pendingDir(vaultRoot));
      if (!existed && names.length >= cap) {
        return { state: 'backpressure', jobId, pendingCount: names.length, cap };
      }
      const item: BodyEvidenceQueueItem = {
        schemaVersion: BODY_EVIDENCE_QUEUE_VERSION,
        jobId,
        canonicalUrl,
        queuedAtMs: now(),
        attempts: 0,
        nextAttemptAtMs: 0,
        safety: scrubbed.safety,
        payload: safePayload,
      };
      await atomicWriteJson(path, item);
      // A newly captured revision is a fresh attempt even if an older revision
      // of the same URL exhausted retries.
      await unlink(failedPath(vaultRoot, canonicalUrl)).catch(() => undefined);
      return {
        state: existed ? 'coalesced' : 'queued',
        jobId,
        pendingCount: existed ? names.length : names.length + 1,
        cap,
      };
    } finally {
      await release();
    }
  });
};

export const readPendingBodyEvidence = async (
  vaultRoot: string,
): Promise<BodyEvidenceQueueSnapshot> => {
  const rootStat = await stat(queueRoot(vaultRoot)).catch(() => null);
  if (rootStat === null) return { source: 'absent', items: [], invalidItemCount: 0 };
  const items: BodyEvidenceQueueItem[] = [];
  let invalidItemCount = 0;
  for (const name of await jsonNames(pendingDir(vaultRoot))) {
    const item = parseBodyEvidenceQueueItem(
      await readUnknownJson(join(pendingDir(vaultRoot), name)),
    );
    if (item === null) invalidItemCount += 1;
    else items.push(item);
  }
  items.sort(
    (left, right) =>
      left.nextAttemptAtMs - right.nextAttemptAtMs || left.queuedAtMs - right.queuedAtMs,
  );
  return { source: 'present', items, invalidItemCount };
};

export const readCurrentBodyEvidence = async (
  vaultRoot: string,
  rawCanonicalUrl: string,
): Promise<BodyEvidenceQueueItem | null> =>
  parseBodyEvidenceQueueItem(
    await readUnknownJson(pendingPath(vaultRoot, canonicalizeEvidenceUrl(rawCanonicalUrl))),
  );

export const isCurrentBodyEvidence = async (
  vaultRoot: string,
  item: Pick<BodyEvidenceQueueItem, 'canonicalUrl' | 'jobId'>,
): Promise<boolean> =>
  (await readCurrentBodyEvidence(vaultRoot, item.canonicalUrl))?.jobId === item.jobId;

export const acknowledgeBodyEvidence = async (
  vaultRoot: string,
  item: Pick<BodyEvidenceQueueItem, 'canonicalUrl' | 'jobId'>,
): Promise<boolean> => {
  const path = pendingPath(vaultRoot, item.canonicalUrl);
  const current = await readCurrentBodyEvidence(vaultRoot, item.canonicalUrl);
  // Latest-wins safety: never delete a newer revision that arrived while an
  // older revision was being materialized off-thread.
  if (current === null || current.jobId !== item.jobId) return false;
  await unlink(path).catch(() => undefined);
  return true;
};

export const failBodyEvidence = async (
  vaultRoot: string,
  item: Pick<BodyEvidenceQueueItem, 'canonicalUrl' | 'jobId'>,
  failure: {
    readonly category: BodyEvidenceFailureCategory;
    readonly nextAttemptAtMs: number;
    readonly maxAttempts: number;
  },
): Promise<'stale' | 'retry' | 'dead-letter'> => {
  const path = pendingPath(vaultRoot, item.canonicalUrl);
  const current = await readCurrentBodyEvidence(vaultRoot, item.canonicalUrl);
  if (current === null || current.jobId !== item.jobId) return 'stale';
  const attempts = current.attempts + 1;
  const updated: BodyEvidenceQueueItem = {
    ...current,
    attempts,
    nextAttemptAtMs: failure.nextAttemptAtMs,
    lastFailureCategory: failure.category,
  };
  if (attempts >= failure.maxAttempts) {
    await atomicWriteJson(failedPath(vaultRoot, current.canonicalUrl), updated);
    await unlink(path).catch(() => undefined);
    return 'dead-letter';
  }
  await atomicWriteJson(path, updated);
  return 'retry';
};

/** Caller must hold withBodyEvidenceUrlLock for the same canonical URL. */
export const discardQueuedBodyEvidenceUnderLock = async (
  vaultRoot: string,
  rawCanonicalUrl: string,
): Promise<void> => {
  const canonicalUrl = canonicalizeEvidenceUrl(rawCanonicalUrl);
  await Promise.all([
    unlink(pendingPath(vaultRoot, canonicalUrl)).catch(() => undefined),
    unlink(failedPath(vaultRoot, canonicalUrl)).catch(() => undefined),
  ]);
};

export const discardQueuedBodyEvidence = async (
  vaultRoot: string,
  rawCanonicalUrl: string,
): Promise<void> =>
  await withBodyEvidenceUrlLock(
    vaultRoot,
    rawCanonicalUrl,
    async () => await discardQueuedBodyEvidenceUnderLock(vaultRoot, rawCanonicalUrl),
  );

export const readBodyEvidenceDeadLetterCount = async (vaultRoot: string): Promise<number> =>
  (await jsonNames(failedDir(vaultRoot))).length;

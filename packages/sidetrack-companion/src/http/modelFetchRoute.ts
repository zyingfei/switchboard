// Model-fetch route — the ONE place the companion reaches the public internet
// for model weights.
//
// WHY THIS EXISTS. modelHostRoute.ts SERVES model files out of
// resolveModelsDir() and nothing ever put them there. The 1B gemma export is
// present on this machine only because an earlier node-side experiment happened
// to download it; every other registry entry resolved to a 404 and the panel's
// "Load local model" button failed with transformers.js' raw
// `Could not locate file: ".../resolve/main/config.json"`. The model host was a
// mirror with no way to fill it. This route fills it.
//
// OUTBOUND POSTURE — READ THIS BEFORE CHANGING ANYTHING HERE.
//   * This module FETCHES FROM huggingface.co. It is the only companion code
//     that talks to a non-loopback host for models. Nothing else in the
//     companion may acquire model files; if a second downloader ever appears,
//     merge it into this one so the outbound surface stays countable.
//   * It only ever acts on an AUTHENTICATED POST — the bridge key is required
//     (unlike the GET serve route, which is deliberately unauthenticated
//     because transformers.js cannot carry a header). No poll, no drain, no
//     background sweep reaches it.
//   * It sends NOTHING but the file path: a bare GET to a public URL. No vault
//     data, no telemetry, no identifiers.
//   * KILL SWITCH `SIDETRACK_MODEL_FETCH` (default ON). '0'/'false' makes the
//     POST return 403 MODEL_FETCH_DISABLED and start no job, so a deployment
//     that wants a provably zero-outbound companion sets it and the model host
//     degrades to "serves whatever is already on disk".
//   * Every started job LOGS the host it will contact (stderr, one line).
//
// WHY A BACKGROUND JOB. The Llama-3.2-3B q4 bundle is ~3.3GB; that is minutes
// of transfer, far past any sane request timeout. So POST starts the work and
// returns the status immediately, and GET polls it. Singleton per model id: a
// second POST while a job is running returns the RUNNING job rather than
// starting a competing download onto the same paths.
//
// WHY .part + rename. The model host happily serves any file that exists. A
// download interrupted at 60% would leave a truncated `model_q4.onnx_data` that
// the host would serve with a confident Content-Length, and transformers.js
// would fail deep inside ORT with an opaque parse error. So every file streams
// to `<name>.part` and is renamed into place only after the stream ends
// cleanly. rename(2) is atomic within a filesystem, so the host either sees no
// file or sees a complete one — never a half one.
//
// No new dependency: global fetch + node streams.

import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { confineUnderModelsDir } from './modelHostRoute.js';
import { resolveModelsDir } from '../recall/modelCache.js';

// ---- flag ---------------------------------------------------------------

export const MODEL_FETCH_ENV = 'SIDETRACK_MODEL_FETCH';

/**
 * Default ON. Only an explicit '0'/'false' disables. Read at the call site
 * (never cached) so a runtime flip takes effect on the next request.
 *
 * Default-ON is defensible ONLY because the route is inert without an
 * authenticated POST: it never runs on a timer, a drain, or a boot path. The
 * switch exists so an operator who wants "this binary must never egress" can
 * assert it, not because the route fires on its own.
 */
export const modelFetchEnabled = (): boolean => {
  const raw = process.env[MODEL_FETCH_ENV];
  return raw !== '0' && raw !== 'false';
};

// ---- the remote ---------------------------------------------------------

/** The one host this module contacts. Named, not interpolated from input. */
export const MODEL_FETCH_HOST = 'huggingface.co';
/**
 * The revision every fetch pulls. Fixed to 'main' on purpose: the model host
 * is a single-checked-out-revision mirror (it ACCEPTS AND IGNORES the revision
 * in the serve URL), so fetching two revisions of one repo would silently
 * overwrite rather than coexist. One revision in, one revision out.
 */
export const MODEL_FETCH_REVISION = 'main';

/** `https://huggingface.co/{org}/{repo}/resolve/main/{file}` — the only URL shape built here. */
export const huggingFaceFileUrl = (org: string, repo: string, file: string): string => {
  const encodedFile = file
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `https://${MODEL_FETCH_HOST}/${encodeURIComponent(org)}/${encodeURIComponent(
    repo,
  )}/resolve/${MODEL_FETCH_REVISION}/${encodedFile}`;
};

// ---- path shape ---------------------------------------------------------

/** POST|GET /v1/models/{org}/{repo}/fetch. Named groups feed the route match. */
export const MODEL_FETCH_PATTERN =
  /^\/v1\/models\/(?<modelOrg>[^/]+)\/(?<modelRepo>[^/]+)\/fetch$/u;

export const isModelFetchPath = (pathname: string): boolean =>
  MODEL_FETCH_PATTERN.test(pathname);

/** Percent-decode one path segment; null when the encoding is malformed. */
const decodeSegment = (segment: string | undefined): string | null => {
  if (segment === undefined) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

export interface ModelFetchTarget {
  readonly org: string;
  readonly repo: string;
  /** "org/repo" — the job key and the id the panel knows the model by. */
  readonly modelId: string;
  /** One entry per requested file, in request order. */
  readonly files: readonly ModelFetchFileTarget[];
}

export interface ModelFetchFileTarget {
  /** The relative path as the caller declared it, e.g. 'onnx/model_q4.onnx'. */
  readonly relativePath: string;
  /** Confined absolute destination under modelsDir. */
  readonly absolutePath: string;
  /** Where the bytes land before the atomic rename. */
  readonly partPath: string;
}

/** Hard cap on files per request — a declared bundle is a handful, not a repo dump. */
export const MODEL_FETCH_MAX_FILES = 32;

/**
 * Validate an org/repo (from the URL, percent-encoded) plus a caller-declared
 * list of relative file paths (from the JSON body, NOT encoded) into confined
 * absolute destinations. Returns null when anything is malformed or would
 * escape the models directory.
 *
 * The body paths are deliberately NOT percent-decoded: they arrive as literal
 * JSON strings, so decoding could only manufacture separators the caller never
 * wrote. Confinement is confineUnderModelsDir — the SAME function the serve
 * route uses, so the two can never disagree about what is safe.
 */
export const resolveModelFetchTarget = (
  rawOrg: string,
  rawRepo: string,
  files: readonly string[],
  modelsDir: string,
): ModelFetchTarget | null => {
  const org = decodeSegment(rawOrg);
  const repo = decodeSegment(rawRepo);
  if (org === null || repo === null) return null;
  if (files.length === 0 || files.length > MODEL_FETCH_MAX_FILES) return null;

  const resolved: ModelFetchFileTarget[] = [];
  for (const relativePath of files) {
    if (typeof relativePath !== 'string') return null;
    // A leading/trailing slash would produce an empty segment, which layer 1
    // rejects; splitting first keeps that decision in one place.
    const segments = relativePath.split('/');
    const absolutePath = confineUnderModelsDir(modelsDir, [org, repo, ...segments]);
    if (absolutePath === null) return null;
    resolved.push({
      relativePath,
      absolutePath,
      // The .part sibling is derived from the already-confined path, so it
      // inherits confinement (appending a suffix cannot escape a directory).
      partPath: `${absolutePath}.part`,
    });
  }
  return { org, repo, modelId: `${org}/${repo}`, files: resolved };
};

// ---- job status ---------------------------------------------------------

export type ModelFetchState = 'idle' | 'running' | 'done' | 'error';

export interface ModelFetchStatus {
  readonly modelId: string;
  readonly state: ModelFetchState;
  readonly filesDone: number;
  readonly filesTotal: number;
  /** Bytes on disk for this bundle so far (INCLUDING files that were already present). */
  readonly bytesDone: number;
  /** Total the bundle will occupy; 0 until sizing completes / when HF omits a length. */
  readonly bytesTotal: number;
  readonly currentFile: string | null;
  /** Always the literal remote host, so a status read names the outbound too. */
  readonly host: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly error?: string;
}

/** The status of a model no job has ever run for. */
export const idleModelFetchStatus = (modelId: string): ModelFetchStatus => ({
  modelId,
  state: 'idle',
  filesDone: 0,
  filesTotal: 0,
  bytesDone: 0,
  bytesTotal: 0,
  currentFile: null,
  host: MODEL_FETCH_HOST,
  startedAt: null,
  finishedAt: null,
});

interface JobRecord {
  status: ModelFetchStatus;
  /** Resolves when the background work settles. Held only for tests. */
  done: Promise<void>;
}

// Singleton registry, keyed by "org/repo". Module scope on purpose: one
// companion process must never run two downloads onto the same paths.
const jobs = new Map<string, JobRecord>();

/** Test seam: forget every job. Never called in production. */
export const __resetModelFetchJobsForTest = (): void => {
  jobs.clear();
};

/** Test seam: await the background work of a started job (undefined when none). */
export const __modelFetchJobDoneForTest = (modelId: string): Promise<void> | undefined =>
  jobs.get(modelId)?.done;

/** Current status for a model id — 'idle' when no job has ever run for it. */
export const modelFetchStatus = (modelId: string): ModelFetchStatus =>
  jobs.get(modelId)?.status ?? idleModelFetchStatus(modelId);

// ---- the download -------------------------------------------------------

/** Injectable fetch, so tests never touch the network. */
export type FetchLike = (url: string, init?: { method?: string }) => Promise<Response>;

export interface StartModelFetchOptions {
  /** Already-confined destinations — the models directory is baked into them. */
  readonly target: ModelFetchTarget;
  /** Test seam ONLY — production uses global fetch (i.e. huggingface.co). */
  readonly fetchImpl?: FetchLike;
  /** Test seam ONLY — production logs to stderr. */
  readonly log?: (line: string) => void;
}

/**
 * Start (or re-join) the download job for a model bundle. Returns the status
 * SYNCHRONOUSLY — the transfer runs in the background.
 *
 * SINGLETON: if a job for this model id is already 'running', its status is
 * returned untouched and no second download starts. A finished ('done' /
 * 'error') job is replaced, so a retry after a failure is just another POST.
 */
export const startModelFetch = (options: StartModelFetchOptions): ModelFetchStatus => {
  const { target } = options;
  const existing = jobs.get(target.modelId);
  if (existing !== undefined && existing.status.state === 'running') {
    return existing.status;
  }

  const record: JobRecord = {
    status: {
      modelId: target.modelId,
      state: 'running',
      filesDone: 0,
      filesTotal: target.files.length,
      bytesDone: 0,
      bytesTotal: 0,
      currentFile: null,
      host: MODEL_FETCH_HOST,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    },
    // Replaced below: the worker needs the record to exist before it can
    // publish into it, so the real promise is assigned after registration.
    done: Promise.resolve(),
  };
  jobs.set(target.modelId, record);

  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  // NAME THE OUTBOUND. One line per job, at the moment the decision is made.
  log(
    `[model-fetch] ${target.modelId}: fetching ${String(target.files.length)} file(s) from ` +
      `${MODEL_FETCH_HOST} (revision ${MODEL_FETCH_REVISION})`,
  );

  const started = record.status;
  record.done = runFetchJob(target, options, (next) => {
    record.status = next;
  }).catch(() => undefined);

  return started;
};

const patch = (
  current: ModelFetchStatus,
  next: Partial<ModelFetchStatus>,
): ModelFetchStatus => ({ ...current, ...next });

const runFetchJob = async (
  target: ModelFetchTarget,
  options: StartModelFetchOptions,
  publish: (status: ModelFetchStatus) => void,
): Promise<void> => {
  const doFetch = options.fetchImpl ?? ((url: string, init?: { method?: string }) => fetch(url, init));
  let status = jobs.get(target.modelId)?.status ?? idleModelFetchStatus(target.modelId);
  const set = (next: Partial<ModelFetchStatus>): void => {
    status = patch(status, next);
    publish(status);
  };

  try {
    // ---- pass 1: sizing. Which files are already on disk (skip them, but
    // count their bytes so the progress bar reflects the whole bundle), and how
    // big are the rest? A HEAD per missing file is a handful of small requests
    // and buys an honest bytesTotal BEFORE any multi-GB transfer starts —
    // without it the panel can only show "bytes so far, out of unknown".
    const pending: ModelFetchFileTarget[] = [];
    let bytesTotal = 0;
    let bytesDone = 0;
    let filesDone = 0;
    for (const file of target.files) {
      const present = await existingFileSize(file.absolutePath);
      if (present !== null) {
        // ALREADY PRESENT with non-zero size ⇒ skip. This is what makes a
        // re-POST after a partial run cheap: only the missing tail transfers.
        bytesTotal += present;
        bytesDone += present;
        filesDone += 1;
        continue;
      }
      pending.push(file);
      bytesTotal += await remoteContentLength(doFetch, target, file.relativePath);
    }
    set({ bytesTotal, bytesDone, filesDone });

    // ---- pass 2: transfer. Sequential, not parallel: these are GB-scale
    // bodies and N concurrent streams would just contend for the same link
    // while making `currentFile` meaningless.
    for (const file of pending) {
      set({ currentFile: file.relativePath });
      await mkdir(dirname(file.absolutePath), { recursive: true });
      // Any .part left by an earlier interrupted run is garbage — a resumed
      // range request would need an ETag we did not persist, so start clean.
      await rm(file.partPath, { force: true });

      const response = await doFetch(huggingFaceFileUrl(target.org, target.repo, file.relativePath));
      if (!response.ok) {
        throw new Error(
          `${file.relativePath}: ${MODEL_FETCH_HOST} returned ${String(response.status)}`,
        );
      }
      const body = response.body;
      if (body === null) {
        throw new Error(`${file.relativePath}: ${MODEL_FETCH_HOST} returned an empty body`);
      }

      // Count bytes as they pass through so progress is real transfer, not a
      // guess. A Transform keeps pipeline()'s backpressure intact — buffering a
      // 2GB body to count it would blow the heap the serve route is careful to
      // protect.
      let fileBytes = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          fileBytes += chunk.length;
          set({ bytesDone: bytesDone + fileBytes });
          cb(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
        counter,
        createWriteStream(file.partPath),
      );

      // THE ATOMIC STEP. Only now does a file the model host would serve come
      // into existence, and it is complete by construction.
      await rename(file.partPath, file.absolutePath);
      bytesDone += fileBytes;
      filesDone += 1;
      set({ bytesDone, filesDone, currentFile: null });
    }

    set({
      state: 'done',
      currentFile: null,
      finishedAt: new Date().toISOString(),
      // A bundle whose files were all already present reports the same 'done'
      // as one that transferred — "the model host can serve this model" is the
      // fact the panel needs, not how it got that way.
      bytesTotal: Math.max(bytesTotal, bytesDone),
    });
  } catch (error) {
    // Leave no half file behind: the .part files are the only artifacts a
    // failed run can have created, and none of them were renamed into place.
    await Promise.all(
      target.files.map((f) => rm(f.partPath, { force: true }).catch(() => undefined)),
    );
    set({
      state: 'error',
      currentFile: null,
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

/** Size of an existing non-empty regular file, else null (missing / empty / dir). */
const existingFileSize = async (path: string): Promise<number | null> => {
  try {
    const s = await stat(path);
    // A zero-byte file is treated as absent: it is what a crashed writer leaves
    // and the serve route would happily serve it as a "complete" empty model.
    if (!s.isFile() || s.size === 0) return null;
    return s.size;
  } catch {
    return null;
  }
};

/** Best-effort content length via HEAD; 0 when the host does not say. */
const remoteContentLength = async (
  doFetch: FetchLike,
  target: ModelFetchTarget,
  relativePath: string,
): Promise<number> => {
  try {
    const response = await doFetch(
      huggingFaceFileUrl(target.org, target.repo, relativePath),
      { method: 'HEAD' },
    );
    if (!response.ok) return 0;
    const raw = response.headers.get('content-length');
    if (raw === null) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    // Sizing is advisory. A HEAD that fails must not fail the download — the
    // GET below is the authoritative attempt and reports its own error.
    return 0;
  }
};

// ---- route entry points -------------------------------------------------

export interface ModelFetchRouteOptions {
  readonly modelsDir?: string;
  readonly fetchImpl?: FetchLike;
  readonly log?: (line: string) => void;
}

export type ModelFetchOutcome =
  | { readonly ok: true; readonly status: ModelFetchStatus }
  | {
      readonly ok: false;
      readonly httpStatus: number;
      readonly code: string;
      readonly detail: string;
    };

/**
 * POST /v1/models/{org}/{repo}/fetch — body `{ files: string[] }`.
 *
 * The CALLER declares exactly which relative paths it needs; the companion
 * never enumerates the repo or guesses a layout. That is deliberate: the
 * extension's model registry already declares the file list per model (it has
 * to — a multi-graph export and a single-graph export need different files),
 * and one declaration beats two guesses.
 */
export const handleModelFetchStart = (
  rawOrg: string,
  rawRepo: string,
  body: unknown,
  options: ModelFetchRouteOptions = {},
): ModelFetchOutcome => {
  if (!modelFetchEnabled()) {
    return {
      ok: false,
      httpStatus: 403,
      code: 'MODEL_FETCH_DISABLED',
      detail: `Model fetching is disabled (${MODEL_FETCH_ENV}=0). No file was requested from ${MODEL_FETCH_HOST}.`,
    };
  }
  const files =
    typeof body === 'object' && body !== null && Array.isArray((body as { files?: unknown }).files)
      ? ((body as { files: readonly unknown[] }).files.filter(
          (f): f is string => typeof f === 'string',
        ) as readonly string[])
      : null;
  const declared =
    typeof body === 'object' && body !== null && Array.isArray((body as { files?: unknown }).files)
      ? (body as { files: readonly unknown[] }).files.length
      : -1;
  if (files === null || files.length !== declared) {
    return {
      ok: false,
      httpStatus: 400,
      code: 'VALIDATION_ERROR',
      detail: 'Body must be an object with a `files` array of relative path strings.',
    };
  }

  const modelsDir = resolveModelsDir(
    options.modelsDir === undefined ? {} : { modelsDir: options.modelsDir },
  );
  const target = resolveModelFetchTarget(rawOrg, rawRepo, files, modelsDir);
  if (target === null) {
    return {
      ok: false,
      httpStatus: 400,
      code: 'MODEL_PATH_REJECTED',
      detail: `Invalid or unsafe model path (or file count outside 1..${String(MODEL_FETCH_MAX_FILES)}).`,
    };
  }

  return {
    ok: true,
    status: startModelFetch({
      target,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.log === undefined ? {} : { log: options.log }),
    }),
  };
};

/**
 * GET /v1/models/{org}/{repo}/fetch — the job status. Never starts anything;
 * an id with no job reads 'idle'. Authenticated like the POST (the streaming
 * serve route's unauthenticated exemption exists for transformers.js' internal
 * fetch and does not extend to this).
 */
export const handleModelFetchStatus = (rawOrg: string, rawRepo: string): ModelFetchOutcome => {
  const org = decodeSegment(rawOrg);
  const repo = decodeSegment(rawRepo);
  if (org === null || repo === null || org.length === 0 || repo.length === 0) {
    return {
      ok: false,
      httpStatus: 400,
      code: 'MODEL_PATH_REJECTED',
      detail: 'Invalid model id.',
    };
  }
  return { ok: true, status: modelFetchStatus(`${org}/${repo}`) };
};

// Companion model-cache client — "is this model on the companion, and if not,
// can we put it there?"
//
// THE BUG THIS CLOSES. The Health row offered "Load local model" for any
// registry entry, and the load could only ever succeed for a model that
// happened to already be in the companion's cache. Selecting the Nano-class
// model and clicking load produced transformers.js' raw
// `Could not locate file: "http://127.0.0.1:17374/v1/models/.../config.json"`
// — a message that names a URL the user cannot act on and never mentions the
// one thing that would fix it. The model host was a mirror with no way to fill
// it (companion: modelFetchRoute.ts) and the panel had no way to ask.
//
// So this module does exactly two things:
//   1. PROBE — is the model already cached? A HEAD against the companion's own
//      model host for config.json. 200 ⇒ cached, 404 ⇒ not. Loopback only, no
//      auth (the serve route is deliberately unauthenticated), no side effects.
//   2. FETCH — ask the companion to download the registry-declared file list
//      from huggingface.co, and poll the resulting background job.
//
// CONSENT SHAPE. The probe runs freely (it is a local HEAD). The fetch runs
// ONLY from an explicit button that states the size and the host, and it is a
// SEPARATE consent from the load: downloading to the companion does not load
// anything into the browser, and loading never downloads from HF. Keeping them
// apart is the point — one is "3.3GB crosses the internet onto my disk", the
// other is "3.3GB crosses loopback into my GPU".

import type { LocalModelSpec } from './modelRegistry';

/** The host the companion contacts for a fetch. Stated in the UI, not implied. */
export const MODEL_FETCH_HOST = 'huggingface.co';

/** Mirrors the companion's job status (modelFetchRoute.ts). */
export type ModelFetchState = 'idle' | 'running' | 'done' | 'error';

export interface ModelFetchStatus {
  readonly modelId: string;
  readonly state: ModelFetchState;
  readonly filesDone: number;
  readonly filesTotal: number;
  readonly bytesDone: number;
  readonly bytesTotal: number;
  readonly currentFile: string | null;
  readonly host: string;
  readonly error?: string;
}

const idleStatus = (modelId: string): ModelFetchStatus => ({
  modelId,
  state: 'idle',
  filesDone: 0,
  filesTotal: 0,
  bytesDone: 0,
  bytesTotal: 0,
  currentFile: null,
  host: MODEL_FETCH_HOST,
});

const base = (port: number): string => `http://127.0.0.1:${String(port)}`;

/**
 * Whether the companion can already serve this model. Probes config.json —
 * transformers.js' first request and the exact file whose absence produced the
 * user-visible error, so a 200 here means the load's first step will succeed.
 *
 * HEAD, not GET: config.json is small, but the point is to assert presence
 * without transferring anything. Any network/CORS failure reads as "unknown"
 * (null) rather than "missing", so a companion hiccup never hides the Load
 * button behind a download offer that isn't needed.
 */
export const probeModelCached = async (options: {
  readonly port: number;
  readonly spec: LocalModelSpec;
  readonly fetchImpl?: typeof fetch;
}): Promise<boolean | null> => {
  const doFetch = options.fetchImpl ?? fetch;
  const url =
    `${base(options.port)}/v1/models/${options.spec.id}` +
    `/resolve/${options.spec.revision}/config.json`;
  try {
    const response = await doFetch(url, { method: 'HEAD' });
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    return null;
  } catch {
    return null;
  }
};

const statusUrl = (port: number, modelId: string): string =>
  // Cache-buster: the companion ETags its GET bodies, and a browser revalidation
  // would hand this poll a stale 200 from the HTTP cache. Progress that does not
  // move is worse than no progress bar.
  `${base(port)}/v1/models/${modelId}/fetch?t=${String(Date.now())}`;

const parseStatus = async (
  response: Response,
  modelId: string,
): Promise<ModelFetchStatus> => {
  const body = (await response.json().catch(() => null)) as {
    data?: Partial<ModelFetchStatus>;
  } | null;
  const data = body?.data;
  if (data === undefined || data === null) return idleStatus(modelId);
  return {
    modelId,
    state: data.state ?? 'idle',
    filesDone: data.filesDone ?? 0,
    filesTotal: data.filesTotal ?? 0,
    bytesDone: data.bytesDone ?? 0,
    bytesTotal: data.bytesTotal ?? 0,
    currentFile: data.currentFile ?? null,
    host: data.host ?? MODEL_FETCH_HOST,
    ...(data.error === undefined ? {} : { error: data.error }),
  };
};

/** A typed failure the row renders verbatim — never a bare thrown string. */
export class ModelFetchError extends Error {}

/**
 * Ask the companion to download this model's DECLARED file list from
 * huggingface.co. Returns the initial job status; the transfer runs in the
 * companion's background and is followed with readModelFetchStatus.
 *
 * The file list comes from the registry (spec.files) because only the registry
 * knows the export's layout — a single-graph text model and a multi-graph
 * multimodal one need different files, and the companion must not guess.
 */
export const startModelFetch = async (options: {
  readonly port: number;
  readonly bridgeKey: string;
  readonly spec: LocalModelSpec;
  readonly fetchImpl?: typeof fetch;
}): Promise<ModelFetchStatus> => {
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(`${base(options.port)}/v1/models/${options.spec.id}/fetch`, {
    method: 'POST',
    headers: {
      'x-bac-bridge-key': options.bridgeKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ files: options.spec.files }),
  });
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as {
      code?: string;
      detail?: string;
    } | null;
    if (problem?.code === 'MODEL_FETCH_DISABLED') {
      throw new ModelFetchError(
        'Model downloading is turned off on the companion (SIDETRACK_MODEL_FETCH=0).',
      );
    }
    throw new ModelFetchError(
      problem?.detail ?? `companion refused the download (${String(response.status)})`,
    );
  }
  return parseStatus(response, options.spec.id);
};

/** Poll the background job. 'idle' when the companion has no job for this id. */
export const readModelFetchStatus = async (options: {
  readonly port: number;
  readonly bridgeKey: string;
  readonly modelId: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<ModelFetchStatus> => {
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(statusUrl(options.port, options.modelId), {
    headers: { 'x-bac-bridge-key': options.bridgeKey },
  });
  if (!response.ok) return idleStatus(options.modelId);
  return parseStatus(response, options.modelId);
};

// ---- copy ---------------------------------------------------------------

/** "3.3GB" / "820MB" — same rounding as the registry's size line. */
const sizeLabel = (bytes: number): string =>
  bytes >= 1_000_000_000
    ? `${(bytes / 1_000_000_000).toFixed(1)}GB`
    : `${String(Math.round(bytes / 1_000_000))}MB`;

/**
 * The download button's label. It states BOTH costs the user is consenting to:
 * how much data, and which non-loopback host it comes from. "Download" alone
 * would hide the outbound; a size alone would hide the wait.
 */
export const downloadButtonLabel = (spec: LocalModelSpec): string =>
  `Download to companion · ${sizeLabel(spec.approxBytesOnDisk)} from ${MODEL_FETCH_HOST}`;

/**
 * The progress line: files, percent, and WHICH file is moving. Percent is
 * omitted rather than faked when the companion could not size the bundle.
 */
export const fetchProgressLabel = (status: ModelFetchStatus): string => {
  const files = `${String(status.filesDone)}/${String(status.filesTotal)} files`;
  const percent =
    status.bytesTotal > 0
      ? ` · ${String(Math.min(100, Math.floor((status.bytesDone / status.bytesTotal) * 100)))}%`
      : '';
  const size =
    status.bytesTotal > 0
      ? ` (${sizeLabel(status.bytesDone)} of ${sizeLabel(status.bytesTotal)})`
      : '';
  const current = status.currentFile === null ? '' : ` · ${status.currentFile}`;
  return `Downloading from ${status.host} · ${files}${percent}${size}${current}`;
};

/**
 * What to say when the user asks to LOAD a model the companion does not have.
 *
 * This string exists to replace transformers.js' `Could not locate file:
 * "http://127.0.0.1:.../config.json"`. That error was accurate and useless: it
 * described a missing URL instead of the missing STEP. Every word here points
 * at the button that fixes it.
 */
export const notCachedMessage = (spec: LocalModelSpec): string =>
  `${spec.label} is not on the companion yet — download it first ` +
  `(${sizeLabel(spec.approxBytesOnDisk)} from ${MODEL_FETCH_HOST}), then load it.`;

/**
 * Recognize the raw transformers.js "file missing" failure so a load that
 * slipped past the pre-check (a file removed mid-session, a partial cache) is
 * still reported as the actionable state rather than the raw URL string.
 */
export const isNotCachedError = (message: string): boolean =>
  message.includes('Could not locate file') || message.includes('MODEL_FILE_NOT_FOUND');

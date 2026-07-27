// Model-host route — the companion as a local HuggingFace-layout model mirror
// (WebGPU-enrichment pass). Generation moved OUT of the companion (onnxruntime-
// node cannot run the gemma-3-1b q4 op set — measured) and INTO the extension
// panel via transformers.js + WebGPU. transformers.js resolves model files by
// fetching `{remoteHost}/{model}/resolve/{revision}/{file}`; pointing its
// `remoteHost` at the loopback companion lets the panel pull the SAME model the
// companion already cached for its embedder — no second multi-hundred-MB
// download, no public-internet fetch.
//
// FROZEN CONTRACT:
//   GET /v1/models/{org}/{repo}/resolve/{revision}/{filePath...}
//   → {modelsDir}/{org}/{repo}/{filePath}
// where {modelsDir} is the SAME resolveModelsDir() the embedder uses (HF caches
// under <root>/<org>/<repo>/...), and {revision} is ACCEPTED AND IGNORED (it is
// only present for HF-layout compatibility — the local cache is a single
// checked-out revision, not a git object store).
//
// UNAUTHENTICATED — DELIBERATE POSTURE. This route is exempt from the bridge
// key. Two load-bearing reasons:
//   1. transformers.js issues its model fetches through its own internal
//      `fetch`; there is no seam to inject the `x-bac-bridge-key` header the
//      rest of the API requires, so an authenticated model route would be
//      unreachable by the very client it exists for.
//   2. The exposure is bounded and non-secret: the server is loopback-only
//      (the host/origin gate rejects every off-loopback caller BEFORE any route
//      work), and the files served are public, redistributable model weights —
//      not vault data. The path-traversal defense below confines reads to the
//      models directory, so an attacker on loopback can read model files they
//      could already download from HF, and nothing else.
//
// STREAMING. Model files run to ~2GB (the gemma q4 shard is ~819MB). The
// response is streamed with node `fs.createReadStream(...).pipe(response)` (Bun-
// compatible) rather than buffered into memory — a 819MB Buffer per fetch would
// blow the companion's heap. Content-Length is set from the stat so the browser
// shows real download progress; ETag (size+mtime) + a one-year immutable
// Cache-Control let the browser cache the weights once and never re-fetch.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { resolveModelsDir } from '../recall/modelCache.js';

// The path prefix under which every model file lives. Kept as a constant so the
// server's unauthenticated-path predicate and the route matcher agree on ONE
// spelling.
export const MODEL_HOST_PATH_PREFIX = '/v1/models/';

// Matches GET /v1/models/{org}/{repo}/resolve/{revision}/{filePath...}. The
// filePath tail is greedy (captures nested paths like `onnx/model_q4.onnx`);
// org/repo/revision are single segments (no slashes). We do NOT constrain the
// character classes tightly here — the traversal defense below is the real
// gate; over-tight classes would reject legitimate HF file names.
const MODEL_HOST_PATTERN =
  /^\/v1\/models\/([^/]+)\/([^/]+)\/resolve\/([^/]+)\/(.+)$/u;

// A GET (or HEAD) request whose pathname is under the model-host prefix. Used by
// the server to know it must intercept this request for streaming BEFORE the
// JSON route dispatch (the JSON dispatch can only return an in-memory body). The
// method check lives at the call site (GET/HEAD only).
export const isModelHostPath = (pathname: string): boolean =>
  pathname.startsWith(MODEL_HOST_PATH_PREFIX);

export interface ModelFileTarget {
  readonly org: string;
  readonly repo: string;
  // The requested revision — recorded for logging, NOT used to resolve the
  // path (the local cache is single-revision).
  readonly revision: string;
  readonly filePath: string;
  // The confined absolute path under modelsDir. Guaranteed to be inside
  // modelsDir (prefix-checked after normalization) — never escapes via `..`.
  readonly absolutePath: string;
}

// Parse + confine a model-host pathname to an absolute file path under
// modelsDir, or return null when the request is malformed OR would escape the
// models directory.
//
// TRAVERSAL DEFENSE (two independent layers):
//   1. Reject any decoded segment that is exactly '..' (or contains a raw '/'
//      or '\' after decode) BEFORE joining. `%2e%2e%2f`-style attacks decode to
//      '../' here and are caught.
//   2. After join+normalize, require the result to sit under `modelsDir + sep`
//      (or equal modelsDir). A normalized path that climbed out via any residual
//      `..` fails the prefix check. Belt-and-suspenders: layer 1 alone would
//      suffice, but the prefix check is the invariant that must hold no matter
//      how the tail was spelled.
export const resolveModelFileTarget = (
  pathname: string,
  modelsDir: string,
): ModelFileTarget | null => {
  const match = MODEL_HOST_PATTERN.exec(pathname);
  if (match === null) return null;
  const org = decodeSegment(match[1]);
  const repo = decodeSegment(match[2]);
  const revision = decodeSegment(match[3]);
  // The file tail may contain slashes (nested files). Decode each segment
  // independently so a `%2f` inside a segment can't smuggle a new path
  // boundary past the per-segment '..' check.
  const rawTail = match[4] ?? '';
  const tailSegments = rawTail.split('/').map((seg) => decodeSegment(seg));
  if (org === null || repo === null || revision === null) return null;
  if (tailSegments.some((seg) => seg === null)) return null;
  const decodedTail = tailSegments as readonly string[];

  // Layer 1 — reject traversal / empty / boundary-smuggling segments up front.
  const allSegments = [org, repo, ...decodedTail];
  for (const seg of allSegments) {
    if (seg.length === 0) return null;
    if (seg === '.' || seg === '..') return null;
    // A decoded segment must not itself contain a path separator — that would
    // mean an encoded slash/backslash slipped through and could re-introduce a
    // boundary the split above already accounted for on the wire.
    if (seg.includes('/') || seg.includes('\\')) return null;
    // Raw NUL inside a segment is a classic path-truncation trick — reject. The
    // control char is produced via fromCharCode so no literal NUL byte lives in
    // this source (standing review check).
    if (seg.includes(String.fromCharCode(0))) return null;
  }

  const absolutePath = normalize(join(modelsDir, org, repo, ...decodedTail));
  // Layer 2 — the confinement invariant. Must be modelsDir itself or strictly
  // beneath it.
  const root = normalize(modelsDir);
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  if (absolutePath !== root && !absolutePath.startsWith(rootWithSep)) return null;

  return {
    org,
    repo,
    revision,
    filePath: decodedTail.join('/'),
    absolutePath,
  };
};

// Percent-decode one path segment; null when it is not valid encoding (a
// malformed `%` sequence throws in decodeURIComponent — treat as a bad request
// rather than 500).
const decodeSegment = (segment: string | undefined): string | null => {
  if (segment === undefined) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

// The typed 404 body — same problem-shape family the JSON routes use so the
// panel sees a consistent error envelope even for the streamed route.
const notFoundBody = (detail: string): string =>
  `${JSON.stringify({
    status: 404,
    code: 'MODEL_FILE_NOT_FOUND',
    title: 'Model file not found.',
    detail,
  })}\n`;

const badRequestBody = (detail: string): string =>
  `${JSON.stringify({
    status: 400,
    code: 'MODEL_PATH_REJECTED',
    title: 'Model path rejected.',
    detail,
  })}\n`;

// Headers common to the file response (GET body + HEAD). CORS-open (the panel is
// a loopback origin; the host/origin gate already vetted it) so transformers.js'
// fetch can read the body across the extension origin.
const fileHeaders = (
  size: number,
  contentType: string,
  etag: string,
): Record<string, string> => ({
  'access-control-allow-origin': '*',
  'content-type': contentType,
  'content-length': String(size),
  // The weights are content-addressed by revision in HF layout and never change
  // under a given URL, so a long immutable cache is correct — the browser caches
  // the ~819MB shard once and re-fetches only if the URL (revision) changes.
  'cache-control': 'public, max-age=31536000, immutable',
  etag,
});

// ETag from size+mtime — cheap, stable per file version, no content hash of a
// 2GB file. Weak validator is fine here (the panel only needs cache validation,
// not byte-range integrity).
const etagFor = (size: number, mtimeMs: number): string =>
  `"m-${size.toString(16)}-${Math.trunc(mtimeMs).toString(16)}"`;

// Best-effort content type from the file extension. Model artifacts are .onnx /
// .json / .txt / binary; an unknown extension falls back to octet-stream. This
// is advisory only — transformers.js keys off the URL, not the MIME type.
const contentTypeFor = (filePath: string): string => {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.txt')) return 'text/plain; charset=utf-8';
  if (lower.endsWith('.onnx') || lower.endsWith('.onnx_data')) return 'application/octet-stream';
  if (lower.endsWith('.bin') || lower.endsWith('.safetensors')) return 'application/octet-stream';
  return 'application/octet-stream';
};

export interface ServeModelFileOptions {
  // Override the models directory (tests point this at a fixture dir). Absent ⇒
  // the SAME resolveModelsDir() the embedder uses.
  readonly modelsDir?: string;
}

// Serve (or HEAD) a model file for a request whose pathname is under the model-
// host prefix. Writes the full response (headers + streamed body, or a typed
// error) and resolves when the response is finished. NEVER throws into the
// caller — every failure path writes a bounded error response.
//
// GET only (plus HEAD, which returns the headers with no body). Any other method
// is a 405. The caller has already verified isModelHostPath(pathname).
export const serveModelFile = async (
  request: IncomingMessage,
  response: ServerResponse,
  options: ServeModelFileOptions = {},
): Promise<void> => {
  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    writeError(response, 405, 'access-control-allow-origin', badRequestBody('Method not allowed.'));
    return;
  }

  const url = request.url === undefined ? undefined : new URL(request.url, 'http://127.0.0.1');
  if (url === undefined) {
    writeError(response, 400, undefined, badRequestBody('Missing request URL.'));
    return;
  }

  const modelsDir = resolveModelsDir(
    options.modelsDir === undefined ? {} : { modelsDir: options.modelsDir },
  );
  const target = resolveModelFileTarget(url.pathname, modelsDir);
  if (target === null) {
    // Malformed or traversal-escaping path → 400 (not 404): the request itself
    // is rejected, we never even stat a file outside the cache.
    writeError(response, 400, undefined, badRequestBody('Invalid or unsafe model path.'));
    return;
  }

  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(target.absolutePath);
  } catch {
    writeError(response, 404, undefined, notFoundBody(`No cached model file for ${target.filePath}.`));
    return;
  }
  if (!fileStat.isFile()) {
    writeError(response, 404, undefined, notFoundBody(`${target.filePath} is not a file.`));
    return;
  }

  const etag = etagFor(fileStat.size, fileStat.mtimeMs);
  const headers = fileHeaders(fileStat.size, contentTypeFor(target.filePath), etag);

  // Conditional GET: an If-None-Match hit returns 304 with no body (the browser
  // reuses its cached ~819MB copy). Cheap validator match on the size+mtime tag.
  const ifNoneMatch = request.headers['if-none-match'];
  const incoming = Array.isArray(ifNoneMatch) ? ifNoneMatch[0] : ifNoneMatch;
  if (typeof incoming === 'string' && incoming === etag) {
    response.writeHead(304, {
      'access-control-allow-origin': '*',
      'cache-control': headers['cache-control']!,
      etag,
    });
    response.end();
    return;
  }

  if (method === 'HEAD') {
    // HEAD returns the exact GET headers (incl. Content-Length) with no body so
    // the panel can size the download before committing to it.
    response.writeHead(200, headers);
    response.end();
    return;
  }

  // Stream the body. createReadStream keeps memory flat regardless of file size;
  // pipe() handles backpressure to the socket. A mid-stream read error (file
  // deleted under us) destroys the response — the headers are already sent so we
  // cannot switch to a 500, but the connection close signals the incomplete
  // transfer to the client (which retries).
  response.writeHead(200, headers);
  const stream = createReadStream(target.absolutePath);
  await new Promise<void>((resolve) => {
    stream.on('error', () => {
      response.destroy();
      resolve();
    });
    response.on('close', () => {
      stream.destroy();
      resolve();
    });
    stream.on('end', () => resolve());
    stream.pipe(response);
  });
};

// Write a bounded error response (JSON problem body). `extraHeaderKey` is a
// no-op hook kept for symmetry; the CORS header is always set so the panel can
// read the error.
const writeError = (
  response: ServerResponse,
  status: number,
  _extraHeaderKey: string | undefined,
  body: string,
): void => {
  response.writeHead(status, {
    'access-control-allow-origin': '*',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
  });
  response.end(body);
};

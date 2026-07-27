// Companion-side local-LLM title synthesis — the browser-INDEPENDENT half of
// the title-enrichment arc (PR #295 shipped the panel/Gemini-Nano POST path).
//
// WHY a companion path at all: the panel path only fires while a Chrome with
// the built-in Prompt API is open and pointed at the right pages. This module
// lets the companion generate the SAME kind of descriptive titles itself, with
// a small open ONNX model, on a budgeted background sweep — so junk-titled
// threads get fixed even on a machine whose browser can't (or won't) run Nano.
//
// It appends the SAME ENTITY_TITLE_ENRICHED events through the SAME idempotent
// helper (appendEnrichmentEvent) the POST route uses — one overlay, one fold,
// one dedupe key. The only difference is the PRODUCER.
//
// STRICT off-main-loop discipline (repo runtime-agility doctrine): generation
// NEVER runs on the companion's main loop. The parent (this module) writes a
// job file and forks localLlmChild.entry.ts; inference happens in that child
// process. The parent enforces a hard timeout and kills the child on breach.
// Spawn mechanics mirror recall/indexerClient.ts (fork + withBunSmolExecArgv +
// piped stdio + existsSync entry guard).
//
// FLAG: SIDETRACK_LOCAL_LLM, default OFF. Opt-in because the first run
// downloads ~1GB. When off, the routes 200 {disabled:true} and no child is
// ever spawned.

import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { withBunSmolExecArgv } from '../process/bunMemory.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { EventLog } from '../sync/eventLog.js';
import {
  THREAD_ARCHIVED,
  THREAD_DELETED,
  THREAD_UNARCHIVED,
  THREAD_UPSERTED,
} from '../threads/events.js';
import { projectThread } from '../threads/projection.js';

import {
  ENTITY_TITLE_ENRICHED,
  appendEnrichmentEvent,
  enrichmentClientEventId,
  isJunkTitle,
  type EntityTitleEnrichedPayload,
} from './titleEnrichment.js';
import { MIN_CONTENT_CHARS, type LocalLlmJob, type LocalLlmResult } from './localLlmChild.entry.js';

// ---- flag + model id --------------------------------------------------

export const LOCAL_LLM_ENV = 'SIDETRACK_LOCAL_LLM';
export const LOCAL_LLM_MODEL_ENV = 'SIDETRACK_LOCAL_LLM_MODEL';

// Default OFF — only an explicit '1'/'true' enables (opt-in, downloads ~1GB on
// first use). Read at each call site so a runtime flip takes effect without a
// restart and tests can assert disabled behavior.
export const localLlmEnabled = (): boolean => {
  const raw = process.env[LOCAL_LLM_ENV];
  return raw === '1' || raw === 'true';
};

// Default model. VERIFIED: @huggingface/transformers 3.8.1 registers
// `gemma3_text` in MODEL_FOR_CAUSAL_LM_MAPPING_NAMES → Gemma3ForCausalLM, and
// text-generation resolves through AutoModelForCausalLM, so this ONNX model
// loads under Bun/onnxruntime-node. Override with SIDETRACK_LOCAL_LLM_MODEL.
export const LOCAL_LLM_MODEL_ID = ((): string => {
  const raw = process.env[LOCAL_LLM_MODEL_ENV];
  return typeof raw === 'string' && raw.length > 0
    ? raw
    : 'onnx-community/gemma-3-1b-it-ONNX';
})();

// Hard timeouts (env-tunable). The FIRST run downloads the model (~1GB) so it
// gets a generous 20-minute cap; a warm run only pays inference latency so
// 5 minutes is ample. On breach the parent SIGKILLs the child and records the
// sweep as errored — the main loop is never blocked either way.
const COLD_TIMEOUT_MS = envMs('SIDETRACK_LOCAL_LLM_COLD_TIMEOUT_MS', 20 * 60_000);
const WARM_TIMEOUT_MS = envMs('SIDETRACK_LOCAL_LLM_WARM_TIMEOUT_MS', 5 * 60_000);

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---- child runner (spawn mechanics mirror indexerClient.ts) -----------

// The parent → child handoff is file-based (see localLlmChild.entry.ts): write
// the job JSON, fork with its path as argv, wait for exit, read the result
// JSON. Injectable so tests can supply a fake runner and NEVER load the real
// model.
export interface ChildRunnerInput {
  readonly job: LocalLlmJob;
  readonly timeoutMs: number;
  readonly logPath: string;
}
export type ChildRunner = (input: ChildRunnerInput) => Promise<LocalLlmResult>;

const defaultEntryPath = (): string => {
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), 'localLlmChild.entry.js');
};

// Real fork-based runner. Writes the job to a temp file, forks the child entry
// with the job path as argv, streams the child's stdout/stderr to the vault
// log file, enforces the hard timeout (SIGKILL on breach), then reads + parses
// the result file. Cleans up the temp files on the way out.
export const forkChildRunner: ChildRunner = async (input) => {
  const entryPath = defaultEntryPath();
  if (!existsSync(entryPath)) {
    throw new Error(`local-llm child entry not found at ${entryPath}`);
  }
  const jobDir = join(tmpdir(), 'sidetrack-localllm');
  await mkdir(jobDir, { recursive: true });
  const jobPath = join(jobDir, `job-${Date.now()}-${process.pid}.json`);
  const resultPath = `${jobPath}.result.json`;
  await writeFile(jobPath, JSON.stringify(input.job));

  const logChunks: string[] = [];
  const result = await new Promise<LocalLlmResult>((resolve, reject) => {
    let settled = false;
    let child: ChildProcess | null = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logChunks.push(`[timeout] killing child after ${String(input.timeoutMs)}ms\n`);
      child?.kill('SIGKILL');
      reject(new Error(`local-llm child timed out after ${String(input.timeoutMs)}ms`));
    }, input.timeoutMs);

    child = fork(entryPath, [jobPath], {
      env: process.env,
      execArgv: withBunSmolExecArgv(process.execArgv),
      // No IPC channel needed (file handoff) — just capture stdio for the log.
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout?.on('data', (buf: Buffer) => logChunks.push(buf.toString('utf8')));
    child.stderr?.on('data', (buf: Buffer) => logChunks.push(buf.toString('utf8')));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void (async () => {
        try {
          const parsed = JSON.parse(await readFile(resultPath, 'utf8')) as LocalLlmResult;
          resolve(parsed);
        } catch (err) {
          reject(
            new Error(
              `local-llm child exited code=${String(code)} signal=${String(
                signal ?? '',
              )} without a readable result: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }
      })();
    });
  }).finally(async () => {
    // Persist the captured child log under the vault, best-effort, then clean
    // the temp job/result files.
    await writeFile(input.logPath, logChunks.join('')).catch(() => undefined);
    await rm(jobPath, { force: true }).catch(() => undefined);
    await rm(resultPath, { force: true }).catch(() => undefined);
  });
  return result;
};

// ---- singleton job state ----------------------------------------------

export interface TitleSweepResult {
  readonly id: string;
  readonly before: string;
  readonly after: string;
  readonly ms: number;
}

export interface TitleSweepStatus {
  readonly state: 'idle' | 'running' | 'done' | 'error';
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly modelId: string;
  readonly generated: number;
  readonly accepted: number;
  readonly skipped: number;
  // Capped at RESULTS_CAP most-recent accepted titles (before → after).
  readonly results: readonly TitleSweepResult[];
  readonly error?: string;
}

const RESULTS_CAP = 20;

// Module-level singleton (single-lane, same discipline as the enrichment fold
// memo): one sweep at a time per process. A second start while one runs
// returns the running job's status untouched.
interface JobState {
  state: 'idle' | 'running' | 'done' | 'error';
  startedAt?: string;
  finishedAt?: string;
  generated: number;
  accepted: number;
  skipped: number;
  results: TitleSweepResult[];
  error?: string;
}

let job: JobState = {
  state: 'idle',
  generated: 0,
  accepted: 0,
  skipped: 0,
  results: [],
};

export const getTitleSweepStatus = (): TitleSweepStatus => ({
  state: job.state,
  ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
  ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
  modelId: LOCAL_LLM_MODEL_ID,
  generated: job.generated,
  accepted: job.accepted,
  skipped: job.skipped,
  results: job.results.slice(-RESULTS_CAP),
  ...(job.error === undefined ? {} : { error: job.error }),
});

// ---- junk-thread selection --------------------------------------------

// Thread-title junk for the sweep = structural (empty / URL-shaped, the SAME
// isJunkTitle rule the overlay uses) OR verbatim-recurring: the identical
// title string appears on ≥ RECURRING_MIN threads. A generic label like
// "ChatGPT" / "New chat" / "新对话" is not URL-shaped, so the structural rule
// alone would never touch it — but a title shared by dozens of threads carries
// no per-thread signal, exactly what the panel path targets. We detect that
// structurally (a frequency count over the corpus), NO vocabulary list.
const RECURRING_MIN = 3;

const isRecurring = (title: string, counts: ReadonlyMap<string, number>): boolean =>
  (counts.get(title.trim()) ?? 0) >= RECURRING_MIN;

interface SweepCandidate {
  readonly bacId: string;
  readonly rawTitle: string;
}

// Read thread + enrichment events, project every live thread, and return the
// junk-titled ones NOT already enriched for their CURRENT content hash. The
// already-enriched skip reuses the fold's dedupe key (kind,id,hash): if an
// event with the sweep's clientEventId exists, that thread's current content
// was already synthesized → skip. Pure w.r.t. the injected reads so tests can
// drive it with a fake event log.
export const selectSweepCandidates = async (
  eventLog: EventLog,
  contentFor: (bacId: string) => Promise<string | null>,
  hashOf: (content: string) => string,
  budget: number,
): Promise<readonly SweepCandidate[]> => {
  const events = await eventLog.streamFiltered(
    (event) =>
      event.type === THREAD_UPSERTED ||
      event.type === THREAD_ARCHIVED ||
      event.type === THREAD_UNARCHIVED ||
      event.type === THREAD_DELETED,
    new Set<string>([THREAD_UPSERTED, THREAD_ARCHIVED, THREAD_UNARCHIVED, THREAD_DELETED]),
  );
  // Bucket per-bacId once (same posture as buildConnectionsSnapshot) so each
  // projectThread sees only its own events.
  const byBacId = new Map<string, AcceptedEvent[]>();
  for (const event of events) {
    const bacId = (event.payload as { bac_id?: unknown }).bac_id;
    if (typeof bacId !== 'string') continue;
    const existing = byBacId.get(bacId);
    if (existing === undefined) byBacId.set(bacId, [event]);
    else existing.push(event);
  }

  // Title frequency over live threads (verbatim-recurring detection).
  const titleCounts = new Map<string, number>();
  interface LiveThread {
    readonly bacId: string;
    readonly rawTitle: string;
  }
  const live: LiveThread[] = [];
  for (const [bacId, bucket] of byBacId) {
    const projection = projectThread(bacId, bucket);
    if (projection.deleted) continue;
    const record =
      projection.record.status === 'resolved'
        ? projection.record.value
        : projection.record.candidates[0]?.value;
    if (record === undefined) continue;
    const rawTitle = record.title;
    live.push({ bacId, rawTitle });
    const trimmed = (rawTitle ?? '').trim();
    if (trimmed.length > 0) titleCounts.set(trimmed, (titleCounts.get(trimmed) ?? 0) + 1);
  }

  // Sort by bacId for deterministic budget selection.
  live.sort((a, b) => (a.bacId < b.bacId ? -1 : a.bacId > b.bacId ? 1 : 0));

  const candidates: SweepCandidate[] = [];
  for (const thread of live) {
    if (candidates.length >= budget) break;
    const isJunk = isJunkTitle(thread.rawTitle) || isRecurring(thread.rawTitle, titleCounts);
    if (!isJunk) continue;
    // Pull content to compute the current hash + the already-enriched skip. A
    // thread with no readable content (no markdown file yet) is skipped.
    const content = await contentFor(thread.bacId);
    if (content === null || content.trim().length < MIN_CONTENT_CHARS) continue;
    const hash = hashOf(content);
    const clientEventId = enrichmentClientEventId('thread', thread.bacId, hash);
    const existing = await eventLog.findByClientEventId(clientEventId).catch(() => null);
    if (existing !== null) continue; // already enriched for this exact content
    candidates.push({ bacId: thread.bacId, rawTitle: thread.rawTitle ?? '' });
  }
  return candidates;
};

// ---- the sweep ---------------------------------------------------------

export interface StartTitleSweepInput {
  readonly vaultRoot: string;
  readonly eventLog: EventLog;
  readonly budget?: number;
  // Injected in tests to avoid loading the real model. Defaults to the real
  // fork runner.
  readonly childRunner?: ChildRunner;
  // Injected in tests. Defaults to reading the vault's pre-built thread
  // markdown file (the SAME file /v1/threads/:id/markdown serves) — no HTTP
  // self-call.
  readonly contentFor?: (bacId: string) => Promise<string | null>;
  // Injected in tests. Defaults to a stable hex hash (sha256, ≤64 hex — the
  // contract's sourceContentHash bound). Same family as the POST route's key.
  readonly hashOf?: (content: string) => string;
  readonly now?: () => Date;
}

const DEFAULT_BUDGET = 10;

// Default content source: read the pre-built thread markdown from the vault
// (_BAC/threads/<bacId>.md) — the exact file the /v1/threads/:id/markdown
// route serves via readVaultMarkdown. Missing/unreadable ⇒ null (skip).
const defaultContentFor =
  (vaultRoot: string) =>
  async (bacId: string): Promise<string | null> => {
    try {
      return await readFile(join(vaultRoot, '_BAC', 'threads', `${bacId}.md`), 'utf8');
    } catch {
      return null;
    }
  };

// Default content hash: sha256 hex sliced to the contract's ≤64-hex bound.
// (The extension uses fnv1a32 on its own content; the companion hashes the
// markdown it read — a different source — so the hashes need not match across
// producers, only be stable within this producer for the dedupe skip.)
const defaultHashOf = async (): Promise<(content: string) => string> => {
  const { createHash } = await import('node:crypto');
  return (content: string) => createHash('sha256').update(content).digest('hex').slice(0, 64);
};

// Start (or report the already-running) title sweep. SINGLETON: if a sweep is
// already running, returns its status untouched and does NOT start a second.
// The sweep runs in the BACKGROUND — this returns as soon as the job is marked
// running (before the child is spawned), so the HTTP request never blocks on
// the multi-minute model download / generation. Returns the current status.
export const startTitleSweep = async (
  input: StartTitleSweepInput,
): Promise<TitleSweepStatus> => {
  if (job.state === 'running') return getTitleSweepStatus();

  const now = input.now ?? (() => new Date());
  const budget = input.budget ?? DEFAULT_BUDGET;
  const childRunner = input.childRunner ?? forkChildRunner;
  const contentFor = input.contentFor ?? defaultContentFor(input.vaultRoot);
  const hashOf = input.hashOf ?? (await defaultHashOf());

  // Reset the state to a fresh running job.
  job = {
    state: 'running',
    startedAt: now().toISOString(),
    generated: 0,
    accepted: 0,
    skipped: 0,
    results: [],
  };

  // Detached background driver — NOT awaited. The request returns the running
  // status immediately.
  void (async () => {
    try {
      const candidates = await selectSweepCandidates(input.eventLog, contentFor, hashOf, budget);
      if (candidates.length === 0) {
        job.state = 'done';
        job.finishedAt = now().toISOString();
        return;
      }
      // Build the generation job. content is re-read per candidate (cheap; the
      // markdown was already read once during selection, but re-reading keeps
      // the child input self-contained and avoids holding N markdown bodies in
      // the selection map).
      const items: { id: string; content: string }[] = [];
      const contentByBacId = new Map<string, string>();
      for (const candidate of candidates) {
        const content = await contentFor(candidate.bacId);
        if (content === null) {
          job.skipped += 1;
          continue;
        }
        contentByBacId.set(candidate.bacId, content);
        items.push({ id: candidate.bacId, content });
      }
      if (items.length === 0) {
        job.state = 'done';
        job.finishedAt = now().toISOString();
        return;
      }

      // Cold vs warm timeout: the model dir presence is a good proxy for
      // "first run" — but keep it simple and conservative, use the cold
      // (larger) timeout whenever the job has never completed in this process.
      const timeoutMs = hasCompletedOnce ? WARM_TIMEOUT_MS : COLD_TIMEOUT_MS;
      const logPath = join(
        input.vaultRoot,
        '_BAC',
        'logs',
        `local-llm-${now().toISOString().replace(/[:.]/gu, '-')}.log`,
      );
      await mkdir(dirname(logPath), { recursive: true }).catch(() => undefined);

      const result = await childRunner({
        job: { modelId: LOCAL_LLM_MODEL_ID, maxItems: items.length, items },
        timeoutMs,
        logPath,
      });
      hasCompletedOnce = true;

      const rawTitleByBacId = new Map<string, string>(
        candidates.map((c) => [c.bacId, c.rawTitle]),
      );
      for (const r of result.results) {
        job.generated += 1;
        if (r.title === null || r.title.length === 0) {
          job.skipped += 1;
          continue;
        }
        const content = contentByBacId.get(r.id);
        if (content === undefined) {
          job.skipped += 1;
          continue;
        }
        const candidate: EntityTitleEnrichedPayload = {
          payloadVersion: 1,
          kind: 'thread',
          id: r.id,
          synthesizedTitle: r.title,
          sourceContentHash: hashOf(content),
          model: LOCAL_LLM_MODEL_ID,
          generatedAt: now().toISOString(),
        };
        const outcome = await appendEnrichmentEvent(input.eventLog, candidate);
        if (outcome === 'accepted') {
          job.accepted += 1;
          job.results.push({
            id: r.id,
            before: rawTitleByBacId.get(r.id) ?? '',
            after: r.title,
            ms: r.ms,
          });
          if (job.results.length > RESULTS_CAP) job.results = job.results.slice(-RESULTS_CAP);
        } else {
          // 'skipped' (duplicate hash / write failure) or 'invalid'.
          job.skipped += 1;
        }
      }
      job.state = 'done';
      job.finishedAt = now().toISOString();
    } catch (error) {
      job.state = 'error';
      job.finishedAt = now().toISOString();
      job.error = error instanceof Error ? error.message : String(error);
    }
  })();

  return getTitleSweepStatus();
};

// True once any sweep has completed in this process — used to pick the warm
// (shorter) timeout for subsequent runs. The first run pays the model
// download under the cold timeout.
let hasCompletedOnce = false;

// Test hook: reset the singleton to idle so each test starts clean.
export const resetTitleSweepForTest = (): void => {
  job = { state: 'idle', generated: 0, accepted: 0, skipped: 0, results: [] };
  hasCompletedOnce = false;
};

// Re-export the shared type surface so the enrichment module namespace is the
// one import site for consumers.
export { ENTITY_TITLE_ENRICHED };

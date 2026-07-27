// Shared shapes + constants for the local-LLM parent/child handoff.
//
// This module exists so the PARENT (localLlm.ts, loaded by the server at
// boot) and the CHILD entry (localLlmChild.entry.ts, forked per job) can
// share types and the thin-content gate WITHOUT the parent importing the
// entry module at runtime. The entry runs its job main at load when it
// detects it is the forked child — a value import from the parent side
// executed that detection inside the COMPANION process, whose own argv[2]
// is '--vault', and the boot died trying to open '--vault' as a job file
// (live incident, 2026-07-27). Types-only imports would also have fixed
// the parent side, but the constants genuinely belong to both halves —
// so they live here, dependency-free.

export interface LocalLlmJobItem {
  readonly id: string;
  readonly content: string;
}

export interface LocalLlmJob {
  readonly modelId: string;
  readonly maxItems: number;
  readonly items: readonly LocalLlmJobItem[];
}

export interface LocalLlmResultItem {
  readonly id: string;
  readonly title: string | null;
  readonly ms: number;
}

export interface LocalLlmResult {
  readonly results: readonly LocalLlmResultItem[];
  // Present when the model itself failed to load — the parent surfaces
  // this as job state 'error', never as a quiet all-skipped 'done' (the
  // first live sweep reported "done, generated: 4" while the model had
  // never loaded — dishonest accounting this field exists to prevent).
  readonly loadError?: string;
}

// Content thinner than this cannot be titled faithfully — matches the
// panel eval's gate so the worker skips the same threads the human eval
// marks "too thin".
export const MIN_CONTENT_CHARS = 80;

// Environment marker the parent sets on the forked child. The entry runs
// its job main ONLY when this is present — argv alone is not a safe
// discriminator (the companion's own argv[2] is '--vault').
export const LOCAL_LLM_CHILD_ENV = 'SIDETRACK_LOCAL_LLM_CHILD';

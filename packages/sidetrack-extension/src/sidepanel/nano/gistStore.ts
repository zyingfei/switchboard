// Device-local memory of the gists this panel generated, keyed by target.
//
// THE BUG THIS FIXES (user report, 2026-07-27): "the gist just shows for a few
// seconds? why?" — the generated text used to collapse into a subtle "gist
// saved" marker after 8 seconds and the TEXT DISAPPEARED, and it never came
// back when the user returned to the page. The gist is the thing the user
// asked the model to write; hiding it on a timer is the panel deciding the
// user is done reading.
//
// The gist itself lives in the companion (POST /v1/enrichment/content), but the
// companion exposes no read-back route for it today — it folds the gist into
// the content lane's query text and never returns it. So the panel keeps its
// OWN copy of what it generated, device-local, in chrome.storage.local through
// the same one-area accessor the rest of the on-device AI stack uses
// (deviceStore.ts — never `sync`, so nothing here replicates to Google).
//
// One map under one key, capped and pruned oldest-first: a panel that has been
// enriching for a year must not grow an unbounded blob in extension storage.
// Every operation is best-effort and never throws — a storage failure loses the
// convenience of a remembered gist, never a render.

import { readDeviceValue, writeDeviceValue } from './deviceStore';
import type { EnrichmentInputSource } from './enrichmentInput';

const STORE_KEY = 'sidetrack.enrichment.gists.v1';

/** Most remembered gists. Older entries are pruned by savedAt. */
const MAX_ENTRIES = 60;

export interface StoredGist {
  readonly gist: string;
  /** Short engine name that produced it ('Nano' | 'WebGPU' | 'Remote'). */
  readonly engine?: string;
  /** The model identity POSTed with the gist. */
  readonly model?: string;
  /** Which link of the input chain fed the model — drives the honest label. */
  readonly source?: EnrichmentInputSource;
  readonly savedAt: string;
}

type GistMap = Record<string, StoredGist>;

const isStoredGist = (value: unknown): value is StoredGist =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { gist?: unknown }).gist === 'string' &&
  (value as { gist: string }).gist.length > 0 &&
  typeof (value as { savedAt?: unknown }).savedAt === 'string';

const readMap = async (): Promise<GistMap> => {
  const raw = await readDeviceValue<unknown>(STORE_KEY);
  if (typeof raw !== 'object' || raw === null) return {};
  const out: GistMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isStoredGist(value)) out[key] = value;
  }
  return out;
};

/** The remembered gist for a target key, or null. Never throws. */
export const readStoredGist = async (targetKey: string): Promise<StoredGist | null> => {
  try {
    const map = await readMap();
    return map[targetKey] ?? null;
  } catch {
    return null;
  }
};

/** Remember a gist for a target key, pruning the oldest beyond the cap. */
export const writeStoredGist = async (targetKey: string, entry: StoredGist): Promise<void> => {
  try {
    const map = await readMap();
    const next: GistMap = { ...map, [targetKey]: entry };
    const keys = Object.keys(next);
    if (keys.length > MAX_ENTRIES) {
      const oldestFirst = keys.sort((left, right) =>
        (next[left]?.savedAt ?? '') < (next[right]?.savedAt ?? '') ? -1 : 1,
      );
      for (const key of oldestFirst.slice(0, keys.length - MAX_ENTRIES)) {
        delete next[key];
      }
    }
    await writeDeviceValue(STORE_KEY, next);
  } catch {
    // Best-effort: the gist is already saved to the companion. Never throw.
  }
};

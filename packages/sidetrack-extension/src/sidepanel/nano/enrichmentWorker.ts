import {
  builtinLanguageModel,
  contentHashOf,
  MAX_TITLE_CHARS,
  MIN_CONTENT_CHARS,
  sliceForSynthesis,
  synthesizeTitle,
  TITLE_PROMPT_PREFIX,
} from './titleSynthesis';
import { cleanGeneratedTitle, type GenerationEngine } from './engine';

// Budgeted background worker that PERSISTS Nano-synthesized titles via the
// companion, feeding the recommendation corpus (title lane, FTS, title
// vectors → content lane). Triggered by explicit user intent (a button in the
// Health panel's On-device AI row) — NOT an auto loop — while the serving-side
// quality gate is still being observed. The button IS the budgeted run.
//
// Threads only this pass. URL-kind items are in the frozen contract for later
// (visits need a different content source), but out of scope here.

// Structural junk selection: a thread title is junk when it is empty,
// URL-shaped, or recurs verbatim across ≥3 distinct threads (provider defaults
// recur; real titles don't). No vocabulary lists. Shared by the observe-only
// eval and this worker so both target the same threads.
export interface ThreadListItem {
  readonly bac_id: string;
  readonly title?: string;
}

const JUNK_RECURRENCE_THRESHOLD = 3;

export const selectJunkTitledThreads = (
  threads: readonly ThreadListItem[],
  limit: number,
): readonly ThreadListItem[] => {
  const titleCounts = new Map<string, number>();
  for (const t of threads) {
    const title = (t.title ?? '').trim();
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }
  return threads
    .filter((t) => {
      const title = (t.title ?? '').trim();
      return (
        title.length === 0 ||
        /^https?:\/\//iu.test(title) ||
        (titleCounts.get(title) ?? 0) >= JUNK_RECURRENCE_THRESHOLD
      );
    })
    .slice(0, limit);
};

// Persistent dedup: content hashes already submitted, so a re-run doesn't
// re-synthesize or re-POST the same content. Capped; oldest pruned first
// (insertion order is preserved by the stored array).
export const SUBMITTED_STORAGE_KEY = 'sidetrack:titleEnrichmentSubmitted';
export const SUBMITTED_CAP = 500;

const readSubmittedHashes = async (): Promise<string[]> => {
  try {
    const got = await chrome.storage.local.get(SUBMITTED_STORAGE_KEY);
    const v = got[SUBMITTED_STORAGE_KEY];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

const writeSubmittedHashes = async (hashes: readonly string[]): Promise<void> => {
  try {
    // Keep the newest SUBMITTED_CAP; prune oldest (front of the array).
    const capped = hashes.slice(Math.max(0, hashes.length - SUBMITTED_CAP));
    await chrome.storage.local.set({ [SUBMITTED_STORAGE_KEY]: capped });
  } catch {
    // chrome.storage missing in test harness; dedup is best-effort.
  }
};

const MAX_BATCH_ITEMS = 50;

export interface EnrichmentItem {
  readonly kind: 'thread' | 'url';
  readonly id: string;
  readonly synthesizedTitle: string;
  readonly sourceContentHash: string;
  readonly model: 'gemini-nano' | 'gemma-3-1b-it';
  readonly generatedAt: string;
}

// The provenance string the companion records for each engine, so the served
// lane `why` can distinguish "synthesized on Nano" from "on WebGPU/Gemma".
const MODEL_ID_FOR_ENGINE: Record<GenerationEngine['kind'], EnrichmentItem['model']> = {
  nano: 'gemini-nano',
  webgpu: 'gemma-3-1b-it',
};

export interface TitleEnrichmentRun {
  readonly port: number;
  readonly bridgeKey: string;
  readonly budget?: number;
  /**
   * The engine to synthesize with. When omitted the run uses Nano directly
   * (the original path — availability-gated), so existing callers are
   * unchanged. When provided (e.g. an explicitly-loaded WebGPU engine) it
   * generates through the engine interface and records that engine's model id.
   */
  readonly engine?: GenerationEngine;
}

// Synthesize a title through a GenerationEngine (nano OR webgpu), mirroring the
// Nano-direct synthesizeTitle discipline: thin-content gate, slice, SKIP/empty
// → null, cleanup + cap. Kept here so the enrichment worker has one engine-
// agnostic synthesis path.
const synthesizeTitleWithEngine = async (
  engine: GenerationEngine,
  content: string,
): Promise<string | null> => {
  if (content.trim().length < MIN_CONTENT_CHARS) return null;
  const sample = sliceForSynthesis(content);
  try {
    const raw = await engine.generate(`${TITLE_PROMPT_PREFIX}\n${sample}`, { maxNewTokens: 32 });
    const cleaned = cleanGeneratedTitle(raw);
    if (cleaned.length === 0) return null;
    if (cleaned === 'SKIP') return null;
    return cleaned.slice(0, MAX_TITLE_CHARS);
  } catch {
    return null;
  }
};

export interface TitleEnrichmentStats {
  readonly generated: number;
  readonly accepted: number;
  readonly skipped: number;
}

/**
 * Run one budgeted pass: pick junk-titled threads, synthesize titles for up to
 * `budget` of them (skipping content whose hash was already submitted), POST
 * the batch to the companion, and record the accepted hashes. Returns
 * { generated, accepted, skipped }. Synthesizes on the provided engine, or —
 * when none is passed — on Nano directly (availability-gated). Requires a
 * connected companion.
 */
export const runTitleEnrichment = async ({
  port,
  bridgeKey,
  budget = 10,
  engine,
}: TitleEnrichmentRun): Promise<TitleEnrichmentStats> => {
  const empty: TitleEnrichmentStats = { generated: 0, accepted: 0, skipped: 0 };
  // Engine selection: an explicit engine (e.g. loaded WebGPU) wins; otherwise
  // fall back to Nano-direct, which requires the built-in API 'available'.
  const lm = builtinLanguageModel();
  if (engine === undefined) {
    if (lm === undefined) return empty;
    let availability: string;
    try {
      availability = await lm.availability();
    } catch {
      return empty;
    }
    if (availability !== 'available') return empty;
  }
  const modelId: EnrichmentItem['model'] =
    engine !== undefined ? MODEL_ID_FOR_ENGINE[engine.kind] : 'gemini-nano';

  const base = `http://127.0.0.1:${String(port)}`;
  const headers = { 'x-bac-bridge-key': bridgeKey };

  const listRes = await fetch(`${base}/v1/threads`, { headers });
  if (!listRes.ok) return empty;
  const listBody = (await listRes.json().catch(() => null)) as {
    readonly data?: readonly ThreadListItem[];
  } | null;
  const threads = listBody?.data ?? [];
  const junk = selectJunkTitledThreads(threads, budget);
  if (junk.length === 0) return empty;

  const submitted = await readSubmittedHashes();
  const submittedSet = new Set(submitted);

  const items: EnrichmentItem[] = [];
  const newHashes: string[] = [];
  let skipped = 0;
  for (const t of junk) {
    if (items.length >= MAX_BATCH_ITEMS) break;
    const mdRes = await fetch(`${base}/v1/threads/${encodeURIComponent(t.bac_id)}/markdown`, {
      headers,
    });
    const mdBody = mdRes.ok
      ? ((await mdRes.json().catch(() => null)) as { data?: { markdown?: string } } | null)
      : null;
    const content = mdBody?.data?.markdown ?? '';
    const hash = contentHashOf(content);
    if (submittedSet.has(hash)) {
      skipped += 1;
      continue;
    }
    const title =
      engine !== undefined
        ? await synthesizeTitleWithEngine(engine, content)
        : lm !== undefined
          ? await synthesizeTitle(lm, content)
          : null;
    if (title === null) {
      skipped += 1;
      continue;
    }
    items.push({
      kind: 'thread',
      id: t.bac_id,
      synthesizedTitle: title,
      sourceContentHash: hash,
      model: modelId,
      generatedAt: new Date().toISOString(),
    });
    newHashes.push(hash);
  }

  if (items.length === 0) return { generated: 0, accepted: 0, skipped };

  const postRes = await fetch(`${base}/v1/enrichment/titles`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  if (!postRes.ok) return { generated: items.length, accepted: 0, skipped };

  const postBody = (await postRes.json().catch(() => null)) as {
    accepted?: number;
    skipped?: number;
  } | null;
  const accepted = typeof postBody?.accepted === 'number' ? postBody.accepted : items.length;
  const serverSkipped = typeof postBody?.skipped === 'number' ? postBody.skipped : 0;

  // Record hashes we successfully submitted so a re-run won't resubmit them.
  await writeSubmittedHashes([...submitted, ...newHashes]);

  return { generated: items.length, accepted, skipped: skipped + serverSkipped };
};

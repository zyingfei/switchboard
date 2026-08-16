// Prototype-lane evidence gathering — grounded input for offline generation
// (docs/plans/2026-08-16-category-flexibility-hyde.md §3).
//
// A prototype text must be GENERATED-FROM (never free invention): the model
// is only ever shown titles + gists of visits ALREADY FILED into the
// workstream, never the workstream's own name/description. That keeps a
// private-codename workstream's prototype grounded in what the user actually
// visited rather than the model's prior on a label it has never seen (the
// report's central risk, design doc §6.1).
//
// SOURCE OF EVIDENCE. This PR ships against the CURRENT single-membership
// world (the multi-membership store in §1 of the design doc is a separate,
// later phase) — so "the workstream's own evidence" is every canonicalUrl
// whose CURRENT attribution (urls/projection.ts's UrlProjection,
// `currentAttribution.workstreamId`) names that workstream, same authoritative
// join `urlWorkstreamLookupFromProjection` already uses for the content/AI
// lanes. Read via the SAME cheap metadata-only snapshot read (no full
// event-log fold, no re-derivation) — this module never opens its own store
// handle; the caller (prototypeGeneration.ts) passes the companion's already-
// open ConnectionsStore.
//
// LANGUAGE GATE. Ported from `sidetrack-extension/src/sidepanel/nano/
// language.ts` (companion has no dependency edge to the extension package —
// see appleFmEngine.ts's header for why this is a port, not an import).
// Constants and detection logic are kept byte-identical on purpose. Apple FM
// is english-only in THIS codebase's own routing contract
// (`appleCanServe = language === 'en'`), not merely zh-hazardous — so the
// generation gate below is `language === 'en'`, a strict superset of the
// design doc's explicit zh callout, consistent with (not a departure from)
// the established routing precedent.

import { SqliteConnectionsStore } from '../connections/snapshot.js';
import type { ConnectionsStore } from '../connections/snapshot.js';
import { deserializeUrlProjection } from '../urls/projection.js';
import type { GistLookup } from '../enrichment/contentEnrichment.js';
import { lookupGist } from '../enrichment/contentEnrichment.js';

// ---------------------------------------------------------------------------
// Language detection (ported from nano/language.ts — see header).
// ---------------------------------------------------------------------------

export type ContentLanguage = 'en' | 'zh' | 'mixed-en-zh';

const SAMPLE_HEAD_CHARS = 2000;
const SAMPLE_MIDDLE_CHARS = 1000;
const SAMPLE_TAIL_CHARS = 1000;
const SAMPLE_THRESHOLD_CHARS = SAMPLE_HEAD_CHARS + SAMPLE_MIDDLE_CHARS + SAMPLE_TAIL_CHARS;

const HAN_RANGES: readonly (readonly [number, number])[] = [
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0x20000, 0x2a6df],
];

const isHan = (codePoint: number): boolean =>
  HAN_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi);

const isLatinLetter = (codePoint: number): boolean =>
  (codePoint >= 0x41 && codePoint <= 0x5a) ||
  (codePoint >= 0x61 && codePoint <= 0x7a) ||
  (codePoint >= 0xc0 && codePoint <= 0x24f);

export const ZH_DOMINANT_SHARE = 0.6;
export const ZH_MIXED_SHARE = 0.08;
export const ZH_MIXED_MIN_CHARS = 12;

const sampleForDetection = (text: string): string => {
  if (text.length <= SAMPLE_THRESHOLD_CHARS) return text;
  const head = text.slice(0, SAMPLE_HEAD_CHARS);
  const midStart = Math.floor(text.length / 2 - SAMPLE_MIDDLE_CHARS / 2);
  const middle = text.slice(midStart, midStart + SAMPLE_MIDDLE_CHARS);
  const tail = text.slice(text.length - SAMPLE_TAIL_CHARS);
  return `${head}${middle}${tail}`;
};

/** Han-vs-Latin codepoint ratio over a sampled slice. See nano/language.ts
 *  for the full rationale — kept byte-identical here. */
export const detectContentLanguage = (text: string): ContentLanguage => {
  const sample = sampleForDetection(text);
  let han = 0;
  let latin = 0;
  for (const ch of sample) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (isHan(cp)) han += 1;
    else if (isLatinLetter(cp)) latin += 1;
  }
  const scripted = han + latin;
  if (scripted === 0) return 'en';
  const share = han / scripted;
  if (share >= ZH_DOMINANT_SHARE) return 'zh';
  if (share >= ZH_MIXED_SHARE && han >= ZH_MIXED_MIN_CHARS) return 'mixed-en-zh';
  return 'en';
};

/** Whether Apple FM can generate for this content language — mirrors
 *  nano/language.ts's `appleCanServe` exactly (english-only, measured). */
export const appleCanServe = (language: ContentLanguage): boolean => language === 'en';

// ---------------------------------------------------------------------------
// Token budget (ported from nano/chunking.ts — same constants, same names).
// ---------------------------------------------------------------------------

export const TARGET_CHUNK_TOKENS = 900;

export const CHARS_PER_TOKEN: Readonly<Record<ContentLanguage, number>> = {
  en: 4,
  zh: 1.2,
  'mixed-en-zh': 2,
};

// ---------------------------------------------------------------------------
// Evidence gathering.
// ---------------------------------------------------------------------------

export interface WorkstreamEvidenceItem {
  readonly canonicalUrl: string;
  readonly title: string | null;
  readonly gist: string | null;
  readonly firstSeenAtMs: number;
}

const parseIso = (value: string | undefined): number => {
  if (value === undefined) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
};

/**
 * Group every currently-filed canonicalUrl by its workstream, joining in the
 * synthesized gist when one exists. Reads the connections snapshot's
 * METADATA-ONLY urlProjection (no full event-log fold — same discipline
 * `urlWorkstreamLookupFromProjection` enforces for the content/AI lanes) plus
 * the already-memoized gist lookup. Returns an empty map (never throws) when
 * the store is not the sqlite-backed one or the snapshot has no projection
 * yet — both typed-empty upstream, never a crash in a background tick.
 */
export const gatherWorkstreamEvidence = async (
  connectionsStore: ConnectionsStore,
  gistLookup: GistLookup | null,
): Promise<ReadonlyMap<string, readonly WorkstreamEvidenceItem[]>> => {
  if (!(connectionsStore instanceof SqliteConnectionsStore)) return new Map();
  let metadata;
  try {
    metadata = await connectionsStore.readSnapshotMetadata();
  } catch {
    return new Map();
  }
  if (metadata?.urlProjection === undefined) return new Map();
  const projection = deserializeUrlProjection(metadata.urlProjection);
  const byWorkstream = new Map<string, WorkstreamEvidenceItem[]>();
  for (const [canonicalUrl, record] of projection.byCanonicalUrl) {
    const workstreamId = record.currentAttribution?.workstreamId;
    if (workstreamId === null || workstreamId === undefined || workstreamId.length === 0) continue;
    const item: WorkstreamEvidenceItem = {
      canonicalUrl,
      title: record.latestTitle ?? null,
      gist: lookupGist(gistLookup, 'url', canonicalUrl) ?? null,
      firstSeenAtMs: parseIso(record.firstSeenAt),
    };
    const list = byWorkstream.get(workstreamId);
    if (list === undefined) byWorkstream.set(workstreamId, [item]);
    else list.push(item);
  }
  return byWorkstream;
};

/** One evidence item's excerpt text — gist when present (richer signal),
 *  else the title. Never both concatenated per-item (keeps the budget spent
 *  on breadth of pages, not depth of one). */
export const evidenceExcerpt = (item: WorkstreamEvidenceItem): string | null => {
  if (item.gist !== null && item.gist.length > 0) return item.gist;
  if (item.title !== null && item.title.length > 0) return item.title;
  return null;
};

/** The corpus language, detected over a bounded sample of the workstream's
 *  own evidence excerpts (most recent first — a workstream's topic can drift,
 *  and recent evidence is the more decision-relevant sample). */
export const workstreamEvidenceLanguage = (
  items: readonly WorkstreamEvidenceItem[],
): ContentLanguage => {
  const sorted = [...items].sort((left, right) => right.firstSeenAtMs - left.firstSeenAtMs);
  const excerpts: string[] = [];
  for (const item of sorted) {
    const excerpt = evidenceExcerpt(item);
    if (excerpt !== null) excerpts.push(excerpt);
    if (excerpts.join(' ').length >= 4000) break;
  }
  return detectContentLanguage(excerpts.join(' '));
};

/**
 * Select evidence excerpts within a character budget, most-recent-first.
 * Returns the selected items (for provenance — `sourceEvidenceIds`) and the
 * joined text. Bounded by `maxChars`; a single excerpt is never truncated
 * mid-word — an excerpt that would overflow the remaining budget is skipped
 * (not cut), so every included item stays a complete, grounded sentence.
 */
export const selectEvidenceWithinBudget = (
  items: readonly WorkstreamEvidenceItem[],
  maxChars: number,
): { readonly selected: readonly WorkstreamEvidenceItem[]; readonly text: string } => {
  const sorted = [...items].sort((left, right) => right.firstSeenAtMs - left.firstSeenAtMs);
  const selected: WorkstreamEvidenceItem[] = [];
  const parts: string[] = [];
  let used = 0;
  for (const item of sorted) {
    const excerpt = evidenceExcerpt(item);
    if (excerpt === null) continue;
    const cost = excerpt.length + 1;
    if (used + cost > maxChars) {
      if (selected.length === 0) {
        // Cold-start guard: a single excerpt longer than the whole budget
        // still contributes ONE (truncated) entry rather than generating
        // from zero evidence — better than an empty prompt.
        selected.push(item);
        parts.push(excerpt.slice(0, Math.max(0, maxChars)));
      }
      break;
    }
    selected.push(item);
    parts.push(excerpt);
    used += cost;
  }
  return { selected, text: parts.join('\n') };
};

/** Evidence char budget for an english generation call against a given
 *  context window, mirroring the design doc's TARGET_CHUNK_TOKENS /
 *  CHARS_PER_TOKEN convention capped to the engine's measured input limit. */
export const evidenceBudgetChars = (engineMaxInputChars: number): number =>
  Math.min(Math.floor(TARGET_CHUNK_TOKENS * CHARS_PER_TOKEN.en), engineMaxInputChars);

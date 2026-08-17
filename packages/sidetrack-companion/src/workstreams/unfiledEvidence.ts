// Unfiled evidence gathering — the population source for NEW-TOPIC
// suggestions (docs/plans/2026-08-16-category-flexibility-hyde.md §4's
// "new-category" mode, wired to real data for the first time here — the
// "missing half of 'suggest new categories AND splits'").
//
// STRUCTURAL INVERSE of workstreams/prototypeEvidence.ts's
// gatherWorkstreamEvidence: same metadata-only snapshot read (no full
// event-log fold — the connections snapshot's already-projected
// urlProjection), same "read via the caller's already-open ConnectionsStore"
// discipline, same never-throws/typed-empty-on-unavailable contract — but
// filters IN records with NO currentAttribution.workstreamId instead of
// filtering TO one workstream's members.
//
// ENV-CAPPED, MOST-RECENT-FIRST POPULATION. An "unfiled" set can be a
// vault's entire long tail; clustering it whole on every recompute would
// break the no-full-rebuild discipline this whole feature is under.
// SIDETRACK_UNFILED_POPULATION_CAP bounds how many of the most-recently-seen
// unfiled pages are even OFFERED to recomputeSuggestionCandidates — the same
// idiom keywordBackfillLane.ts's population cap and prototypeEvidence.ts's
// selectEvidenceWithinBudget both already use.
//
// EMBEDDINGS ARE OPTIONAL BY DESIGN. Wiring live recall-v2 vector retrieval
// per unfiled page is explicitly DEFERRED here — the same scope cut the
// sibling category-multi-membership PR made for its own evidence gathering
// ("real-data wiring... touches files outside this PR's scope", recall-v2
// being a concurrently-developed sibling area). `suggestionEvidenceFromUnfiled`
// takes an OPTIONAL `embeddingForUrl` join; when omitted, every item's
// embedding is empty and splitSuggestionEngine.ts's hybridSimilarity falls
// through to pure concept-Jaccard automatically — no behavior change is
// needed here when that wiring lands later, only a new join function to
// pass in.

import { SqliteConnectionsStore } from '../connections/snapshot.js';
import type { ConnectionsStore } from '../connections/snapshot.js';
import { deserializeUrlProjection } from '../urls/projection.js';
import type { SuggestionEvidenceItem } from './splitSuggestionEngine.js';

export const UNFILED_POPULATION_CAP_ENV = 'SIDETRACK_UNFILED_POPULATION_CAP';
export const DEFAULT_UNFILED_POPULATION_CAP = 500;

export const resolveUnfiledPopulationCap = (): number => {
  const raw = process.env[UNFILED_POPULATION_CAP_ENV];
  if (raw === undefined || raw === '') return DEFAULT_UNFILED_POPULATION_CAP;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_UNFILED_POPULATION_CAP;
  return parsed;
};

export interface UnfiledEvidenceItem {
  readonly canonicalUrl: string;
  readonly title: string | null;
  readonly firstSeenAtMs: number;
}

const parseIso = (value: string | undefined): number => {
  if (value === undefined) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
};

/**
 * Every canonicalUrl with NO current workstream attribution — the inverse
 * filter of prototypeEvidence.ts's gatherWorkstreamEvidence. Returns an
 * empty array (never throws) when the store is not the sqlite-backed one or
 * the snapshot has no projection yet — both typed-empty upstream, matching
 * gatherWorkstreamEvidence's own contract.
 */
export const gatherUnfiledEvidence = async (
  connectionsStore: ConnectionsStore,
): Promise<readonly UnfiledEvidenceItem[]> => {
  if (!(connectionsStore instanceof SqliteConnectionsStore)) return [];
  let metadata;
  try {
    metadata = await connectionsStore.readSnapshotMetadata();
  } catch {
    return [];
  }
  if (metadata?.urlProjection === undefined) return [];
  const projection = deserializeUrlProjection(metadata.urlProjection);
  const items: UnfiledEvidenceItem[] = [];
  for (const [canonicalUrl, record] of projection.byCanonicalUrl) {
    const workstreamId = record.currentAttribution?.workstreamId;
    if (workstreamId !== null && workstreamId !== undefined && workstreamId.length > 0) {
      continue; // filed — not part of the unfiled population
    }
    items.push({
      canonicalUrl,
      title: record.latestTitle ?? null,
      firstSeenAtMs: parseIso(record.firstSeenAt),
    });
  }
  return items;
};

export interface UnfiledEvidenceJoin {
  readonly conceptIdsForUrl?: (canonicalUrl: string) => readonly string[] | undefined;
  readonly keywordsForUrl?: (canonicalUrl: string) => readonly string[] | undefined;
  /** Optional — see module header. Omitted means every item's embedding is
   *  empty and hybridSimilarity runs on concept-Jaccard alone. */
  readonly embeddingForUrl?: (canonicalUrl: string) => Float32Array | undefined;
  /** §12 sentence vectors — same optional-join shape as splitEvidence.ts's
   *  matching field; see that module's doc comment. */
  readonly sentenceEmbeddingsForUrl?: (canonicalUrl: string) => readonly Float32Array[] | undefined;
}

/**
 * Most-recent-first, env-capped, joined with keyword-layer data — turns raw
 * unfiled evidence into SuggestionEvidenceItem[] ready for
 * `recomputeSuggestionCandidates({kind:'new-category', scopeId:
 * NEW_CATEGORY_SCOPE_ID, evidence})`. Pure with respect to `items` and the
 * join functions — no I/O of its own.
 */
export const suggestionEvidenceFromUnfiled = (
  items: readonly UnfiledEvidenceItem[],
  join: UnfiledEvidenceJoin = {},
  limit: number = resolveUnfiledPopulationCap(),
): readonly SuggestionEvidenceItem[] => {
  const sorted = [...items].sort((left, right) => right.firstSeenAtMs - left.firstSeenAtMs);
  const bounded = sorted.slice(0, Math.max(0, limit));
  return bounded.map((item) => {
    const conceptIds = join.conceptIdsForUrl?.(item.canonicalUrl);
    const keywords = join.keywordsForUrl?.(item.canonicalUrl);
    const embedding = join.embeddingForUrl?.(item.canonicalUrl) ?? new Float32Array(0);
    const sentenceEmbeddings = join.sentenceEmbeddingsForUrl?.(item.canonicalUrl);
    const evidenceItem: SuggestionEvidenceItem = {
      id: item.canonicalUrl,
      embedding,
      ...(item.title === null ? {} : { title: item.title }),
      ...(conceptIds === undefined ? {} : { conceptIds }),
      ...(keywords === undefined ? {} : { keywords }),
      ...(sentenceEmbeddings === undefined ? {} : { sentenceEmbeddings }),
    };
    return evidenceItem;
  });
};

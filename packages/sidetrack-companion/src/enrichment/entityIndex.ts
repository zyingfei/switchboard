// Entity index — the fold half of the entity layer
// (docs/audits/2026-07-29-recommendation-graph-feature-review.md §G4/§E3).
//
// WHAT IT IS. entityName → the pages and threads whose gist named it, joined
// to the workstreams those pages are filed under. That is the "conceptual
// layer" the review says the system already produces and then discards: the
// substrate for entity dossiers ("show me everything touching Kimi Delta
// Attention") and, later, a far better AI-lane query than prose.
//
// A PURE FOLD, NOT A NEW EVENT TYPE. The review sketched E3 as "additive
// event type"; this is deliberately NOT that, and the deviation is the whole
// design:
//   - The source of truth is the ALREADY-FOLDED gist lookup
//     (contentEnrichment.ts). Entities are a pure function of gist text
//     (entityExtract.ts), so persisting them would persist a derivation —
//     the thing this codebase's event-sourcing discipline exists to avoid.
//   - RETRACTIONS COME FREE. The gist fold already withdraws retracted gists;
//     folding downstream of it means a retracted gist's entities disappear
//     with no retraction logic of our own. A separate entity event would have
//     needed its own retraction path, and the two would have drifted the
//     first time someone purged a bad gist.
//   - RETROACTIVE + RE-PARSEABLE. Every gist already in the vault is covered
//     on first read, and improving the parser improves history. A persisted
//     entity event would have frozen v1's parsing mistakes into the log.
//   - No registry entry is needed precisely because no event type is added
//     (the sync-contract coverage test proves this by not changing).
//
// THE JOIN IS INJECTED. Workstream membership lives in the URL attribution
// projection, which this module must not reach for itself: keeping it pure
// keeps it testable without a vault, and keeps the expensive read (a
// metadata-only snapshot read) a decision the CALLER makes. Same shape the
// content lane uses for exactly the same reason (contentLane.ts
// `lookupWorkstreamByUrl`).
//
// COST. Memoized on the SAME signature the gist fold memoizes on, so a warm
// serve pays only the cheap logSignature() stats. The fold itself is
// O(#gists × entities-per-gist) over a corpus of gists that is sparse
// relative to the event log.

import type { EventLog } from '../sync/eventLog.js';

import {
  loadGistLookupWithSignature,
  parseGistLookupKey,
  type GistLookup,
} from './contentEnrichment.js';
import {
  entityKeyFor,
  extractEntities,
  type EntityKind,
} from './entityExtract.js';
import type { EntityTitleEnrichedKind } from './events.js';

// ---- flag -------------------------------------------------------------

export const ENTITY_INDEX_ENV = 'SIDETRACK_ENTITY_INDEX';

// Default ON — the whole layer is READ-ONLY derivation over data that already
// exists, so the house rule for read-only surfaces applies. '0'/'false'
// disables: the routes return typed empty and the fold is never built (no
// parse cost at all, not merely a hidden result). Read at each call site so a
// runtime flip takes effect on the next request.
export const entityIndexEnabled = (): boolean => {
  const raw = process.env[ENTITY_INDEX_ENV];
  return raw !== '0' && raw !== 'false';
};

// ---- hub damping ------------------------------------------------------
//
// THE REVIEW'S EXPLICIT REQUIREMENT: "apply an idf/hub analog so 'AI' the
// entity doesn't become a magnet." This is the same failure mode the graph
// already learned twice — the aggregator false-friend (a coarse multi-topic
// domain voting for its workstream by accident) and the lane hub guard. An
// entity that appears in a quarter of every gist in the vault is not a
// connection between two pages; it is the vault's subject matter. Surfacing
// it in a dossier list buries the entities that actually discriminate.
//
// TWO RULES, both needed:
//   - A FRACTION rule catches vault-wide vocabulary ("AI", "Python") whatever
//     the corpus size.
//   - An ABSOLUTE rule catches an entity that is a magnet in raw terms even
//     in a large vault, where 25% is an enormous number of refs.
//
// Hubs are EXCLUDED FROM LISTINGS, NOT DELETED. Exact-name lookup still
// returns them with `hub: true` — the user who explicitly asks for "AI" gets
// the honest answer, including that it is everywhere. Suppressing the listing
// is the precedented remedy (lane hub guard suppresses the VOTE, not the
// page).

// >25% of all gists. A quarter is where "shared context" stops being a
// coincidence worth showing: with 1,290 evidenced pages in the live vault, a
// name in a quarter of the gists is a topic label, not a link.
export const ENTITY_HUB_REF_FRACTION = 0.25;

// …or >30 refs outright. Chosen against dossier ergonomics rather than
// theory: past ~30 pages a dossier is a search-results page, and an entity
// that connects 30+ pages is describing the vault, not a thread through it.
export const ENTITY_HUB_MAX_REFS = 30;

// The fraction rule needs a corpus to be a fraction OF. On a 4-gist vault
// every second entity is "50% of gists" — that is a small sample, not a hub,
// and damping there would hide the only entities that exist. Below this
// floor, only the absolute rule applies.
export const ENTITY_HUB_MIN_GISTS = 8;

// Default listing cap. Bounds the response body; the listing is sorted by
// refCount so the cap truncates the long tail of one-mention entities.
export const ENTITY_LIST_MAX = 200;

// ---- shapes -----------------------------------------------------------

export interface EntityRef {
  // Which entity family the gist enriched — the same closed union the
  // enrichment events use ('url' → canonicalUrl, 'thread' → bac_id).
  readonly kind: EntityTitleEnrichedKind;
  readonly id: string;
  // The workstream this ref is filed under, when the injected lookup knows.
  // Absent means "not filed / no lookup supplied" — never "no workstream
  // exists"; the caller decides which of those it can say.
  readonly workstreamId?: string;
}

export interface EntityEntry {
  // Lowercased normalized name — the map key, repeated here so an entry
  // travels self-describing.
  readonly key: string;
  // First-seen original casing (see entityExtract normalizeEntityName).
  readonly display: string;
  // Every kind bucket any gist filed this entity under. Plural because two
  // gists can categorize the same name differently, and flattening that to
  // one bucket would be inventing agreement.
  readonly kinds: readonly EntityKind[];
  // One ref per (kind,id) — a gist that names an entity three times still
  // contributes one ref, so refCount counts DOCUMENTS not mentions.
  readonly refs: readonly EntityRef[];
  // Distinct workstreams across refs, in first-seen order.
  readonly workstreams: readonly string[];
  readonly hub: boolean;
}

export interface EntityIndex {
  readonly byKey: ReadonlyMap<string, EntityEntry>;
  // Denominator for the hub fraction: gists that carried a Key Entities
  // section AND named at least one entity. Gists with no section, or with an
  // honest "None explicitly mentioned", are excluded — counting them would
  // deflate every entity's ratio and quietly switch hub damping off.
  readonly gistCount: number;
  // Gists scanned in total (section or not). Reported so an operator can see
  // the coverage ratio rather than guessing why the index is small.
  readonly scannedCount: number;
  // Candidates the parser rejected (length bounds / per-gist cap), summed.
  // REPORT, NOT SILENT.
  readonly droppedCandidates: number;
  readonly hubCount: number;
}

export interface EntityIndexJoin {
  // Authoritative canonicalUrl → workstreamId lookup (the URL attribution
  // projection). Injected, never read here — see THE JOIN IS INJECTED above.
  readonly lookupWorkstreamByUrl?: (canonicalUrl: string) => string | undefined;
  // Same for threads. Optional and usually absent: there is no cheap
  // thread→workstream index off the request path (the URL projection is a
  // metadata-only read; the thread join would be O(#threads) file reads per
  // request), so v1 leaves thread refs unfiled rather than paying that on a
  // read route. The seam exists so wiring it later is a one-line change.
  readonly lookupWorkstreamByThread?: (threadId: string) => string | undefined;
}

// Exact-URL keyed lookups drift on trailing slashes between the projection
// and the enrichment id — the same urlSlashVariants discipline the content
// lane applies to its join (contentLane.ts `slashVariants`).
const slashVariants = (url: string): readonly string[] =>
  url.endsWith('/') ? [url, url.slice(0, -1)] : [url, `${url}/`];

const workstreamForRef = (
  kind: EntityTitleEnrichedKind,
  id: string,
  join: EntityIndexJoin,
): string | undefined => {
  if (kind === 'thread') return join.lookupWorkstreamByThread?.(id);
  for (const variant of slashVariants(id)) {
    const found = join.lookupWorkstreamByUrl?.(variant);
    if (found !== undefined) return found;
  }
  return undefined;
};

// Mutable twin of EntityEntry used while folding.
interface Accumulator {
  readonly key: string;
  display: string;
  readonly kinds: EntityKind[];
  readonly refs: EntityRef[];
  readonly workstreams: string[];
}

/**
 * Build the entity index from an already-folded gist lookup.
 *
 * PURE with respect to its inputs — no I/O, no clock, no globals. The gist
 * lookup is the retraction-aware fold, so anything withdrawn upstream is
 * simply absent here.
 */
export const buildEntityIndex = (
  gists: GistLookup,
  join: EntityIndexJoin = {},
): EntityIndex => {
  const accumulators = new Map<string, Accumulator>();
  let gistCount = 0;
  let scannedCount = 0;
  let droppedCandidates = 0;

  for (const [foldKey, entry] of gists) {
    scannedCount += 1;
    const parsed = parseGistLookupKey(foldKey);
    if (parsed === null) continue;
    const extracted = extractEntities(entry.gist);
    droppedCandidates += extracted.dropped;
    if (extracted.entities.length === 0) continue;
    gistCount += 1;
    const workstreamId = workstreamForRef(parsed.kind, parsed.id, join);
    const ref: EntityRef =
      workstreamId === undefined
        ? { kind: parsed.kind, id: parsed.id }
        : { kind: parsed.kind, id: parsed.id, workstreamId };
    for (const entity of extracted.entities) {
      const key = entityKeyFor(entity.name);
      if (key.length === 0) continue;
      let acc = accumulators.get(key);
      if (acc === undefined) {
        acc = { key, display: entity.name, kinds: [], refs: [], workstreams: [] };
        accumulators.set(key, acc);
      }
      if (entity.kind !== undefined && !acc.kinds.includes(entity.kind)) {
        acc.kinds.push(entity.kind);
      }
      // extractEntities already deduped within this gist, so one ref per
      // (entity, gist) falls out without a second membership check.
      acc.refs.push(ref);
      if (workstreamId !== undefined && !acc.workstreams.includes(workstreamId)) {
        acc.workstreams.push(workstreamId);
      }
    }
  }

  // Hub pass — needs the final gistCount, so it cannot fold inline.
  const fractionApplies = gistCount >= ENTITY_HUB_MIN_GISTS;
  const fractionLimit = gistCount * ENTITY_HUB_REF_FRACTION;
  const byKey = new Map<string, EntityEntry>();
  let hubCount = 0;
  for (const acc of accumulators.values()) {
    const hub =
      acc.refs.length > ENTITY_HUB_MAX_REFS ||
      (fractionApplies && acc.refs.length > fractionLimit);
    if (hub) hubCount += 1;
    byKey.set(acc.key, {
      key: acc.key,
      display: acc.display,
      kinds: acc.kinds,
      refs: acc.refs,
      workstreams: acc.workstreams,
      hub,
    });
  }

  return { byKey, gistCount, scannedCount, droppedCandidates, hubCount };
};

// ---- listing / lookup -------------------------------------------------

export interface EntityListItem {
  readonly name: string;
  readonly kinds: readonly EntityKind[];
  readonly refCount: number;
  readonly workstreams: readonly string[];
  readonly hub: boolean;
}

/**
 * The default listing: hubs EXCLUDED, sorted by refCount desc, capped.
 *
 * Ties break on the lowercased key ascending so the order is TOTAL and stable
 * — an unstable listing would make the route's ETag flap and every
 * screenshot-based bug report unreproducible.
 */
export const listEntities = (
  index: EntityIndex,
  limit: number = ENTITY_LIST_MAX,
): readonly EntityListItem[] => {
  const items: EntityListItem[] = [];
  for (const entry of index.byKey.values()) {
    if (entry.hub) continue;
    items.push({
      name: entry.display,
      kinds: entry.kinds,
      refCount: entry.refs.length,
      workstreams: entry.workstreams,
      hub: entry.hub,
    });
  }
  items.sort((a, b) =>
    b.refCount === a.refCount
      ? a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      : b.refCount - a.refCount,
  );
  return items.slice(0, Math.max(0, limit));
};

/**
 * Exact-name lookup, case-insensitive. Hubs ARE returned here: an entity the
 * caller named explicitly is never hidden from them — the `hub` flag tells
 * them why it is not in the listing.
 */
export const lookupEntity = (index: EntityIndex, name: string): EntityEntry | undefined =>
  index.byKey.get(entityKeyFor(name));

// ---- memoized loader --------------------------------------------------

interface MemoizedIndex {
  readonly vaultRoot: string;
  readonly signature: string;
  readonly index: EntityIndex;
}

let memoized: MemoizedIndex | null = null;

export interface LoadedEntityIndex {
  // null ⇒ the flag is off, or there is no event log / no gist fold to derive
  // from. Typed absence, distinct from an index that folded to zero entities.
  readonly index: EntityIndex | null;
  // 'off' (flag), else the gist fold's own signature — same cache-busting
  // token, so the two derivations can never disagree about which log state
  // they describe.
  readonly signature: string;
}

/**
 * Resolve the entity index for a vault, memoized on the SAME event-log
 * content signature the gist fold uses. A warm call pays one logSignature()
 * stat and nothing else.
 *
 * The workstream JOIN is folded in at build time, so it is memoized too. That
 * is correct in practice because a filing APPENDS an event, which flips the
 * log signature and rebuilds this index on the next call — the join can never
 * be staler than the log it was built against.
 *
 * The memo key carries whether a join was AVAILABLE, though, because that is
 * NOT a function of the log: right after boot the connections snapshot may
 * not be readable yet, and without this bit the first (join-less) index would
 * stay pinned until the next write — every ref reported unfiled while the
 * projection sat there ready. That is precisely the class of "cached the
 * empty answer" bug this repo has paid for repeatedly.
 */
export const loadEntityIndex = async (
  vaultRoot: string,
  eventLog: EventLog | undefined,
  join: EntityIndexJoin = {},
): Promise<LoadedEntityIndex> => {
  // Flag OFF means the fold is never built — not built-and-hidden. Checked
  // before touching the gist lookup so a disabled index costs nothing.
  if (!entityIndexEnabled()) return { index: null, signature: 'off' };
  const { lookup, signature } = await loadGistLookupWithSignature(vaultRoot, eventLog);
  if (lookup === null) return { index: null, signature };
  const joinBits = `${join.lookupWorkstreamByUrl === undefined ? '0' : '1'}${
    join.lookupWorkstreamByThread === undefined ? '0' : '1'
  }`;
  const memoKey = `${signature}|join:${joinBits}`;
  if (memoized !== null && memoized.vaultRoot === vaultRoot && memoized.signature === memoKey) {
    return { index: memoized.index, signature };
  }
  const index = buildEntityIndex(lookup, join);
  memoized = { vaultRoot, signature: memoKey, index };
  return { index, signature };
};

export const resetEntityIndexMemoForTest = (): void => {
  memoized = null;
};

// Decline memory — "Not in any stream" is an answer, and it must stick.
//
// THE LIVE BUG (2026-07-27/29, review §G5/E6). The resolver ALREADY detects a
// declined URL: resolveUrlAttribution's `urlUserDeclinedNoWorkstream` settles
// the decision with gate `no-candidates` / detail `user declined — not in any
// stream`. Then applyLaneFallbackGuess — whose ONLY trigger is
// `fusedCandidates.length === 0 && gate.reason === 'no-candidates'` — saw that
// exact settle, found the content + ai lanes populated, and synthesized a
// pick. The system re-suggested a workstream on a page whose own gate detail
// said the user had just refused one. Negative labels are the cheapest,
// highest-precision signal a personal organizer gets, and this one was being
// read as an invitation.
//
// WHY A MODULE AND NOT A STRING CHECK. Two reasons, both structural:
//
//   1. The gate detail is free text. Pattern-matching `user declined` at the
//      fallback site would couple two modules through a human-facing string
//      that the same review is about to make richer.
//   2. The decline settle lives ONLY on the incumbent graph arm. The DEFAULT
//      serving arm is vote3/vote4 (attribution-v1/serve.ts, selected by
//      SIDETRACK_ATTRIBUTION_ARM) and it never runs urlUserDeclinedNoWorkstream
//      at all — it votes from the drain-time AttributionV1State, which has no
//      decline channel. So on the default arm a declined URL gets a fresh
//      suggestion on every resolve, and there is no gate detail to match. A
//      folded lookup consulted at the SERVE seam covers both arms.
//
// WHAT A DECLINE ACTUALLY IS (read from the code, not from the brief). The
// task that commissioned this module said declines append USER_FLOW_REJECTED.
// They do not. USER_FLOW_REJECTED (feedback/events.ts) carries
// `{relationKind: 'closest_visit'|'visit_resembles_visit'|'visit_continues_visit',
// fromId, toId, reason?}` — it rejects a RELATION BETWEEN TWO VISITS ("these
// two pages don't belong together"), which is a different assertion and is
// already consumed as a negative PPR seed by urlNegativeSeeds. The
// "not in any stream" decline is:
//
//     USER_ORGANIZED_ITEM {
//       itemKind: 'canonical-url',
//       itemId:   <the canonical URL>,
//       action:   'move',
//       toContainer: null,          // ← the decline
//     }
//
// i.e. the SAME event a filing appends, with a null destination. This module
// folds exactly that, with exactly the semantics resolver.ts already uses.
//
// LATEST-WINS, NOT AN APPEND-ONLY SET. Copied verbatim in spirit from
// resolver.ts `urlUserDeclinedNoWorkstream`: take the LATEST 'move' event for
// the URL (acceptedAtMs, then dot.seq as the tie-break) and let its
// toContainer decide. A user who declines a page on Monday and files it on
// Tuesday has UN-declined it; a set that only ever grows would suppress
// suggestions for a page the user has since organized. Divergence from the
// resolver on this point would be a two-source-of-truth bug, so the tie-break
// is identical.
//
// COST DISCIPLINE. Typed store read (events_type_idx over USER_ORGANIZED_ITEM
// only) + memo on the event-log content signature — the same shape as
// enrichment/contentEnrichment.ts loadGistLookupWithSignature. A warm serve
// pays one logSignature() stat. Organized-item events are the sparsest family
// in the log (thousands, against hundreds of thousands of engagement events).

import { USER_ORGANIZED_ITEM, isUserOrganizedItemPayload } from '../feedback/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { EventLog } from '../sync/eventLog.js';
import { eventStoreCoverageToken, getSharedEventStoreServeStale } from '../sync/eventStore.js';
import {
  isSuggestionAcceptedPayload,
  isSuggestionDeclinedPayload,
  SUGGESTION_ACCEPTED,
  SUGGESTION_DECLINED,
} from '../workstreams/suggestionEvents.js';

// ---- env flag ---------------------------------------------------------

export const DECLINE_MEMORY_ENV = 'SIDETRACK_DECLINE_MEMORY';

// Default ON. This flag SUPPRESSES suggestions; it never creates one. The
// repo's observe-first rule ("serving-behavior changes default OFF") exists to
// stop a new signal from silently filing things — a check that can only ever
// withhold a guess the user already refused fails in the safe direction, and
// leaving it off by default would mean shipping the known bug. Only an
// explicit '0' / 'false' disables (same parse as SIDETRACK_GUESS_LANES).
export const declineMemoryEnabled = (): boolean => {
  const raw = process.env[DECLINE_MEMORY_ENV];
  return raw !== '0' && raw !== 'false';
};

// ---- the folded lookup -------------------------------------------------

export interface DeclineLookup {
  /** Canonical URLs whose LATEST organize-move was a decline (toContainer null). */
  readonly declinedUrls: ReadonlySet<string>;
  // Phase 1 multi-membership (docs/plans/2026-08-16-category-flexibility-
  // hyde.md §5) — E6 built at the granularity the feature review actually
  // asked for: "declined workstream A, still open to B" is a DIFFERENT
  // assertion than "not in any stream" (declinedUrls above), and the two
  // are consulted separately by `isWorkstreamDeclined`. Keyed by subjectId
  // (canonical URL, thread bac_id, or tab-session id — same subject space
  // as `workstreams/membershipEvents.ts`), folded from SUGGESTION_ACCEPTED
  // / SUGGESTION_DECLINED with the accept clearing a prior decline for that
  // exact pair (a user who declines Monday and accepts Tuesday has
  // un-declined it — same "latest wins, not an append-only set" principle
  // as declinedUrls itself).
  readonly declinedWorkstreamsByUrl: ReadonlyMap<string, ReadonlySet<string>>;
}

export const EMPTY_DECLINE_LOOKUP: DeclineLookup = {
  declinedUrls: new Set<string>(),
  declinedWorkstreamsByUrl: new Map<string, ReadonlySet<string>>(),
};

// Exact-URL keyed lookups drift on trailing slashes across stores (projection
// vs recall-store vs event-payload key shapes) — try both spellings, the same
// urlSlashVariants discipline contentLane.ts and the panel use.
const slashVariants = (url: string): readonly string[] =>
  url.endsWith('/') ? [url, url.slice(0, -1)] : [url, `${url}/`];

/**
 * True when the user's latest decision for this URL was "not in any stream".
 *
 * Returns false — never throws, never guesses — when the flag is off or the
 * lookup is absent (no event log, fold failed). A missing lookup must read as
 * "no known decline", so an unavailable fold can only ever restore the prior
 * behavior, not invent a suppression.
 */
export const isUrlDeclined = (
  lookup: DeclineLookup | null | undefined,
  canonicalUrl: string,
): boolean => {
  if (!declineMemoryEnabled()) return false;
  if (lookup === null || lookup === undefined) return false;
  for (const variant of slashVariants(canonicalUrl)) {
    if (lookup.declinedUrls.has(variant)) return true;
  }
  return false;
};

/**
 * True when `workstreamId` specifically was declined for `subjectId` — OR
 * the subject carries a global "not in any stream" decline (which subsumes
 * every per-workstream case). Declining workstream C leaves suggestions for
 * A/B unaffected: this is the (subject, workstream) pair check the feature
 * review's E6 asked for, layered on top of the existing global one so every
 * consulting site (split-suggestion surfacer today; the prototype lane and
 * `laneFallback.ts` per the design) gets both checks from one call.
 *
 * Same safe-default contract as `isUrlDeclined`: false when the flag is off
 * or the lookup is unavailable.
 */
export const isWorkstreamDeclined = (
  lookup: DeclineLookup | null | undefined,
  subjectId: string,
  workstreamId: string,
): boolean => {
  if (!declineMemoryEnabled()) return false;
  if (lookup === null || lookup === undefined) return false;
  if (isUrlDeclined(lookup, subjectId)) return true;
  for (const variant of slashVariants(subjectId)) {
    if (lookup.declinedWorkstreamsByUrl.get(variant)?.has(workstreamId) === true) return true;
  }
  return false;
};

// Per-URL latest-wins accumulator. `at`/`seq` reproduce resolver.ts's
// comparison exactly (acceptedAtMs first, dot.seq as the deterministic
// tie-break for events accepted in the same millisecond).
interface LatestMove {
  readonly at: number;
  readonly seq: number;
  readonly declined: boolean;
}

/**
 * Fold USER_ORGANIZED_ITEM events into the per-canonicalUrl decline set.
 *
 * Only `itemKind === 'canonical-url'` + `action === 'move'` events participate
 * — the same supervised-decision definition resolver.ts uses. 'promote',
 * 'ignore', 'merge' &c. are different assertions and must not be read as
 * declines; in particular 'ignore' means "hide this item", which the inbox
 * already honors and which is NOT a statement about workstream membership.
 */
export const foldDeclineMemory = (events: readonly AcceptedEvent[]): DeclineLookup => {
  const latest = new Map<string, LatestMove>();
  for (const event of events) {
    if (event.type !== USER_ORGANIZED_ITEM || !isUserOrganizedItemPayload(event.payload)) continue;
    const payload = event.payload;
    if (payload.itemKind !== 'canonical-url' || payload.action !== 'move') continue;
    const candidate: LatestMove = {
      at: event.acceptedAtMs,
      seq: event.dot.seq,
      declined: payload.toContainer === null,
    };
    const incumbent = latest.get(payload.itemId);
    if (
      incumbent === undefined ||
      candidate.at > incumbent.at ||
      (candidate.at === incumbent.at && candidate.seq > incumbent.seq)
    ) {
      latest.set(payload.itemId, candidate);
    }
  }
  const declinedUrls = new Set<string>();
  for (const [canonicalUrl, move] of latest) {
    if (move.declined) declinedUrls.add(canonicalUrl);
  }
  return { declinedUrls, declinedWorkstreamsByUrl: foldWorkstreamDeclines(events) };
};

// Per-(subjectId, workstreamId) pair latest-wins, folded from
// SUGGESTION_ACCEPTED/DECLINED. Accept and decline share one accumulator so
// a later accept clears an earlier decline for the exact same pair — same
// tie-break as the global fold above (acceptedAtMs, then dot.seq).
const foldWorkstreamDeclines = (
  events: readonly AcceptedEvent[],
): ReadonlyMap<string, ReadonlySet<string>> => {
  const latest = new Map<string, LatestMove & { readonly workstreamId: string }>();
  for (const event of events) {
    let subjectId: string;
    let workstreamId: string;
    let declined: boolean;
    if (event.type === SUGGESTION_DECLINED && isSuggestionDeclinedPayload(event.payload)) {
      subjectId = event.payload.subjectId;
      workstreamId = event.payload.workstreamId;
      declined = true;
    } else if (event.type === SUGGESTION_ACCEPTED && isSuggestionAcceptedPayload(event.payload)) {
      subjectId = event.payload.subjectId;
      workstreamId = event.payload.workstreamId;
      declined = false;
    } else {
      continue;
    }
    const key = `${subjectId} ${workstreamId}`;
    const candidate = { at: event.acceptedAtMs, seq: event.dot.seq, declined, workstreamId };
    const incumbent = latest.get(key);
    if (
      incumbent === undefined ||
      candidate.at > incumbent.at ||
      (candidate.at === incumbent.at && candidate.seq > incumbent.seq)
    ) {
      latest.set(key, candidate);
    }
  }
  const byUrl = new Map<string, Set<string>>();
  for (const [key, move] of latest) {
    if (!move.declined) continue;
    const subjectId = key.slice(0, key.length - move.workstreamId.length - 1);
    const set = byUrl.get(subjectId) ?? new Set<string>();
    set.add(move.workstreamId);
    byUrl.set(subjectId, set);
  }
  return byUrl;
};

// ---- typed store read (fold source) -----------------------------------

const emptyEvents: readonly AcceptedEvent[] = [];

const DECLINE_FOLD_TYPES = [USER_ORGANIZED_ITEM, SUGGESTION_ACCEPTED, SUGGESTION_DECLINED] as const;

// Typed read via events_type_idx. The untyped forEachChunk full-scan is the
// 45s-timeout shape this repo has fixed five times (see the event-scan
// type-hint sweep); a decline fold that scanned 450k events per serve would
// re-introduce it for a set of a few thousand rows.
const readOrganizedItemEvents = async (
  vaultRoot: string,
  eventLog: EventLog,
): Promise<readonly AcceptedEvent[]> => {
  // Serve-stale: no serving fold may await a JSONL catch-up pass (measured
  // 30-70s post-boot). The store is read as-is; the kicked background pass
  // freshens it for later reads.
  const store = await getSharedEventStoreServeStale(vaultRoot);
  const foldTypes: ReadonlySet<string> = new Set(DECLINE_FOLD_TYPES);
  if (store === null) {
    return (await eventLog.readMerged()).filter((event) => foldTypes.has(event.type));
  }
  const events: AcceptedEvent[] = [];
  await store.forEachChunkOfTypes(
    [...DECLINE_FOLD_TYPES],
    (chunk) => {
      for (const event of chunk) events.push(event);
    },
    2000,
  );
  return events;
};

// ---- memoized loader --------------------------------------------------

interface MemoizedDeclines {
  readonly vaultRoot: string;
  readonly signature: string;
  readonly lookup: DeclineLookup;
}

let memoized: MemoizedDeclines | null = null;

export interface LoadedDeclineLookup {
  readonly lookup: DeclineLookup | null;
  // Cache-busting token, mirroring loadGistLookupWithSignature: 'off' when the
  // flag is disabled, 'none' when there is no event log, else the log signature.
  readonly signature: string;
}

/**
 * Resolve the decline lookup for a vault, memoized on the event-log content
 * signature. Null when the flag is off or the event log is unavailable — both
 * of which `isUrlDeclined` reads as "no known decline".
 */
export const loadDeclineMemoryWithSignature = async (
  vaultRoot: string,
  eventLog: EventLog | undefined,
): Promise<LoadedDeclineLookup> => {
  if (!declineMemoryEnabled()) return { lookup: null, signature: 'off' };
  if (eventLog === undefined) return { lookup: null, signature: 'none' };
  const signature = await eventLog.logSignature();
  if (memoized !== null && memoized.vaultRoot === vaultRoot && memoized.signature === signature) {
    return { lookup: memoized.lookup, signature };
  }
  const events = await readOrganizedItemEvents(vaultRoot, eventLog).catch(() => emptyEvents);
  const lookup = foldDeclineMemory(events);
  memoized = { vaultRoot, signature, lookup };
  return { lookup, signature };
};

/**
 * Hot-path variant for callers that ALREADY hold the merged log (the batch-
 * resolve fallback convoy). Folds straight from the provided events — no extra
 * read — and memoizes on the caller-supplied signature.
 *
 * The caller MUST pass an events array that includes USER_ORGANIZED_ITEM; a
 * filtered array missing them folds to an empty (permissive) set, which is the
 * safe direction but silently restores the bug, so callers are the place this
 * contract is checked.
 */
export const declineMemoryFromMerged = (
  vaultRoot: string,
  signature: string,
  events: readonly AcceptedEvent[],
): DeclineLookup | null => {
  if (!declineMemoryEnabled()) return null;
  if (memoized !== null && memoized.vaultRoot === vaultRoot && memoized.signature === signature) {
    return memoized.lookup;
  }
  const lookup = foldDeclineMemory(events);
  memoized = { vaultRoot, signature, lookup };
  return lookup;
};

export const resetDeclineMemoryMemoForTest = (): void => {
  memoized = null;
};

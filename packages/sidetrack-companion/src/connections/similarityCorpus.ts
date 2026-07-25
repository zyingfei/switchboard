// Path-independent similarity eligible-corpus assembly (W1 — window-poverty
// fix). The similarity lane's eligible corpus historically came from the
// drain's event WINDOW (buildTimelineDays over `merged`), so a warm
// delta-only drain assembled 0…thousands of visits depending on which drain
// path ran — the root of the visitSimilarity flapping, the corpus-config
// migration wipes, and the Pass-7 endpoint-drop cascade (see
// docs/DEBUGGING_DOCTRINE.md "window-poor corpus assembly").
//
// Option (b): assemble the corpus from the event store's typed indexes
// (events_type_idx over the five corpus-source types) on EVERY drain,
// regardless of window. Measured ~309ms warm on the 741k-event / ~9k-visit
// live store (88x cheaper than the ~14.3s full-log walk it replaces on the
// paths that do walk), because the typed read skips the ~92%
// engagement.interval rows. This makes the eligible corpus path-independent
// (doctrine rule 6: an unloaded lane must never flow downstream as an empty
// corpus).
//
// Byte-equivalence: buildTimelineDays + buildEngagementClassifierInputs
// consume ONLY the CORPUS_SOURCE_TYPES event types — every other type is
// ignored by both builders — so a typed read over exactly those types, sorted
// into merged order, is byte-equivalent to filtering readMerged() to them.
// This is the SAME seam readRequalifyEngagementSource already relies on (its
// comment block proves the equivalence); this module un-gates it so the full
// corpus feeds the MAIN similarity lane, not just the requalify splice.
//
// Ports-and-adapters: this module is a thin infrastructure adapter. It takes
// the typed event source (a port) plus the already-bound projection builders
// as injected dependencies — it holds no materializer state and does no I/O
// beyond the injected typed read. When the event store is unavailable
// (SIDETRACK_EVENT_STORE off — the default in non-test runtimes) it falls
// back to the caller-supplied window events, leaving legacy behavior
// byte-unchanged (W5).

import { createHash } from 'node:crypto';

import { ENGAGEMENT_SESSION_AGGREGATED } from '../engagement/events.js';
import { NAVIGATION_COMMITTED } from '../navigation/events.js';
import { SELECTION_COPIED, SELECTION_PASTED } from '../snippets/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { sortAcceptedEvents } from '../sync/causal.js';
import type { EventStore } from '../sync/eventStore.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import type {
  TimelineDayProjectionWithDimensions,
  TimelineEntryWithDimensions,
} from '../timeline/timelineDays.js';
import type { EngagementClassifierInput } from './engagementClassifier.js';

// The exact event types buildTimelineDays + buildEngagementClassifierInputs
// consume. Kept as the single source of truth shared with the requalify
// splice (REQUALIFY_ENGAGEMENT_SOURCE_TYPES aliases this) so a future 6th
// consumed type updates both readers together — the byte-equivalence
// argument above holds only while this list is exhaustive. See the
// SIDETRACK_SIMILARITY_CORPUS_VERIFY drift check in the materializer.
export const CORPUS_SOURCE_TYPES: readonly string[] = [
  BROWSER_TIMELINE_OBSERVED,
  NAVIGATION_COMMITTED,
  ENGAGEMENT_SESSION_AGGREGATED,
  SELECTION_COPIED,
  SELECTION_PASTED,
];

// Injected projection builders. These are the materializer's own closures
// (buildTimelineDays over the timeline events, buildEngagementClassifierInputs
// over the engagement events, and enrichTimelineDaysWithEngagement folding the
// engagement focus back onto the timeline entries). Passing them in keeps this
// module free of the materializer's private projection wiring.
export interface SimilarityCorpusBuilders {
  readonly buildTimelineDays: (
    events: readonly AcceptedEvent[],
  ) => readonly TimelineDayProjectionWithDimensions[];
  readonly buildEngagementClassifierInputs: (
    events: readonly AcceptedEvent[],
    timelineDays: readonly TimelineDayProjectionWithDimensions[],
  ) => readonly EngagementClassifierInput[];
  readonly enrichTimelineDaysWithEngagement: (
    days: readonly TimelineDayProjectionWithDimensions[],
    engagementInputs: readonly EngagementClassifierInput[],
  ) => readonly TimelineDayProjectionWithDimensions[];
}

export interface EligibleSimilarityCorpus {
  // The full eligible-corpus entries (enriched with engagement focus), the
  // same shape windowSimilarityEntries carried — the caller filters these by
  // the engagement gate exactly as before.
  readonly entries: readonly TimelineEntryWithDimensions[];
  // The enriched timeline DAYS the entries were flattened from — the full
  // corpus's timeline projection. The full-snapshot build (Pass 1 timeline
  // nodes + Pass 7 similarity endpoint completion) consumes this as
  // `input.timelineDays` so `visitObservedAtByKey` covers every corpus visit's
  // node, and Pass 7 stops dropping similarity edges whose endpoint
  // timeline-visit node was out of the drain window (W2 part 1). `entries`
  // === `enrichedDays.flatMap(day => day.entries)` by construction.
  readonly enrichedDays: readonly TimelineDayProjectionWithDimensions[];
  // A stable signature over the corpus visit keys + focus. Advances only when
  // the corpus itself changes (a new eligible visit, or an engagement shift),
  // NOT on every drain — so it is a benign-fluctuation-resistant key for the
  // SWR graph signature (W2) and a drift probe for W3.
  readonly corpusSignature: string;
  // True when the corpus was assembled from the typed store (path-independent
  // full corpus). False when it fell back to the caller's window events
  // (event store unavailable) — the legacy byte-unchanged path.
  readonly assembledFromTypedStore: boolean;
  // Count of corpus-source events read (diagnostics only).
  readonly sourceEventCount: number;
}

const visitKeyForEntry = (entry: TimelineEntryWithDimensions): string => {
  const raw = entry.canonicalUrl ?? entry.url;
  // Match visitKeyForVisitEntry's canonicalization (fragment + trailing slash
  // stripped) so the signature is stable across fragment-only re-observations.
  return raw.replace(/#.*$/u, '').replace(/\/$/u, '');
};

const focusedWindowMsForEntry = (entry: TimelineEntryWithDimensions): number => {
  const dimensions = entry.dimensions;
  if (typeof dimensions !== 'object' || dimensions === null) return 0;
  const engagement = (dimensions as Record<string, unknown>)['engagement'];
  if (typeof engagement !== 'object' || engagement === null) return 0;
  const focused = (engagement as Record<string, unknown>)['focusedWindowMs'];
  return typeof focused === 'number' && Number.isFinite(focused) && focused > 0 ? focused : 0;
};

// Deterministic signature over the corpus entries: sorted (visitKey,
// focusedWindowMs) pairs. Sorting makes it order-independent so a re-ordered
// but content-identical corpus produces the same signature (no benign
// rotation). Length-prefixed fields avoid delimiter-collision aliasing.
const computeCorpusSignature = (
  entries: readonly TimelineEntryWithDimensions[],
): string => {
  const pairs = new Map<string, number>();
  for (const entry of entries) {
    const key = visitKeyForEntry(entry);
    const focused = focusedWindowMsForEntry(entry);
    // Keep the max focus per key (an entry can appear once per day).
    pairs.set(key, Math.max(pairs.get(key) ?? 0, focused));
  }
  const hasher = createHash('sha256');
  for (const key of [...pairs.keys()].sort()) {
    hasher.update(String(key.length));
    hasher.update(':');
    hasher.update(key);
    hasher.update('=');
    hasher.update(String(pairs.get(key) ?? 0));
    hasher.update('|');
  }
  return `corpus:${String(pairs.size)}:${hasher.digest('hex').slice(0, 16)}`;
};

// Read exactly the corpus-source types from the typed store, sorted into
// merged order (so the builders' order-dependent folds — navigation
// last-write-wins, aggregate selection — match a whole-log walk).
//
// Store-freshness contract: the assembled corpus is only as complete as the
// typed store. The materializer keeps the store current before assembling —
// the normal store-backed drain runs catchUpFromJsonl inline, and the chunked
// boot catch-up path (which bypasses that inline catch-up via the forced
// event window) runs a single catchUpFromJsonl before its chunk loop begins
// (connectionsMaterializer.ts catchUpInScopedChunks). So the corpus mirrors
// the full log on every path; if a store were ever behind, the
// eligibleCorpusIncompleteVsStore reset-defer guard is the defense-in-depth
// backstop that keeps the served signal from collapsing on a partial read.
const readCorpusSourceEvents = async (
  typedEventSource: EventStore,
): Promise<readonly AcceptedEvent[]> => {
  const collected: AcceptedEvent[] = [];
  await typedEventSource.forEachChunkOfTypes(
    CORPUS_SOURCE_TYPES,
    (chunk) => {
      for (const event of chunk) collected.push(event);
    },
    2000,
  );
  return sortAcceptedEvents(collected);
};

// Assemble the eligible similarity corpus, path-independently. When the typed
// store is present, read the full corpus from events_type_idx and build the
// full timeline + engagement + enrichment. When it is null (event store off),
// fall back to the caller's window events — byte-identical to the legacy
// window path (W5).
export const buildEligibleSimilarityCorpus = async (input: {
  readonly typedEventSource: EventStore | null;
  readonly fallbackMerged: readonly AcceptedEvent[];
  readonly builders: SimilarityCorpusBuilders;
}): Promise<EligibleSimilarityCorpus> => {
  const typedEventSource = input.typedEventSource;
  const assembledFromTypedStore = typedEventSource !== null;
  const sourceEvents =
    typedEventSource !== null
      ? await readCorpusSourceEvents(typedEventSource)
      : input.fallbackMerged;
  const rawTimelineDays = input.builders.buildTimelineDays(sourceEvents);
  const engagementInputs = input.builders.buildEngagementClassifierInputs(
    sourceEvents,
    rawTimelineDays,
  );
  const enrichedDays = input.builders.enrichTimelineDaysWithEngagement(
    rawTimelineDays,
    engagementInputs,
  );
  const entries = enrichedDays.flatMap((day) => day.entries);
  return {
    entries,
    enrichedDays,
    corpusSignature: computeCorpusSignature(entries),
    assembledFromTypedStore,
    sourceEventCount: sourceEvents.length,
  };
};

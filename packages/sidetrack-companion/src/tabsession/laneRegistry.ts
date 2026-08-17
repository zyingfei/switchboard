// Lane registry — the SINGLE SOURCE OF TRUTH for guess-lane identity, order,
// and labels. Task #29 (validated review finding): adding guess-lane 9
// ('prototype', PR #377) required FOUR manual hand-edits across two packages
// (this file's old hand-written GuessLane union, the extension's VALID_LANES
// parse whitelist, and its OPTIONAL_LANE_ORDER + LANE_SHORT_LABEL /
// LANE_LABEL maps) with ZERO compile-time or test-time guarantee tying them
// together. The lane shipped server-side and was silently dropped TWICE — once
// by the parse allowlist, once by the render order — before anyone noticed.
//
// THE FIX. One canonical data object per package (this file on the companion,
// packages/sidetrack-extension/src/sidepanel/tabsession/laneRegistry.ts on the
// extension — there is no build-shared package between the two bundles, so
// each package keeps its own copy) plus a generated JSON mirror
// (docs/contracts/lanes.json) that BOTH packages' test suites assert
// deep-equality against (see laneRegistry.test.ts here and the extension's
// tests/unit/laneRegistry.test.ts). Everything derivable — the GuessLane
// union, the fixed synchronous-lane order (GUESS_LANE_ORDER), labels, the
// parse allowlist — is DERIVED from this object, never hand-listed again. A
// lane added here without a matching mirror entry fails BOTH suites; a lane
// added to the wire without a registry entry fails the extension's all-lanes
// render contract test (see tests/unit/laneRenderContract.test.tsx).
//
// `order` is the FIXED wire/render position (1-indexed, matches the historical
// lane-N numbering used throughout this codebase's comments). `alwaysVisible`
// distinguishes the six synchronous, I/O-free lanes computed inside
// buildGuessLanes (graph/similarity/topic/title/domain/recency — GUESS_LANE_
// ORDER derives from these) from the three optional lanes computed OUTSIDE it
// (content/ai/prototype — async, appended by their own modules only when
// available). `behavior` records whether the lane's opinion can influence the
// fused decision ('decision': the six structural/vote lanes, plus content/ai
// which laneCorroboration.ts / laneFallback.ts deliberately read) or is
// disclosure-only ('observe': prototype — see prototypeLane.ts's header).
// `behavior` is NOT what LANE_CORROBORATION_LANES / FALLBACK_LANES derive
// from: those two stay a deliberately narrow, hand-scoped subset (their own
// comments explain why — this registry does not widen that decision).

export type LaneBehavior = 'decision' | 'observe';

export interface LaneDefinition {
  // Fixed 1-indexed position in wire/render order.
  readonly order: number;
  // Compact label for the pipeline-strip dots row (narrow side panel).
  readonly shortLabel: string;
  // Full label for the guess-lanes disclosure list.
  readonly longLabel: string;
  // Whether this lane's opinion can affect the fused decision ('decision')
  // or is surfaced purely for visibility ('observe').
  readonly behavior: LaneBehavior;
  // True for the six lanes buildGuessLanes always computes synchronously;
  // false for the optional lanes appended after the fact by their own
  // modules (contentLane.ts / prototypeLane.ts), present only when that
  // lane actually ran.
  readonly alwaysVisible: boolean;
}

// THE canonical lane table. Keep in exact sync with the extension's mirror
// copy (packages/sidetrack-extension/src/sidepanel/tabsession/laneRegistry.ts)
// and docs/contracts/lanes.json — laneRegistry.test.ts enforces this.
export const ATTRIBUTION_LANES = {
  graph: {
    order: 1,
    shortLabel: 'Graph',
    longLabel: 'Graph',
    behavior: 'decision',
    alwaysVisible: true,
  },
  similarity: {
    order: 2,
    shortLabel: 'Similar',
    longLabel: 'Similar pages',
    behavior: 'decision',
    alwaysVisible: true,
  },
  topic: {
    order: 3,
    shortLabel: 'Topic',
    longLabel: 'Topic',
    behavior: 'decision',
    alwaysVisible: true,
  },
  title: {
    order: 4,
    shortLabel: 'Title',
    longLabel: 'Title match',
    behavior: 'decision',
    alwaysVisible: true,
  },
  domain: {
    order: 5,
    shortLabel: 'Domain',
    longLabel: 'Domain history',
    behavior: 'decision',
    alwaysVisible: true,
  },
  recency: {
    order: 6,
    shortLabel: 'Recent',
    longLabel: 'Recently active',
    behavior: 'decision',
    alwaysVisible: true,
  },
  content: {
    order: 7,
    shortLabel: 'Content',
    longLabel: 'Content match',
    behavior: 'decision',
    alwaysVisible: false,
  },
  ai: {
    order: 8,
    shortLabel: 'AI',
    longLabel: 'AI gist match',
    behavior: 'decision',
    alwaysVisible: false,
  },
  prototype: {
    order: 9,
    shortLabel: 'Prototype',
    longLabel: 'Prototype match',
    behavior: 'observe',
    alwaysVisible: false,
  },
} as const satisfies Record<string, LaneDefinition>;

// The wire lane-id union — DERIVED from the registry keys, never hand-listed.
export type GuessLane = keyof typeof ATTRIBUTION_LANES;

// All registered lane ids, in registry-declaration order (NOT necessarily
// `order`-sorted — callers that need render order use `laneIdsInOrder`).
export const ALL_LANE_IDS: readonly GuessLane[] = Object.keys(
  ATTRIBUTION_LANES,
) as GuessLane[];

// Lane ids sorted by `order`, optionally filtered by `alwaysVisible`. Used to
// derive GUESS_LANE_ORDER (companion) and BASE_LANE_ORDER / OPTIONAL_LANE_
// ORDER (extension) — the single sort-and-filter both packages apply to the
// same underlying data.
export const laneIdsInOrder = (
  filter?: (definition: LaneDefinition) => boolean,
): readonly GuessLane[] =>
  ALL_LANE_IDS.filter((laneId) => filter === undefined || filter(ATTRIBUTION_LANES[laneId])).sort(
    (a, b) => ATTRIBUTION_LANES[a].order - ATTRIBUTION_LANES[b].order,
  );

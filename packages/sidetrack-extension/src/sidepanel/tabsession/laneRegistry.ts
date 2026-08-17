// Lane registry — the SINGLE SOURCE OF TRUTH for guess-lane identity, order,
// and labels, MIRRORED byte-for-byte from the companion's copy
// (packages/sidetrack-companion/src/tabsession/laneRegistry.ts). Task #29
// (validated review finding): adding guess-lane 9 required FOUR manual
// hand-edits across the two packages (this file's old hand-written GuessLane
// union in types.ts, the VALID_LANES parse whitelist, and PipelineStrip.tsx's
// OPTIONAL_LANE_ORDER + LANE_SHORT_LABEL, plus GuessLanes.tsx's LANE_LABEL)
// with ZERO compile-time or test-time guarantee tying them together. The lane
// shipped server-side and was silently dropped TWICE — once by the parse
// allowlist, once by the render order — before anyone noticed.
//
// THE FIX. This object is now the extension's single source: GuessLane
// (types.ts), VALID_LANES (types.ts parse whitelist), BASE_LANE_ORDER /
// OPTIONAL_LANE_ORDER / LANE_SHORT_LABEL (PipelineStrip.tsx), and LANE_LABEL
// (GuessLanes.tsx) all DERIVE from it — none are hand-listed anymore. Every
// registered lane is also exercised by tests/unit/laneRenderContract.test.tsx
// (a synthetic wire payload for EVERY lane, run through the real parse + the
// real strip/disclosure render — so a lane added here without render support
// fails immediately).
//
// There is no build-shared package importable by both the companion (Node/
// Bun server bundle) and the extension (WXT/browser bundle) — they ship as
// fully separate bundles with no cross-package import today, so each package
// keeps its own copy of this file. The mirror is enforced at TEST time
// instead of build time: this file's ATTRIBUTION_LANES, the companion's, and
// docs/contracts/lanes.json (generated FROM the companion's copy via
// scripts/generate-lanes-contract.ts) must all deep-equal each other —
// laneRegistry.test.ts here and the companion's asserts against the same
// JSON snapshot, so drift on either side fails BOTH suites.
//
// KEEP THIS FILE'S ATTRIBUTION_LANES OBJECT IDENTICAL to the companion's
// tabsession/laneRegistry.ts. If you're adding a lane: edit the companion's
// copy + regenerate docs/contracts/lanes.json (scripts/generate-lanes-
// contract.ts), then copy the same entry here — laneRegistry.test.ts will
// fail loudly if the two fall out of sync.

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
  // True for the six lanes the companion always computes synchronously;
  // false for the optional lanes appended after the fact by their own
  // modules, present on the wire only when that lane actually ran.
  readonly alwaysVisible: boolean;
}

// THE extension's mirror of the canonical lane table. Keep in exact sync with
// the companion's copy (packages/sidetrack-companion/src/tabsession/
// laneRegistry.ts) and docs/contracts/lanes.json — laneRegistry.test.ts
// enforces this.
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
// derive BASE_LANE_ORDER / OPTIONAL_LANE_ORDER (PipelineStrip.tsx) — the
// single sort-and-filter both packages apply to the same underlying data.
export const laneIdsInOrder = (
  filter?: (definition: LaneDefinition) => boolean,
): readonly GuessLane[] =>
  ALL_LANE_IDS.filter((laneId) => filter === undefined || filter(ATTRIBUTION_LANES[laneId])).sort(
    (a, b) => ATTRIBUTION_LANES[a].order - ATTRIBUTION_LANES[b].order,
  );

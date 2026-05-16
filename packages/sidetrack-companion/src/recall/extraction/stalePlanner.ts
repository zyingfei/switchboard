import type { ExtractionStore } from './store.js';
import type { ExtractionSourceState } from './types.js';

// Sync Contract v1 / Class E — stale planner.
//
// Reports per-source upgrade eligibility so an operator can see
// honestly: "X sources can be re-extracted from stored evidence
// right now, Y need you to revisit the live provider thread, Z lack
// stored evidence and aren't upgradeable, W are current." Full
// rebuild is NOT the default path for plugin upgrades.
//
// Lane 2 stage 4 lands the planner skeleton; the actual
// "stored evidence available" check requires capture events to
// carry source evidence (DOM snapshot), which is a Lane 2 stage 5
// follow-up. For now every stale source is reported as
// 'live-provider' (needs the user to re-visit) — once stored
// evidence is captured by the plugin, the planner upgrades the
// classification.

export type SourceUpgradeStatus =
  | 'current' // indexedExtractionRevision === latestExtractionRevision
  | 'stored-reextract' // stale + capture event has stored DOM snapshot
  | 'live-provider' // stale + need user to re-visit live page
  | 'not-upgradeable'; // no stored evidence + no way to re-extract

export interface UpgradePlan {
  readonly bySource: ReadonlyMap<string, SourceUpgradeStatus>;
  readonly counts: {
    readonly current: number;
    readonly storedReextract: number;
    readonly liveProvider: number;
    readonly notUpgradeable: number;
  };
}

const classify = (state: ExtractionSourceState): SourceUpgradeStatus => {
  if (state.status === 'current') return 'current';
  // TODO Lane 2 stage 5: when capture events carry stored DOM
  // evidence + an extractor manifest entry whose extractorVersion >
  // the latest revision's, classify as 'stored-reextract'. For now,
  // every stale source needs the user to revisit the live provider.
  return 'live-provider';
};

export const planExtractionUpgrade = async (store: ExtractionStore): Promise<UpgradePlan> => {
  const all = await store.listAllSources();
  const bySource = new Map<string, SourceUpgradeStatus>();
  let current = 0;
  let storedReextract = 0;
  let liveProvider = 0;
  let notUpgradeable = 0;
  for (const state of all) {
    const status = classify(state);
    bySource.set(state.sourceUnitId, status);
    switch (status) {
      case 'current':
        current += 1;
        break;
      case 'stored-reextract':
        storedReextract += 1;
        break;
      case 'live-provider':
        liveProvider += 1;
        break;
      case 'not-upgradeable':
        notUpgradeable += 1;
        break;
    }
  }
  return {
    bySource,
    counts: { current, storedReextract, liveProvider, notUpgradeable },
  };
};

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ALL_LANE_IDS, ATTRIBUTION_LANES, laneIdsInOrder } from './laneRegistry.js';

// Mirror-deep-equality check (task #29). docs/contracts/lanes.json is
// generated FROM this registry (scripts/generate-lanes-contract.ts) and is
// the shared snapshot both packages' test suites assert against. If someone
// edits this registry without regenerating the JSON — or edits the JSON by
// hand without touching this file, or the extension's mirror drifts from
// either — this test (and the extension's tests/unit/laneRegistry.test.ts)
// fails. That is the whole point: a lane added on one side with no matching
// entry on the other can no longer ship silently.
const contractPath = fileURLToPath(
  new URL('../../../../docs/contracts/lanes.json', import.meta.url),
);

describe('laneRegistry — companion/extension/JSON mirror contract', () => {
  it('matches the shared docs/contracts/lanes.json snapshot exactly', () => {
    const snapshot: unknown = JSON.parse(readFileSync(contractPath, 'utf8'));
    expect(ATTRIBUTION_LANES).toEqual(snapshot);
  });

  it('every lane id is unique and every order is unique', () => {
    expect(new Set(ALL_LANE_IDS).size).toBe(ALL_LANE_IDS.length);
    const orders = ALL_LANE_IDS.map((id) => ATTRIBUTION_LANES[id].order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('laneIdsInOrder sorts by `order`, ascending', () => {
    const ordered = laneIdsInOrder();
    const orders = ordered.map((id) => ATTRIBUTION_LANES[id].order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(ordered).toHaveLength(ALL_LANE_IDS.length);
  });

  it('laneIdsInOrder filters by the predicate before sorting', () => {
    const alwaysVisible = laneIdsInOrder((definition) => definition.alwaysVisible);
    expect(alwaysVisible).toEqual(['graph', 'similarity', 'topic', 'title', 'domain', 'recency']);
    const optional = laneIdsInOrder((definition) => !definition.alwaysVisible);
    expect(optional).toEqual(['content', 'ai', 'prototype']);
  });
});

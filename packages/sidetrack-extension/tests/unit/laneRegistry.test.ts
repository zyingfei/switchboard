import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ALL_LANE_IDS,
  ATTRIBUTION_LANES,
  laneIdsInOrder,
} from '../../src/sidepanel/tabsession/laneRegistry';

// Mirror-deep-equality check (task #29). docs/contracts/lanes.json is
// generated from the COMPANION's registry
// (packages/sidetrack-companion/src/tabsession/laneRegistry.ts, via
// scripts/generate-lanes-contract.ts) and is the shared snapshot both
// packages' suites assert against. This extension copy is hand-mirrored (no
// build-shared package exists between the two bundles — see this file's
// header comment for why). If the extension's registry drifts from the
// companion's — whether by omission (like the 'ai'/'prototype' incidents
// this registry exists to prevent) or by a typo'd label/order — this test
// fails, independent of and in addition to the companion's own
// laneRegistry.test.ts failing.
//
// NOTE: deliberately NOT `new URL('../relative', import.meta.url)` — Vite's
// dev/test pipeline statically rewrites exactly that pattern into an
// `http://localhost:.../@fs/...` asset URL (its import.meta.url-relative
// asset-import special case), which then fails `fileURLToPath` ("must be of
// scheme file"). Resolving `import.meta.url` to a path FIRST, then joining
// with `path`, sidesteps that rewrite.
const here = fileURLToPath(import.meta.url);
const contractPath = path.resolve(path.dirname(here), '../../../../docs/contracts/lanes.json');

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

  it('laneIdsInOrder filters by the predicate before sorting (base six vs optional tail)', () => {
    const alwaysVisible = laneIdsInOrder((definition) => definition.alwaysVisible);
    expect(alwaysVisible).toEqual(['graph', 'similarity', 'topic', 'title', 'domain', 'recency']);
    const optional = laneIdsInOrder((definition) => !definition.alwaysVisible);
    expect(optional).toEqual(['content', 'ai', 'prototype']);
  });
});

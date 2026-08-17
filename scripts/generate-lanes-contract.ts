#!/usr/bin/env bun
// Regenerates docs/contracts/lanes.json from the companion's lane registry
// (packages/sidetrack-companion/src/tabsession/laneRegistry.ts) — THE
// canonical source. The extension keeps its own hand-mirrored copy
// (packages/sidetrack-extension/src/sidepanel/tabsession/laneRegistry.ts);
// both packages' test suites (laneRegistry.test.ts in each) assert their
// local ATTRIBUTION_LANES deep-equals this JSON file, so any drift between
// the companion registry, the extension's mirror, or this file fails BOTH
// suites — see task #29 / docs/plans/2026-08-15-foundation-program.md.
//
// Run after editing the companion registry:
//   bun run scripts/generate-lanes-contract.ts
// then hand-mirror the same edit into the extension's laneRegistry.ts and
// re-run both packages' test suites to confirm the three stay in sync.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ATTRIBUTION_LANES } from '../packages/sidetrack-companion/src/tabsession/laneRegistry.js';

const outPath = fileURLToPath(
  new URL('../docs/contracts/lanes.json', import.meta.url),
);

const json = `${JSON.stringify(ATTRIBUTION_LANES, null, 2)}\n`;
writeFileSync(outPath, json, 'utf8');

process.stdout.write(`wrote ${outPath} (${String(Object.keys(ATTRIBUTION_LANES).length)} lanes)\n`);

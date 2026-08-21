#!/usr/bin/env bun
// Offline measurement CLI for the learned per-node aggregator-stats SHADOW
// (src/ranker/learnedAggregatorStats.ts). Reads NAVIGATION_COMMITTED /
// BROWSER_TIMELINE_OBSERVED events from a SQLite event-store snapshot
// (unbounded — this is the CLI/eval carve-out the F3 exit criteria
// explicitly allows; the LIVE workGraphHealth.ts shadow row stays bounded,
// see its own comment), classifies every distinct canonical URL against
// BOTH the hand-maintained registry (ranker/aggregatorProfiles.ts) and the
// learned classifier, and reports agreement/disagreement — overall, PER
// REGISTRY-COVERED DOMAIN (the task #22 close-the-blind-spot breakdown —
// which domains still disagree and why), and spot-check plausibility on
// non-registry domains.
//
// Usage:
//   bun run scripts/measure-learned-aggregator-stats.ts <vault-root>
//   bun run scripts/measure-learned-aggregator-stats.ts <path-to-event-store-snapshot.db>  (legacy; no keyword-entropy join)
//
// <vault-root> is a directory shaped like a real vault
// (<root>/_BAC/connections/event-store.db, .../keyword-index.db,
// .../keyword-concepts.db) — point this at a SNAPSHOT root, never a live
// companion's vault (see the backup warning below). When keyword-index.db /
// keyword-concepts.db are absent, the keyword-concept-entropy join is
// skipped (reported explicitly, not silently) and every other measurement
// is unaffected — see learnedAggregatorKeywordJoin.ts's "best-effort, never
// a hard dependency" note.
//
// IMPORTANT: never point this at a LIVE companion's vault directly — copy
// it first with SQLite's online backup API (safe against a concurrent
// writer), preserving the `_BAC/connections/` layout, e.g.:
//   mkdir -p <snapshot>/_BAC/connections
//   for f in event-store.db keyword-index.db keyword-concepts.db; do
//     sqlite3 <live-vault>/_BAC/connections/$f ".backup <snapshot>/_BAC/connections/$f"
//   done
// This script only ever reads (the keyword stores open read/write per their
// own constructors' only mode, but this script never calls a mutating
// method on them — see learnedAggregatorKeywordJoin.ts).

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';

import { aggregatorProfileForHost, classifyAggregatorPageForUrl } from '../src/ranker/aggregatorProfiles.js';
import {
  applyAggregatorObservations,
  buildAggregatorShadowAgreement,
  classifyLearnedAggregatorUrl,
  createEmptyAggregatorStatsState,
  isLearnedAggregatorHost,
  registrableDomainOf,
  type AggregatorStatsState,
} from '../src/ranker/learnedAggregatorStats.js';
import { aggregatorObservationsFromEvents } from '../src/ranker/learnedAggregatorStatsEvents.js';
import {
  createAggregatorKeywordConceptLookup,
  withKeywordConceptIds,
  type AggregatorKeywordConceptLookup,
} from '../src/ranker/learnedAggregatorKeywordJoin.js';
import { NAVIGATION_COMMITTED } from '../src/navigation/events.js';
import { BROWSER_TIMELINE_OBSERVED } from '../src/timeline/events.js';
import type { AcceptedEvent } from '../src/sync/causal.js';
import type { AggregatorPageType } from '../src/ranker/aggregatorProfiles.js';

interface EventRow {
  readonly replica_id: string;
  readonly seq: number;
  readonly client_event_id: string;
  readonly type: string;
  readonly payload: string;
  readonly accepted_at_ms: number;
  readonly deps: string;
  readonly aggregate_id: string;
}

const readEvents = (dbPath: string): readonly AcceptedEvent[] => {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query(
        `SELECT replica_id, seq, client_event_id, type, payload, accepted_at_ms, deps, aggregate_id
         FROM events WHERE type IN (?, ?) ORDER BY accepted_at_ms ASC`,
      )
      .all(NAVIGATION_COMMITTED, BROWSER_TIMELINE_OBSERVED) as readonly EventRow[];
    return rows.map((row) => ({
      clientEventId: row.client_event_id,
      dot: { replicaId: row.replica_id, seq: row.seq },
      deps: JSON.parse(row.deps) as Record<string, number>,
      aggregateId: row.aggregate_id,
      type: row.type,
      payload: JSON.parse(row.payload) as unknown,
      acceptedAtMs: row.accepted_at_ms,
    }));
  } finally {
    db.close();
  }
};

const hostnameOf = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

const formatPct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const formatNum = (value: number, digits = 2): string => value.toFixed(digits);

interface Pair {
  readonly url: string;
  readonly registryType: AggregatorPageType;
  readonly learnedType: AggregatorPageType;
}

// Resolve <arg> to (eventStoreDbPath, keywordLookup-or-null). A directory
// argument is treated as a vault root (the new, preferred mode — enables
// the keyword-entropy join); a file argument is treated as a legacy
// standalone event-store snapshot path (keyword join skipped, reported).
const resolveInput = async (
  arg: string,
): Promise<{ readonly eventStoreDbPath: string; readonly keywordLookup: AggregatorKeywordConceptLookup | null }> => {
  const asVaultEventStore = join(arg, '_BAC', 'connections', 'event-store.db');
  if (existsSync(asVaultEventStore)) {
    const keywordIndexPath = join(arg, '_BAC', 'connections', 'keyword-index.db');
    const keywordConceptsPath = join(arg, '_BAC', 'connections', 'keyword-concepts.db');
    if (existsSync(keywordIndexPath) && existsSync(keywordConceptsPath)) {
      console.log('  keyword-index.db + keyword-concepts.db found — keyword-concept-entropy join ENABLED.');
      const keywordLookup = await createAggregatorKeywordConceptLookup(arg);
      return { eventStoreDbPath: asVaultEventStore, keywordLookup };
    }
    console.log('  keyword-index.db / keyword-concepts.db not found under this vault root — keyword-concept-entropy join SKIPPED (every other measurement is unaffected).');
    return { eventStoreDbPath: asVaultEventStore, keywordLookup: null };
  }
  if (existsSync(arg)) {
    console.log('  legacy mode: raw event-store path (not a vault root) — keyword-concept-entropy join SKIPPED.');
    return { eventStoreDbPath: arg, keywordLookup: null };
  }
  throw new Error(`Not found as a vault root (${asVaultEventStore}) or a file: ${arg}`);
};

const buildPairs = (state: AggregatorStatsState, distinctUrls: readonly string[]): readonly Pair[] =>
  distinctUrls.flatMap((url) => {
    const hostname = hostnameOf(url);
    if (hostname === null) return [];
    return [
      {
        url,
        registryType: classifyAggregatorPageForUrl(new URL(url)),
        learnedType: classifyLearnedAggregatorUrl(state, url),
      },
    ];
  });

// Per-registrable-domain breakdown — the task #22 deliverable: which
// registry-covered domains still disagree, and the diagnostic counters that
// explain why (fan-out evidence, population-shape evidence, keyword-concept
// entropy) — printed even for fields the current classifier revision
// doesn't yet consult, so a re-run after adding a new signal is a diff
// against this same table.
const printPerDomainTable = (state: AggregatorStatsState, pairs: readonly Pair[]): void => {
  const byDomain = new Map<string, Pair[]>();
  for (const pair of pairs) {
    const hostname = hostnameOf(pair.url);
    if (hostname === null) continue;
    if (aggregatorProfileForHost(hostname) === undefined) continue;
    const domain = registrableDomainOf(hostname);
    (byDomain.get(domain) ?? byDomain.set(domain, []).get(domain)!).push(pair);
  }

  console.log('\n=== Per-registry-domain breakdown ===');
  const rows = [...byDomain.entries()].sort((left, right) => right[1].length - left[1].length);
  for (const [domain, domainPairs] of rows) {
    const agreement = buildAggregatorShadowAgreement(domainPairs);
    const stats = state.domainStats(domain);
    console.log(`\n  ${domain}  (${domainPairs.length} URLs)`);
    console.log(
      `    agreement: ${String(agreement.agreementCount)}/${String(agreement.totalClassified)} (${formatPct(agreement.agreementRate)})` +
        `  registryOnly=${String(agreement.registryOnlyAggregatorCount)}` +
        `  feedVsItem=${String(agreement.feedVsItemDisagreementCount)}`,
    );
    if (stats === undefined) {
      console.log('    learned-side: NO OBSERVATIONS (every URL on this domain fell through parsing/adapter gaps)');
      continue;
    }
    console.log(
      `    distinctUrlCount=${String(stats.distinctUrlCount)}` +
        `  hub=${String(isLearnedAggregatorHost(state, domain))}` +
        `  hubCandidateCount=${String(stats.hubCandidateCount)}` +
        `  maxQualifyingOutlinkFanout=${String(stats.maxQualifyingOutlinkFanout)}`,
    );
    console.log(
      `    deepSingleVisitUrlCount=${String(stats.deepSingleVisitUrlCount ?? 'n/a')}` +
        `  shallowHighRevisitUrlCount=${String(stats.shallowHighRevisitUrlCount ?? 'n/a')}` +
        `  shallowTitleChurnRate=${stats.shallowTitleChurnRate === undefined ? 'n/a' : formatNum(stats.shallowTitleChurnRate)}` +
        ` (n=${String(stats.shallowTitleChurnSampleCount ?? 0)})`,
    );
    console.log(
      `    keywordConceptEntropyBits=${formatNum(stats.keywordConceptEntropyBits)}` +
        `  (n=${String(stats.keywordConceptObservationCount ?? 0)})` +
        `  firstPathSegmentEntropyBits=${formatNum(stats.firstPathSegmentEntropyBits)}`,
    );
    const disagreements = domainPairs.filter((pair) => pair.registryType !== pair.learnedType);
    if (disagreements.length > 0) {
      console.log(`    sample disagreements (registry -> learned), up to 6 of ${String(disagreements.length)}:`);
      for (const item of disagreements.slice(0, 6)) {
        console.log(`      ${item.registryType.padEnd(13)} -> ${item.learnedType.padEnd(13)} ${item.url}`);
      }
    }
  }
};

const main = async (): Promise<void> => {
  const arg = process.argv[2];
  if (arg === undefined) {
    console.error('Usage: bun run scripts/measure-learned-aggregator-stats.ts <vault-root | path-to-event-store-snapshot.db>');
    process.exit(1);
  }

  console.log(`Resolving input: ${arg} ...`);
  const { eventStoreDbPath, keywordLookup } = await resolveInput(arg);

  console.log(`Reading NAVIGATION_COMMITTED + BROWSER_TIMELINE_OBSERVED from ${eventStoreDbPath} ...`);
  const events = readEvents(eventStoreDbPath);
  console.log(`  ${events.length} events read.`);

  let observations = aggregatorObservationsFromEvents(events);
  console.log(`  ${observations.length} observations derived.`);
  if (keywordLookup !== null) {
    observations = withKeywordConceptIds(observations, keywordLookup);
    keywordLookup.close();
  }

  const state = applyAggregatorObservations(createEmptyAggregatorStatsState(), observations);
  const distinctUrls = [...new Set(observations.map((observation) => observation.canonicalUrl))].sort();
  console.log(`  ${distinctUrls.length} distinct canonical URLs.`);

  const pairs = buildPairs(state, distinctUrls);
  const registryDomains = new Set<string>();
  const learnedOnlyDomains = new Set<string>();
  for (const url of distinctUrls) {
    const hostname = hostnameOf(url);
    if (hostname === null) continue;
    if (aggregatorProfileForHost(hostname) !== undefined) {
      registryDomains.add(hostname);
    } else if (isLearnedAggregatorHost(state, hostname)) {
      learnedOnlyDomains.add(hostname);
    }
  }

  const overall = buildAggregatorShadowAgreement(pairs);
  const registryOnly = buildAggregatorShadowAgreement(
    pairs.filter((pair) => {
      const hostname = hostnameOf(pair.url);
      return hostname !== null && aggregatorProfileForHost(hostname) !== undefined;
    }),
  );

  console.log('\n=== Overall (every URL the vault knows) ===');
  console.log(`  totalClassified: ${String(overall.totalClassified)}`);
  console.log(`  agreementCount: ${String(overall.agreementCount)} (${formatPct(overall.agreementRate)})`);
  console.log(`  disagreementCount: ${String(overall.disagreementCount)}`);
  console.log(`  registryOnlyAggregatorCount: ${String(overall.registryOnlyAggregatorCount)}`);
  console.log(`  learnedOnlyAggregatorCount: ${String(overall.learnedOnlyAggregatorCount)}`);
  console.log(`  feedVsItemDisagreementCount: ${String(overall.feedVsItemDisagreementCount)}`);
  console.log(`  confusion: ${JSON.stringify(overall.confusion)}`);

  console.log('\n=== Registry-covered domains only ===');
  console.log(`  domains: ${[...registryDomains].sort().join(', ')}`);
  console.log(`  totalClassified: ${String(registryOnly.totalClassified)}`);
  console.log(`  agreementCount: ${String(registryOnly.agreementCount)} (${formatPct(registryOnly.agreementRate)})`);
  console.log(`  disagreementCount: ${String(registryOnly.disagreementCount)}`);
  console.log(`  registryOnlyAggregatorCount: ${String(registryOnly.registryOnlyAggregatorCount)}`);
  console.log(`  feedVsItemDisagreementCount: ${String(registryOnly.feedVsItemDisagreementCount)}`);
  console.log(`  confusion: ${JSON.stringify(registryOnly.confusion)}`);

  printPerDomainTable(state, pairs);

  console.log('\n=== Non-registry domains the learned classifier calls a hub ===');
  console.log(`  (this is the entire point of the replacement — hubs found without a hand-written entry)`);
  const domainUrlCounts = new Map<string, number>();
  for (const url of distinctUrls) {
    const hostname = hostnameOf(url);
    if (hostname === null || !learnedOnlyDomains.has(hostname)) continue;
    domainUrlCounts.set(hostname, (domainUrlCounts.get(hostname) ?? 0) + 1);
  }
  const sortedLearnedOnly = [...domainUrlCounts.entries()].sort((left, right) => right[1] - left[1]);
  for (const [domain, count] of sortedLearnedOnly) {
    console.log(`  ${domain}: ${String(count)} distinct URLs observed`);
    const sample = pairs.filter((pair) => hostnameOf(pair.url) === domain).slice(0, 8);
    for (const item of sample) {
      console.log(`    ${item.learnedType.padEnd(13)} ${item.url}`);
    }
  }
  if (sortedLearnedOnly.length === 0) {
    console.log('  (none found on this vault)');
  }

  console.log('\n=== Spot-check: non-registry, non-hub domains (single-source plausibility) ===');
  console.log('  (domains the learned classifier correctly leaves as not-aggregator)');
  const nonHubDomainCounts = new Map<string, number>();
  for (const url of distinctUrls) {
    const hostname = hostnameOf(url);
    if (hostname === null) continue;
    if (aggregatorProfileForHost(hostname) !== undefined) continue;
    if (learnedOnlyDomains.has(hostname)) continue;
    nonHubDomainCounts.set(hostname, (nonHubDomainCounts.get(hostname) ?? 0) + 1);
  }
  const sortedNonHub = [...nonHubDomainCounts.entries()]
    .filter(([, count]) => count >= 3)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 15);
  for (const [domain, count] of sortedNonHub) {
    console.log(`  not-aggregator  ${domain}  (${count} distinct URLs)`);
  }
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

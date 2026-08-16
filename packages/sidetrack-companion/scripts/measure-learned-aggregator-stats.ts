#!/usr/bin/env bun
// Offline measurement CLI for the learned per-node aggregator-stats SHADOW
// (src/ranker/learnedAggregatorStats.ts). Reads NAVIGATION_COMMITTED /
// BROWSER_TIMELINE_OBSERVED events from a SQLite event-store snapshot
// (unbounded — this is the CLI/eval carve-out the F3 exit criteria
// explicitly allows; the LIVE workGraphHealth.ts shadow row stays bounded,
// see its own comment), classifies every distinct canonical URL against
// BOTH the hand-maintained registry (ranker/aggregatorProfiles.ts) and the
// learned classifier, and reports agreement/disagreement — overall, on
// registry-covered domains, and spot-check plausibility on non-registry
// domains.
//
// Usage:
//   bun run scripts/measure-learned-aggregator-stats.ts <path-to-event-store.db>
//
// IMPORTANT: never point this at a LIVE companion's event-store.db directly
// — open it via `sqlite3 <db> ".backup <snapshot>"` first (SQLite's online
// backup API; safe against a concurrent writer) and pass the snapshot path.
// This script only ever reads; it never writes to the database it opens.

import { Database } from 'bun:sqlite';

import { aggregatorProfileForHost, classifyAggregatorPageForUrl } from '../src/ranker/aggregatorProfiles.js';
import {
  applyAggregatorObservations,
  buildAggregatorShadowAgreement,
  classifyLearnedAggregatorUrl,
  createEmptyAggregatorStatsState,
  isLearnedAggregatorHost,
} from '../src/ranker/learnedAggregatorStats.js';
import { aggregatorObservationsFromEvents } from '../src/ranker/learnedAggregatorStatsEvents.js';
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

const main = (): void => {
  const dbPath = process.argv[2];
  if (dbPath === undefined) {
    console.error('Usage: bun run scripts/measure-learned-aggregator-stats.ts <path-to-event-store-snapshot.db>');
    process.exit(1);
  }

  console.log(`Reading NAVIGATION_COMMITTED + BROWSER_TIMELINE_OBSERVED from ${dbPath} ...`);
  const events = readEvents(dbPath);
  console.log(`  ${events.length} events read.`);

  const observations = aggregatorObservationsFromEvents(events);
  console.log(`  ${observations.length} observations derived.`);

  const state = applyAggregatorObservations(createEmptyAggregatorStatsState(), observations);
  const distinctUrls = [...new Set(observations.map((observation) => observation.canonicalUrl))].sort();
  console.log(`  ${distinctUrls.length} distinct canonical URLs.`);

  const pairs: { readonly url: string; readonly registryType: AggregatorPageType; readonly learnedType: AggregatorPageType }[] = [];
  const registryDomains = new Set<string>();
  const learnedOnlyDomains = new Set<string>();
  for (const url of distinctUrls) {
    const hostname = hostnameOf(url);
    if (hostname === null) continue;
    const registryType = classifyAggregatorPageForUrl(new URL(url));
    const learnedType = classifyLearnedAggregatorUrl(state, url);
    pairs.push({ url, registryType, learnedType });
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
  console.log(`  totalClassified: ${overall.totalClassified}`);
  console.log(`  agreementCount: ${overall.agreementCount} (${formatPct(overall.agreementRate)})`);
  console.log(`  disagreementCount: ${overall.disagreementCount}`);
  console.log(`  registryOnlyAggregatorCount: ${overall.registryOnlyAggregatorCount}`);
  console.log(`  learnedOnlyAggregatorCount: ${overall.learnedOnlyAggregatorCount}`);
  console.log(`  feedVsItemDisagreementCount: ${overall.feedVsItemDisagreementCount}`);
  console.log(`  confusion: ${JSON.stringify(overall.confusion)}`);

  console.log('\n=== Registry-covered domains only ===');
  console.log(`  domains: ${[...registryDomains].sort().join(', ')}`);
  console.log(`  totalClassified: ${registryOnly.totalClassified}`);
  console.log(`  agreementCount: ${registryOnly.agreementCount} (${formatPct(registryOnly.agreementRate)})`);
  console.log(`  disagreementCount: ${registryOnly.disagreementCount}`);
  console.log(`  registryOnlyAggregatorCount: ${registryOnly.registryOnlyAggregatorCount}`);
  console.log(`  feedVsItemDisagreementCount: ${registryOnly.feedVsItemDisagreementCount}`);
  console.log(`  confusion: ${JSON.stringify(registryOnly.confusion)}`);

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
    console.log(`  ${domain}: ${count} distinct URLs observed`);
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

main();

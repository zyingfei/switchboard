import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createEngagementFactsStore, engagementInputsFromEvents } from './engagementFactsStore.js';
import { ENGAGEMENT_SESSION_AGGREGATED, type EngagementDimensions } from './events.js';
import { buildEngagementClassifierInputs } from '../producers/engagement-class-revision.js';
import { NAVIGATION_COMMITTED } from '../navigation/events.js';
import { SELECTION_COPIED, SELECTION_PASTED } from '../snippets/events.js';
import type { AcceptedEvent } from '../sync/causal.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

const dims = (overrides: Partial<EngagementDimensions> = {}): EngagementDimensions => ({
  activeMs: 1000,
  visibleMs: 2000,
  focusedWindowMs: 1500,
  idleMs: 300,
  foregroundBursts: 2,
  returnCount: 1,
  scrollEvents: 10,
  maxScrollRatio: 0.5,
  copyCount: 1,
  pasteCount: 0,
  ...overrides,
});

let seqCounter = 0;
const REPLICA = 'replica-a';
const engagementEvent = (
  visitId: string,
  sessionId: string,
  engagement: EngagementDimensions,
  acceptedAtMs: number,
): AcceptedEvent => ({
  clientEventId: `eng-${String(++seqCounter)}`,
  dot: { replicaId: REPLICA, seq: seqCounter },
  deps: {},
  aggregateId: visitId,
  type: ENGAGEMENT_SESSION_AGGREGATED,
  payload: { payloadVersion: 1, visitId, sessionId, dimensions: { engagement } },
  acceptedAtMs,
});

const navEvent = (visitId: string, canonicalUrl: string, acceptedAtMs: number): AcceptedEvent => ({
  clientEventId: `nav-${String(++seqCounter)}`,
  dot: { replicaId: REPLICA, seq: seqCounter },
  deps: {},
  aggregateId: visitId,
  type: NAVIGATION_COMMITTED,
  payload: {
    payloadVersion: 1,
    visitId,
    url: canonicalUrl,
    canonicalUrl,
    documentId: `doc-${visitId}`,
    parentDocumentId: null,
    tabSessionIdHash: 'tab-1',
    windowSessionIdHash: 'win-1',
    openerVisitId: null,
    previousVisitId: null,
    navigationSequence: 1,
    transitionType: 'link',
    transitionQualifiers: [],
    commitTimestamp: acceptedAtMs,
  },
  acceptedAtMs,
});

const copyEvent = (
  visitId: string,
  selectionHash: string,
  simhash64: string,
  acceptedAtMs: number,
): AcceptedEvent => ({
  clientEventId: `copy-${String(++seqCounter)}`,
  dot: { replicaId: REPLICA, seq: seqCounter },
  deps: {},
  aggregateId: visitId,
  type: SELECTION_COPIED,
  payload: {
    payloadVersion: 1,
    visitId,
    selectionHash,
    simhash64,
    charCount: 42,
    lineCount: 3,
    contentKindHint: 'prose',
    rawTextStored: false,
  },
  acceptedAtMs,
});

const pasteEvent = (
  selectionHash: string,
  simhash64: string,
  destinationKind: 'thread' | 'dispatch' | 'search' | 'note' | 'capture',
  destinationId: string,
  acceptedAtMs: number,
): AcceptedEvent => ({
  clientEventId: `paste-${String(++seqCounter)}`,
  dot: { replicaId: REPLICA, seq: seqCounter },
  deps: {},
  aggregateId: destinationId,
  type: SELECTION_PASTED,
  payload: {
    payloadVersion: 1,
    destinationKind,
    destinationId,
    selectionHash,
    simhash64,
    charCount: 42,
    rawTextStored: false,
  },
  acceptedAtMs,
});

const irrelevantEvent = (acceptedAtMs: number): AcceptedEvent => ({
  clientEventId: `priv-${String(++seqCounter)}`,
  dot: { replicaId: REPLICA, seq: seqCounter },
  deps: {},
  aggregateId: 'privacy',
  type: 'privacy.gate.flipped',
  payload: { payloadVersion: 1, gate: 'timeline', state: 'open' },
  acceptedAtMs,
});

// Representative event set exercising: summed dims across sessions,
// navigation last-write-wins, paste lineage (exact + fuzzy ignored here),
// a nav-only visit (excluded from inputs), and irrelevant events.
const buildEvents = (): readonly AcceptedEvent[] => {
  seqCounter = 0;
  return [
    navEvent('visit-1', 'https://example.com/page-a', 1000),
    engagementEvent('visit-1', 'sess-1', dims({ activeMs: 1000, maxScrollRatio: 0.4 }), 1100),
    engagementEvent('visit-1', 'sess-2', dims({ activeMs: 5000, maxScrollRatio: 0.9 }), 1200),
    copyEvent('visit-1', 'hash-xyz', '0', 1300),
    irrelevantEvent(1350),
    navEvent('visit-2', 'https://example.com/page-b#frag', 2000),
    // last-write-wins: visit-2's canonical re-committed without fragment
    navEvent('visit-2', 'https://example.com/page-b', 2100),
    engagementEvent('visit-2', 'sess-3', dims({ visibleMs: 9000 }), 2200),
    pasteEvent('hash-xyz', '0', 'thread', 'thread-1', 2300),
    // nav-only visit: has navigation but no engagement → excluded
    navEvent('visit-3', 'https://example.com/page-c', 3000),
  ];
};

describe('EngagementFactsStore byte-equivalence', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const tempVault = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), 'eng-facts-'));
    dirs.push(d);
    await mkdir(join(d, '_BAC', 'connections'), { recursive: true });
    return d;
  };

  // Runs under vitest (no Bun/sqlite needed): proves the projection +
  // derive seam is byte-equivalent to the legacy full-walk path.
  it('engagementInputsFromEvents matches buildEngagementClassifierInputs (pure)', () => {
    const events = buildEvents();
    expect(engagementInputsFromEvents(events, [])).toEqual(
      buildEngagementClassifierInputs(events, []),
    );
  });

  sqliteIt('readClassifierInputs matches buildEngagementClassifierInputs', async () => {
    const events = buildEvents();
    const legacy = buildEngagementClassifierInputs(events, []);
    const vault = await tempVault();
    const store = await createEngagementFactsStore(vault);
    store.ingestMany(events);
    const fromStore = store.readClassifierInputs([]);
    store.close();
    expect(fromStore).toEqual(legacy);
    // sanity: visit-1 summed across two sessions, visit-3 (nav-only) excluded
    expect(fromStore.map((i) => i.visitId).sort()).toEqual(['visit-1', 'visit-2']);
    const v1 = fromStore.find((i) => i.visitId === 'visit-1');
    expect(v1?.engagement.activeMs).toBe(6000);
    expect(v1?.engagement.maxScrollRatio).toBeCloseTo(0.9);
    expect(v1?.hasDownstreamPasteLineage).toBe(true);
    const v2 = fromStore.find((i) => i.visitId === 'visit-2');
    expect(v2?.canonicalUrl).toBe('https://example.com/page-b');
  });

  sqliteIt('ingest is idempotent by (replicaId, seq)', async () => {
    const events = buildEvents();
    const vault = await tempVault();
    const store = await createEngagementFactsStore(vault);
    store.ingestMany(events);
    store.ingestMany(events); // second pass must not double-count
    const fromStore = store.readClassifierInputs([]);
    store.close();
    expect(fromStore).toEqual(buildEngagementClassifierInputs(events, []));
  });

  sqliteIt('rebuildFromJsonl reproduces the same inputs', async () => {
    const events = buildEvents();
    const vault = await tempVault();
    const logRoot = join(vault, '_BAC', 'log');
    await mkdir(join(logRoot, REPLICA), { recursive: true });
    await writeFile(
      join(logRoot, REPLICA, '0001.jsonl'),
      `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
      'utf8',
    );
    const store = await createEngagementFactsStore(vault);
    await store.rebuildFromJsonl(logRoot);
    const fromStore = store.readClassifierInputs([]);
    expect(store.watermark()[REPLICA]).toBe(seqCounter);
    store.close();
    expect(fromStore).toEqual(buildEngagementClassifierInputs(events, []));
  });

  sqliteIt('catchUp ingests only events past the watermark', async () => {
    const events = buildEvents();
    const vault = await tempVault();
    const store = await createEngagementFactsStore(vault);
    const firstHalf = events.slice(0, 5);
    const secondHalf = events.slice(5);
    store.ingestMany(firstHalf);
    const added = await store.catchUp(events); // should only add the second half
    store.close();
    expect(added).toBe(secondHalf.filter((e) => e.type !== 'privacy.gate.flipped').length);
  });
});

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ATTRIBUTION_V1_ARTIFACT_SCHEMA_VERSION,
  attributionV1ArtifactPath,
  deserializeAttributionV1State,
  isAttributionV1ArtifactFresh,
  readAttributionV1Artifact,
  serializeAttributionV1State,
  writeAttributionV1Artifact,
} from './artifact.js';
import { buildAttributionV1State, scoreVisit } from './index.js';
import {
  createEmptyAttributionV1State,
  applyOrganizingObservation,
  type AttributionV1State,
} from './state.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import { USER_ORGANIZED_ITEM } from '../feedback/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { EventLog } from '../sync/eventLog.js';

let seq = 0;
const organizeEvent = (url: string, ws: string, atMs: number): AcceptedEvent => {
  seq += 1;
  return {
    clientEventId: `org-${seq}`,
    dot: { replicaId: 'r1', seq },
    deps: {},
    aggregateId: `canonical-url:${url}`,
    type: USER_ORGANIZED_ITEM,
    payload: { payloadVersion: 1, itemKind: 'canonical-url', itemId: url, action: 'move', toContainer: ws },
    acceptedAtMs: atMs,
  };
};
const timelineEvent = (url: string, title: string, atMs: number): AcceptedEvent => {
  seq += 1;
  return {
    clientEventId: `tl-${seq}`,
    dot: { replicaId: 'r1', seq },
    deps: {},
    aggregateId: `timeline-visit:${url}`,
    type: BROWSER_TIMELINE_OBSERVED,
    payload: {
      eventId: `evt-${seq}`,
      observedAt: new Date(atMs).toISOString(),
      url,
      canonicalUrl: url,
      title,
      transition: 'activated',
    },
    acceptedAtMs: atMs,
  };
};

const fixtureEvents = (): readonly AcceptedEvent[] => {
  seq = 0;
  return [
    timelineEvent('https://lwn.net/a', 'Linux kernel scheduler paging', 1),
    timelineEvent('https://doc.rust-lang.org/book', 'Rust lifetimes traits book', 2),
    timelineEvent('https://github.com/x', 'Shared github repo', 3),
    organizeEvent('https://lwn.net/a', 'ws-linux', 10),
    organizeEvent('https://github.com/x', 'ws-linux', 11),
    organizeEvent('https://doc.rust-lang.org/book', 'ws-rust', 12),
  ];
};

// Canonical, order-independent view for state equality.
const canonicalize = (state: AttributionV1State): unknown => {
  const sortEntries = (map: Map<string, number>): [string, number][] =>
    [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    workstreams: [...state.workstreams.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([id, s]) => [id, { termDocFreq: sortEntries(s.termDocFreq), memberCount: s.memberCount, labelCount: s.labelCount }]),
    globalTermWorkstreamFreq: sortEntries(state.globalTermWorkstreamFreq),
    domains: [...state.domains.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([d, h]) => [d, { asserted: sortEntries(h.asserted), inferred: sortEntries(h.inferred) }]),
    lastFiledWorkstreamId: state.lastFiledWorkstreamId,
    lastFiledAtMs: state.lastFiledAtMs,
    totalLabelCount: state.totalLabelCount,
    totalMemberCount: state.totalMemberCount,
  };
};

describe('serialize/deserialize round-trip', () => {
  it('is lossless: deserialize(serialize(state)) == state', () => {
    const state = buildAttributionV1State(fixtureEvents());
    const round = deserializeAttributionV1State(serializeAttributionV1State(state));
    expect(canonicalize(round)).toEqual(canonicalize(state));
  });

  it('preserves scorer behavior across the round-trip', () => {
    const state = buildAttributionV1State(fixtureEvents());
    const round = deserializeAttributionV1State(serializeAttributionV1State(state));
    const input = { title: 'Rust lifetimes traits', url: 'https://blog.example/rust' };
    expect(scoreVisit(input, round)).toEqual(scoreVisit(input, state));
  });

  it('is JSON-stable (serialize -> JSON -> parse -> deserialize == state)', () => {
    const state = buildAttributionV1State(fixtureEvents());
    const json = JSON.stringify(serializeAttributionV1State(state));
    const round = deserializeAttributionV1State(JSON.parse(json));
    expect(canonicalize(round)).toEqual(canonicalize(state));
  });
});

describe('incremental serialize round-trip equals rebuild', () => {
  it('folded state serialized and re-read equals the rebuilt state', () => {
    const events = fixtureEvents();
    const rebuilt = buildAttributionV1State(events);
    // Fold the same labels incrementally.
    const incremental = createEmptyAttributionV1State();
    const titleByUrl = new Map([
      ['https://lwn.net/a', 'Linux kernel scheduler paging'],
      ['https://github.com/x', 'Shared github repo'],
      ['https://doc.rust-lang.org/book', 'Rust lifetimes traits book'],
    ]);
    for (const o of [
      { workstreamId: 'ws-linux', canonicalUrl: 'https://lwn.net/a', atMs: 10 },
      { workstreamId: 'ws-linux', canonicalUrl: 'https://github.com/x', atMs: 11 },
      { workstreamId: 'ws-rust', canonicalUrl: 'https://doc.rust-lang.org/book', atMs: 12 },
    ]) {
      applyOrganizingObservation(incremental, {
        ...o,
        title: titleByUrl.get(o.canonicalUrl)!,
        provenance: 'asserted',
      });
    }
    const rebuiltRound = deserializeAttributionV1State(serializeAttributionV1State(rebuilt));
    const incrementalRound = deserializeAttributionV1State(serializeAttributionV1State(incremental));
    expect(canonicalize(incrementalRound)).toEqual(canonicalize(rebuiltRound));
  });
});

describe('artifact file I/O', () => {
  let vaultRoot: string;
  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'attrib-v1-'));
  });
  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('writes and reads back a fresh artifact', async () => {
    const now = () => new Date('2026-07-16T00:00:00.000Z');
    // No eventLog ⇒ empty state, but the envelope still writes/reads.
    const written = await writeAttributionV1Artifact({ vaultRoot, now });
    expect(written.schemaVersion).toBe(ATTRIBUTION_V1_ARTIFACT_SCHEMA_VERSION);
    const read = await readAttributionV1Artifact(vaultRoot);
    expect(read).not.toBeNull();
    expect(read!.generatedAt).toBe('2026-07-16T00:00:00.000Z');
    expect(isAttributionV1ArtifactFresh(read!, now)).toBe(true);
  });

  it('treats a corrupt file as absent (null)', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const path = attributionV1ArtifactPath(vaultRoot);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'not json{', 'utf8');
    expect(await readAttributionV1Artifact(vaultRoot)).toBeNull();
  });

  it('treats a mismatched schemaVersion as absent (null)', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const path = attributionV1ArtifactPath(vaultRoot);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ schemaVersion: 999, generatedAt: 'x', state: {} }), 'utf8');
    expect(await readAttributionV1Artifact(vaultRoot)).toBeNull();
  });

  it('reads back a persisted artifact JSON with the expected relative path', async () => {
    await writeAttributionV1Artifact({ vaultRoot });
    const body = await readFile(attributionV1ArtifactPath(vaultRoot), 'utf8');
    expect(attributionV1ArtifactPath(vaultRoot)).toContain('_BAC/system/attribution-v1-state.json');
    expect(JSON.parse(body).schemaVersion).toBe(ATTRIBUTION_V1_ARTIFACT_SCHEMA_VERSION);
  });

  it('writes the learned per-domain discriminativeness table (v2) and reads it back', async () => {
    // Inject a minimal eventLog so the artifact is built from real events: two
    // labels on a single-workstream domain (⇒ discriminativeness 1) plus a
    // timeline title join. The table must be present, sorted, and round-trip.
    seq = 0;
    const events: AcceptedEvent[] = [
      timelineEvent('https://solo.example/a', 'Alpha topic content', 1),
      timelineEvent('https://solo.example/b', 'Beta topic content', 2),
      organizeEvent('https://solo.example/a', 'ws-solo', 10),
      organizeEvent('https://solo.example/b', 'ws-solo', 11),
    ];
    const eventLog = { readMerged: async () => events } as unknown as EventLog;
    const written = await writeAttributionV1Artifact({ vaultRoot, eventLog });
    expect(written.domainDiscriminativeness).toBeDefined();
    const solo = written.domainDiscriminativeness!.find((r) => r.domain === 'solo.example');
    expect(solo).toBeDefined();
    // Single-workstream domain ⇒ maximally discriminative.
    expect(solo!.discriminativeness).toBe(1);
    expect(solo!.winnerWorkstreamId).toBe('ws-solo');
    expect(solo!.listedPrior).toBe(false);
    // The reader surfaces the table when present.
    const read = await readAttributionV1Artifact(vaultRoot);
    expect(read!.domainDiscriminativeness).toBeDefined();
    expect(read!.domainDiscriminativeness!.some((r) => r.domain === 'solo.example')).toBe(true);
  });

  it('reads a v2 envelope that lacks the optional discriminativeness table', async () => {
    // Forward-compat guard: the reader tolerates an envelope without the
    // optional table (e.g. a partially-written or hand-crafted file) — the field
    // is simply absent, not a parse failure.
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const path = attributionV1ArtifactPath(vaultRoot);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: ATTRIBUTION_V1_ARTIFACT_SCHEMA_VERSION,
        generatedAt: '2026-07-16T00:00:00.000Z',
        state: { workstreams: {}, domains: {} },
      }),
      'utf8',
    );
    const read = await readAttributionV1Artifact(vaultRoot);
    expect(read).not.toBeNull();
    expect(read!.domainDiscriminativeness).toBeUndefined();
  });

  it('is stale when older than the max age', async () => {
    const written = await writeAttributionV1Artifact({
      vaultRoot,
      now: () => new Date('2026-07-01T00:00:00.000Z'),
    });
    const read = await readAttributionV1Artifact(vaultRoot);
    expect(read).not.toBeNull();
    void written;
    // "now" 30 days later ⇒ beyond the 24h bound ⇒ stale.
    expect(isAttributionV1ArtifactFresh(read!, () => new Date('2026-07-31T00:00:00.000Z'))).toBe(false);
  });
});

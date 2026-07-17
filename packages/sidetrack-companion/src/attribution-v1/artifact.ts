// Attribution v1 — derived-state artifact (drain-time materialize, cheap
// read).
//
// Same discipline as workGraphHealthArtifact.ts / section15Artifact.ts /
// reliabilityArtifact.ts: the connections materializer's onDrainSuccess
// hook materializes this after each successful drain via a typed event read
// (forEachChunkOfTypes over ATTRIBUTION_V1_SOURCE_EVENT_TYPES — never a
// full-log scan), atomic tmp+rename write, lenient schemaVersion-checked
// reader that treats corrupt/mismatched files as absent. The shadow lane
// reads this snapshot at serve time — a cheap JSON read, no per-request
// compute.
//
// The state's live form uses Maps (state.ts). The artifact serializes to a
// plain-object envelope and re-hydrates to Maps on read; the round trip is
// lossless (asserted domain / term counts are integers, timestamps numbers)
// and the equivalence test asserts serialize∘deserialize == identity.
//
// SHADOW ONLY (this wave): the incumbent resolver keeps serving. Nothing
// reads this artifact to decide what serves.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  ATTRIBUTION_V1_SOURCE_EVENT_TYPES,
  buildAttributionV1State,
  createEmptyAttributionV1State,
  domainDiscriminativenessTable,
  type AttributionV1State,
  type DomainDiscriminativeness,
  type DomainHistory,
  type WorkstreamTermStats,
} from './state.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { EventLog } from '../sync/eventLog.js';
import { getCaughtUpSharedEventStore } from '../sync/eventStore.js';

// v2 (2026-07-16): adds the learned per-domain discriminativeness table
// (`domainDiscriminativeness`) as an inspection field. It is DERIVED from the
// serialized state (domainDiscriminativenessTable), so it is redundant with
// `state` and is emitted for human/audit inspection only — the reader does not
// depend on it (a v1 artifact without it still round-trips; the field is
// optional on read). The bump signals the shape change to the lenient reader.
export const ATTRIBUTION_V1_ARTIFACT_SCHEMA_VERSION = 2;

// Serve-side freshness bound — identical rationale to the sibling
// artifacts: the writer only refreshes while drains succeed AND the shared
// event store is enabled, so bound the served snapshot's age. 24h is loose;
// drain cadence is the real contract.
export const ATTRIBUTION_V1_ARTIFACT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Sibling of connections/workgraph-health.json, under system/.
const ATTRIBUTION_V1_ARTIFACT_RELATIVE_PATH = '_BAC/system/attribution-v1-state.json';

// ---- serializable envelope --------------------------------------------

interface SerializedWorkstreamTermStats {
  readonly termDocFreq: Readonly<Record<string, number>>;
  readonly memberCount: number;
  readonly labelCount: number;
}

interface SerializedDomainHistory {
  readonly asserted: Readonly<Record<string, number>>;
  readonly inferred: Readonly<Record<string, number>>;
}

export interface SerializedAttributionV1State {
  readonly workstreams: Readonly<Record<string, SerializedWorkstreamTermStats>>;
  readonly globalTermWorkstreamFreq: Readonly<Record<string, number>>;
  readonly domains: Readonly<Record<string, SerializedDomainHistory>>;
  readonly lastFiledWorkstreamId: string | null;
  readonly lastFiledAtMs: number | null;
  readonly totalLabelCount: number;
  readonly totalMemberCount: number;
}

// One row of the exported learned-domain-discriminativeness table (v2). Mirrors
// state.ts DomainDiscriminativeness but as a plain serializable record. DERIVED
// from `state` — present for inspection, not re-hydrated on read.
export interface SerializedDomainDiscriminativeness {
  readonly domain: string;
  readonly discriminativeness: number;
  readonly winnerWorkstreamId: string | null;
  readonly assertedForWinner: number;
  readonly assertedTotal: number;
  readonly distinctWorkstreams: number;
  readonly listedPrior: boolean;
}

export interface AttributionV1Artifact {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly state: SerializedAttributionV1State;
  // Learned per-domain discriminativeness (v2), sorted most→least discriminative.
  // Optional on read (v1 artifacts lack it); always written by v2.
  readonly domainDiscriminativeness?: readonly SerializedDomainDiscriminativeness[];
}

// Serialize the derived discriminativeness table (round from the live state).
const serializeDomainDiscriminativeness = (
  rows: readonly DomainDiscriminativeness[],
): SerializedDomainDiscriminativeness[] =>
  rows.map((row) => ({
    domain: row.domain,
    discriminativeness: row.discriminativeness,
    winnerWorkstreamId: row.winnerWorkstreamId,
    assertedForWinner: row.assertedForWinner,
    assertedTotal: row.assertedTotal,
    distinctWorkstreams: row.distinctWorkstreams,
    listedPrior: row.listedPrior,
  }));

const mapToRecord = (map: Map<string, number>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [key, value] of map) out[key] = value;
  return out;
};

const recordToMap = (record: Readonly<Record<string, number>>): Map<string, number> => {
  const out = new Map<string, number>();
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'number' && Number.isFinite(value)) out.set(key, value);
  }
  return out;
};

export const serializeAttributionV1State = (
  state: AttributionV1State,
): SerializedAttributionV1State => {
  const workstreams: Record<string, SerializedWorkstreamTermStats> = {};
  for (const [id, stats] of state.workstreams) {
    workstreams[id] = {
      termDocFreq: mapToRecord(stats.termDocFreq),
      memberCount: stats.memberCount,
      labelCount: stats.labelCount,
    };
  }
  const domains: Record<string, SerializedDomainHistory> = {};
  for (const [domain, history] of state.domains) {
    domains[domain] = {
      asserted: mapToRecord(history.asserted),
      inferred: mapToRecord(history.inferred),
    };
  }
  return {
    workstreams,
    globalTermWorkstreamFreq: mapToRecord(state.globalTermWorkstreamFreq),
    domains,
    lastFiledWorkstreamId: state.lastFiledWorkstreamId,
    lastFiledAtMs: state.lastFiledAtMs,
    totalLabelCount: state.totalLabelCount,
    totalMemberCount: state.totalMemberCount,
  };
};

export const deserializeAttributionV1State = (
  serialized: SerializedAttributionV1State,
): AttributionV1State => {
  const state = createEmptyAttributionV1State();
  for (const [id, stats] of Object.entries(serialized.workstreams)) {
    const rehydrated: WorkstreamTermStats = {
      termDocFreq: recordToMap(stats.termDocFreq),
      memberCount: stats.memberCount,
      labelCount: stats.labelCount,
    };
    state.workstreams.set(id, rehydrated);
  }
  for (const [key, value] of Object.entries(serialized.globalTermWorkstreamFreq)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      state.globalTermWorkstreamFreq.set(key, value);
    }
  }
  for (const [domain, history] of Object.entries(serialized.domains)) {
    const rehydrated: DomainHistory = {
      asserted: recordToMap(history.asserted),
      inferred: recordToMap(history.inferred),
    };
    state.domains.set(domain, rehydrated);
  }
  state.lastFiledWorkstreamId = serialized.lastFiledWorkstreamId;
  state.lastFiledAtMs = serialized.lastFiledAtMs;
  state.totalLabelCount = serialized.totalLabelCount;
  state.totalMemberCount = serialized.totalMemberCount;
  return state;
};

// ---- file I/O ---------------------------------------------------------

export const attributionV1ArtifactPath = (vaultRoot: string): string =>
  join(vaultRoot, ATTRIBUTION_V1_ARTIFACT_RELATIVE_PATH);

const writeAtomic = async (path: string, body: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Lenient reader. Missing file / bad JSON / divergent schemaVersion /
// malformed envelope ⇒ null so the shadow lane treats the artifact as
// absent and simply skips (shadow is observability — a missing artifact
// must never break the serve path). Envelope-only validation matches the
// sibling artifacts' trust boundary (same-build writer; a shape change
// bumps ATTRIBUTION_V1_ARTIFACT_SCHEMA_VERSION).
export const readAttributionV1Artifact = async (
  vaultRoot: string,
): Promise<AttributionV1Artifact | null> => {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(attributionV1ArtifactPath(vaultRoot), 'utf8'),
    );
    if (!isRecord(parsed)) return null;
    if (parsed['schemaVersion'] !== ATTRIBUTION_V1_ARTIFACT_SCHEMA_VERSION) return null;
    if (typeof parsed['generatedAt'] !== 'string') return null;
    const state = parsed['state'];
    if (!isRecord(state) || !isRecord(state['workstreams']) || !isRecord(state['domains'])) {
      return null;
    }
    const table = parsed['domainDiscriminativeness'];
    return {
      schemaVersion: ATTRIBUTION_V1_ARTIFACT_SCHEMA_VERSION,
      generatedAt: parsed['generatedAt'],
      state: state as unknown as SerializedAttributionV1State,
      ...(Array.isArray(table)
        ? { domainDiscriminativeness: table as unknown as SerializedDomainDiscriminativeness[] }
        : {}),
    };
  } catch {
    return null;
  }
};

// Age gate — an unparseable generatedAt counts as stale (fail toward
// skipping the shadow collect, matching the lenient reader).
export const isAttributionV1ArtifactFresh = (
  artifact: AttributionV1Artifact,
  now: () => Date = () => new Date(),
): boolean => {
  const generatedAtMs = Date.parse(artifact.generatedAt);
  if (!Number.isFinite(generatedAtMs)) return false;
  return now().getTime() - generatedAtMs <= ATTRIBUTION_V1_ARTIFACT_MAX_AGE_MS;
};

// ---- typed event read (rebuild source) --------------------------------

const emptyEvents: readonly AcceptedEvent[] = [];

// Typed read of exactly the v1 source subset (user.organized.item +
// browser.timeline.observed) via events_type_idx when the shared store is
// available, else a single readMerged filtered by type. Mirrors
// section15Collector.ts:readSection15Events / workGraphHealth's
// readEventsForHealth.
export const readAttributionV1SourceEvents = async (
  vaultRoot: string,
  eventLog: EventLog | undefined,
): Promise<readonly AcceptedEvent[]> => {
  if (eventLog === undefined) return emptyEvents;
  const types = [...ATTRIBUTION_V1_SOURCE_EVENT_TYPES];
  const typeSet = new Set<string>(types);
  const store = await getCaughtUpSharedEventStore(vaultRoot);
  if (store === null) {
    return (await eventLog.readMerged()).filter((event) => typeSet.has(event.type));
  }
  const events: AcceptedEvent[] = [];
  await store.forEachChunkOfTypes(
    types,
    (chunk) => {
      for (const event of chunk) events.push(event);
    },
    2000,
  );
  return events;
};

// ---- write (rebuild-from-log + serialize + atomic write) --------------

export interface WriteAttributionV1ArtifactOptions {
  readonly vaultRoot: string;
  readonly eventLog?: EventLog;
  readonly now?: () => Date;
}

// Collect + rebuild + write in one atomic pass. Returns the written
// artifact so callers (and tests) can assert on it without re-reading.
//
// v1 rebuilds from the full source slice each drain (both source types are
// sparse; the read is typed and the fold is O(labels + timeline)). The
// INCREMENTAL path — applyOrganizingObservation per new label — is exercised
// by the equivalence test and is available for a future in-memory cache;
// rebuilding from the typed slice is already cheap and is the conservative
// correctness-first choice for the shadow wave.
export const writeAttributionV1Artifact = async (
  options: WriteAttributionV1ArtifactOptions,
): Promise<AttributionV1Artifact> => {
  const now = options.now ?? (() => new Date());
  const events = await readAttributionV1SourceEvents(options.vaultRoot, options.eventLog);
  const state = buildAttributionV1State(events);
  const artifact: AttributionV1Artifact = {
    schemaVersion: ATTRIBUTION_V1_ARTIFACT_SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    state: serializeAttributionV1State(state),
    domainDiscriminativeness: serializeDomainDiscriminativeness(
      domainDiscriminativenessTable(state),
    ),
  };
  await writeAtomic(
    attributionV1ArtifactPath(options.vaultRoot),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  return artifact;
};

// W5 follow-up — STATE CARRY for the incremental topic producer.
//
// PROBLEM (measured on both live vaults, 2026-08-22): the incremental
// shadow emitted `[topic.cycle] producer=incremental topics=0 members=0`
// on every real-data cycle. Two compounding causes, both structural:
//
//   1. Sticky-empty prior. The shadow refines off
//      `previousIncrementalShadow ?? leidenCandidate` (inside the
//      protected connectionsMaterializer.ts). Both real vaults hold a
//      zero-topic incremental candidate slot (persisted during the
//      pre-#404 collapse era), and a `{topics: []}` revision is NON-null
//      — so the empty incremental slot permanently shadows any leiden
//      base, and a zero-topic base can never grow through refinement
//      (Tier A needs an existing PRIMARY member to attach to).
//   2. Fork-per-drain statelessness. Production drains run in a fresh
//      child process each time (connectionsReconcileChild.entry.ts), so
//      the materializer's in-memory edge-pair diff baseline
//      (`lastIncrementalShadowEdgePairs`) is null on EVERY drain —
//      addedEdges/removedEdges are always empty, so the one path that
//      can BIRTH a topic from an empty base (a mutually-new edge) never
//      fires in production.
//
// FIX — persist the producer's own output state and carry it across
// cycles, entirely OUTSIDE the protected file (same store-wrapper seam
// as topicProductionRevival.ts / #404):
//
//   - The carried state is a schema-versioned artifact under the
//     connections dir: `_BAC/connections/topics/incremental-state/
//     state.v1.json` (membership content, rewritten ONLY when the
//     membership fingerprint changes) + `cursor.v1.json` (the volatile
//     revision ids, tiny, rewritten when the revision id advances).
//     The split follows PR #412's embed-lane cursor gate: volatile
//     identifiers never force a rewrite of the heavy content file, and
//     the change gate NEVER includes volatile timestamps
//     (producedAt / lineage.observedAt / metadata observation times are
//     all excluded from the fingerprint — PR #391's diff-aware
//     putCurrent rule).
//   - Read path: the carried revision (content + cursor-patched ids) is
//     served as the shadow's prior. An EMPTY persisted prior is treated
//     as ABSENT — that single rule breaks the sticky-empty trap. With no
//     carried state, the wrapper seeds from the first populated
//     cycle-legit artifact (the legacy candidate slot, then the served
//     active revision) — never from a backlog scan (W7: a content-lane
//     -only drain must add zero full-log reads; this module does no
//     event-log I/O at all).
//   - Write path: `recordCycleResult` classifies each cycle —
//     adopt (first populated state, marked partial), update (membership
//     changed), cursor-only (membership identical, ids advanced),
//     collapse-suspect (empty result over a populated prior — the #404
//     collapse-guard semantics extended to the shadow lane: state and
//     slot keep the prior; the emptiness is VISIBLE in the parity mark,
//     never silently persisted), observe-empty (empty over empty —
//     legitimate fresh-vault silence).
//
// `partial` semantics: a state is partial until its member count reaches
// the served active revision's member count (coverage parity with
// serving). Recomputed at every content write — it is a live coverage
// report for the leiden→incremental flip gate, not a sticky bit. A
// partial state that grows toward completeness across drains is expected
// (the brief's contract); the state NEVER bootstraps via a backlog scan.
//
// Known accepted lag: on cursor-only cycles the legacy candidate-shadow
// slot file keeps its previous revisionId (workGraphHealth reads that
// file raw); the slot content is still the correct carried membership.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createRevision } from '../domain/ids.js';
import {
  parseTopicRevision,
  type TopicRevision,
} from '../producers/topic-revision.js';
import { sha256Base64UrlPrefix } from './topicId.js';

export const INCREMENTAL_TOPIC_STATE_SCHEMA_VERSION = 1;

export const incrementalTopicStateDir = (vaultRoot: string): string =>
  join(vaultRoot, '_BAC', 'connections', 'topics', 'incremental-state');

export const incrementalTopicStatePath = (vaultRoot: string): string =>
  join(incrementalTopicStateDir(vaultRoot), 'state.v1.json');

export const incrementalTopicStateCursorPath = (vaultRoot: string): string =>
  join(incrementalTopicStateDir(vaultRoot), 'cursor.v1.json');

/** Where the initial (partial) state was seeded from — forensics only. */
export type IncrementalTopicStateSeedSource =
  | 'state'
  | 'legacy-slot'
  | 'active-leiden'
  | 'none';

export type IncrementalTopicStateAction =
  | 'adopt'
  | 'update'
  | 'cursor-only'
  | 'collapse-suspect'
  | 'observe-empty';

export interface IncrementalTopicStateDecision {
  readonly action: IncrementalTopicStateAction;
  /** True when a populated carried state existed before this cycle. */
  readonly carried: boolean;
  readonly priorTopicCount: number;
  readonly priorMemberCount: number;
  /** url→topic placements added + removed + moved vs the carried prior. */
  readonly membershipDelta: number;
  /** Coverage vs the served active revision (see module header). */
  readonly partial: boolean;
  readonly stateWritten: boolean;
  readonly cursorWritten: boolean;
}

export interface RecordCycleContext {
  /** The served active revision at write time (coverage baseline). */
  readonly activeRevision: TopicRevision | null;
  /** What the read path served as this cycle's prior (forensics). */
  readonly seedSource: IncrementalTopicStateSeedSource;
}

export interface IncrementalTopicStateCarry {
  /**
   * The carried prior for the shadow lane: persisted membership content
   * with the cursor's (newer) revision ids applied. Null until a
   * populated state exists — an empty persisted state is treated as
   * absent by construction (it is never written).
   */
  readonly readCarriedRevision: () => Promise<TopicRevision | null>;
  /** Fold one cycle's incremental build output into the carried state. */
  readonly recordCycleResult: (
    incoming: TopicRevision,
    context: RecordCycleContext,
  ) => Promise<IncrementalTopicStateDecision>;
}

export interface IncrementalTopicStateCarryOptions {
  /** Test seam — swap in a spy instead of console.warn. */
  readonly log?: (line: string) => void;
}

// -- fingerprint + delta (pure) -----------------------------------------

const compareString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Membership fingerprint over the NON-volatile topic structure only:
 * algorithmVersion, cosineThreshold, and per-topic (topicId, sorted
 * primary members, sorted secondary-affiliation urls). Deliberately
 * excludes revisionId / visitSimilarityRevisionId (advance with every
 * corpus change even when membership is identical), producedAt,
 * lineage (its observedAt entries are minted at build time), and topic
 * metadata (observation timestamps refresh without membership change).
 * Gated content must never include volatile timestamps — the #391/#412
 * idle-write rule.
 */
export const computeTopicMembershipFingerprint = async (
  revision: TopicRevision,
): Promise<string> => {
  const lines: string[] = [revision.algorithmVersion, String(revision.cosineThreshold)];
  const topics = [...revision.topics].sort((a, b) => compareString(a.topicId, b.topicId));
  for (const topic of topics) {
    lines.push(`t ${topic.topicId}`);
    for (const member of [...topic.memberCanonicalUrls].sort(compareString)) {
      lines.push(`m ${member}`);
    }
    for (const affiliation of [...(topic.secondaryAffiliations ?? [])]
      .map((entry) => entry.canonicalUrl)
      .sort(compareString)) {
      lines.push(`s ${affiliation}`);
    }
  }
  return sha256Base64UrlPrefix(lines.join('\n'));
};

/** Count of url→topic primary placements added, removed, or moved. */
export const computeMembershipDelta = (
  prior: TopicRevision | null,
  incoming: TopicRevision,
): number => {
  const placements = (revision: TopicRevision | null): Map<string, string> => {
    const map = new Map<string, string>();
    if (revision === null) return map;
    for (const topic of revision.topics) {
      for (const member of topic.memberCanonicalUrls) map.set(member, topic.topicId);
    }
    return map;
  };
  const before = placements(prior);
  const after = placements(incoming);
  let delta = 0;
  for (const [url, topicId] of after) {
    if (before.get(url) !== topicId) delta += 1;
  }
  for (const url of before.keys()) {
    if (!after.has(url)) delta += 1;
  }
  return delta;
};

const memberCount = (revision: TopicRevision | null): number =>
  revision === null
    ? 0
    : revision.topics.reduce((sum, topic) => sum + topic.memberCanonicalUrls.length, 0);

// -- persistence --------------------------------------------------------

interface StateFileV1 {
  readonly schemaVersion: number;
  readonly partial: boolean;
  readonly seededFrom: string;
  readonly contentHash: string;
  readonly revision: TopicRevision;
}

interface CursorFileV1 {
  readonly schemaVersion: number;
  readonly contentHash: string;
  readonly revisionId: string;
  readonly visitSimilarityRevisionId: string;
  readonly producedAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseStateFile = (value: unknown): StateFileV1 | null => {
  if (!isRecord(value)) return null;
  if (value['schemaVersion'] !== INCREMENTAL_TOPIC_STATE_SCHEMA_VERSION) return null;
  if (typeof value['partial'] !== 'boolean') return null;
  if (typeof value['seededFrom'] !== 'string') return null;
  if (typeof value['contentHash'] !== 'string' || value['contentHash'].length === 0) return null;
  const revision = parseTopicRevision(value['revision']);
  if (revision === null) return null;
  return {
    schemaVersion: INCREMENTAL_TOPIC_STATE_SCHEMA_VERSION,
    partial: value['partial'],
    seededFrom: value['seededFrom'],
    contentHash: value['contentHash'],
    revision,
  };
};

const parseCursorFile = (value: unknown): CursorFileV1 | null => {
  if (!isRecord(value)) return null;
  if (value['schemaVersion'] !== INCREMENTAL_TOPIC_STATE_SCHEMA_VERSION) return null;
  if (typeof value['contentHash'] !== 'string' || value['contentHash'].length === 0) return null;
  if (typeof value['revisionId'] !== 'string' || value['revisionId'].length === 0) return null;
  if (typeof value['visitSimilarityRevisionId'] !== 'string') return null;
  if (typeof value['producedAt'] !== 'number' || !Number.isFinite(value['producedAt'])) {
    return null;
  }
  return {
    schemaVersion: INCREMENTAL_TOPIC_STATE_SCHEMA_VERSION,
    contentHash: value['contentHash'],
    revisionId: value['revisionId'],
    visitSimilarityRevisionId: value['visitSimilarityRevisionId'],
    producedAt: value['producedAt'],
  };
};

interface LoadedState {
  readonly file: StateFileV1;
  /** Effective ids after cursor application (== file's when no cursor). */
  readonly revisionId: string;
  readonly visitSimilarityRevisionId: string;
  readonly producedAt: number;
}

export const createIncrementalTopicStateCarry = (
  vaultRoot: string,
  options: IncrementalTopicStateCarryOptions = {},
): IncrementalTopicStateCarry => {
  const log = options.log ?? ((line: string) => console.warn(line));
  const statePath = incrementalTopicStatePath(vaultRoot);
  const cursorPath = incrementalTopicStateCursorPath(vaultRoot);

  // In-memory memo. `undefined` = disk not consulted yet (boot);
  // `null` = consulted, no usable state. Production drains run in
  // fork-per-drain children, so in practice this is one disk read per
  // drain — the memo mostly serves the read→write pair within a drain.
  let loaded: LoadedState | null | undefined;

  const writeAtomic = async (path: string, body: string): Promise<void> => {
    await mkdir(incrementalTopicStateDir(vaultRoot), { recursive: true });
    const tmp = `${path}.${createRevision()}.tmp`;
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, path);
  };

  const readJson = async (path: string): Promise<unknown> => {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch {
      return null;
    }
  };

  const load = async (): Promise<LoadedState | null> => {
    if (loaded !== undefined) return loaded;
    const rawState = await readJson(statePath);
    if (rawState === null) {
      loaded = null;
      return loaded;
    }
    const file = parseStateFile(rawState);
    if (file === null) {
      log(
        `[topic.state] ignored ${statePath} (unparseable or schemaVersion != ${String(
          INCREMENTAL_TOPIC_STATE_SCHEMA_VERSION,
        )}) — treating as absent`,
      );
      loaded = null;
      return loaded;
    }
    if (file.revision.topics.length === 0) {
      // Never written by this module; guard against hand-edited or torn
      // state resurrecting the sticky-empty trap this module exists to kill.
      log(`[topic.state] ignored ${statePath} (empty topic set) — treating as absent`);
      loaded = null;
      return loaded;
    }
    const cursor = parseCursorFile(await readJson(cursorPath));
    const cursorApplies =
      cursor !== null &&
      cursor.contentHash === file.contentHash &&
      cursor.producedAt >= file.revision.producedAt;
    loaded = {
      file,
      revisionId: cursorApplies ? cursor.revisionId : file.revision.revisionId,
      visitSimilarityRevisionId: cursorApplies
        ? cursor.visitSimilarityRevisionId
        : file.revision.visitSimilarityRevisionId,
      producedAt: cursorApplies ? cursor.producedAt : file.revision.producedAt,
    };
    log(
      `[topic.state] loaded topics=${String(file.revision.topics.length)} ` +
        `members=${String(memberCount(file.revision))} partial=${String(file.partial)} ` +
        `cursorApplied=${String(cursorApplies)} revision=${loaded.revisionId}`,
    );
    return loaded;
  };

  const carriedRevision = (state: LoadedState): TopicRevision => ({
    ...state.file.revision,
    revisionId: state.revisionId,
    visitSimilarityRevisionId: state.visitSimilarityRevisionId,
    producedAt: state.producedAt,
  });

  const readCarriedRevision = async (): Promise<TopicRevision | null> => {
    const state = await load();
    return state === null ? null : carriedRevision(state);
  };

  const writeState = async (
    incoming: TopicRevision,
    contentHash: string,
    partial: boolean,
    seededFrom: string,
  ): Promise<void> => {
    const file: StateFileV1 = {
      schemaVersion: INCREMENTAL_TOPIC_STATE_SCHEMA_VERSION,
      partial,
      seededFrom,
      contentHash,
      revision: incoming,
    };
    await writeAtomic(statePath, JSON.stringify(file, null, 2));
    loaded = {
      file,
      revisionId: incoming.revisionId,
      visitSimilarityRevisionId: incoming.visitSimilarityRevisionId,
      producedAt: incoming.producedAt,
    };
  };

  const writeCursor = async (incoming: TopicRevision, contentHash: string): Promise<void> => {
    const cursor: CursorFileV1 = {
      schemaVersion: INCREMENTAL_TOPIC_STATE_SCHEMA_VERSION,
      contentHash,
      revisionId: incoming.revisionId,
      visitSimilarityRevisionId: incoming.visitSimilarityRevisionId,
      producedAt: incoming.producedAt,
    };
    await writeAtomic(cursorPath, JSON.stringify(cursor, null, 2));
  };

  const recordCycleResult = async (
    incoming: TopicRevision,
    context: RecordCycleContext,
  ): Promise<IncrementalTopicStateDecision> => {
    const prior = await load();
    const priorTopicCount = prior?.file.revision.topics.length ?? 0;
    const priorMemberCount = prior === null ? 0 : memberCount(prior.file.revision);
    const carried = prior !== null;

    if (incoming.topics.length === 0) {
      if (carried) {
        // #404 collapse-guard semantics on the shadow lane: an empty
        // build over a populated carried state is NEVER persisted — the
        // prior stays, and the caller surfaces collapse-suspect=true in
        // the parity mark.
        return {
          action: 'collapse-suspect',
          carried,
          priorTopicCount,
          priorMemberCount,
          membershipDelta: priorMemberCount,
          partial: prior.file.partial,
          stateWritten: false,
          cursorWritten: false,
        };
      }
      return {
        action: 'observe-empty',
        carried: false,
        priorTopicCount: 0,
        priorMemberCount: 0,
        membershipDelta: 0,
        partial: true,
        stateWritten: false,
        cursorWritten: false,
      };
    }

    const contentHash = await computeTopicMembershipFingerprint(incoming);
    const incomingMembers = memberCount(incoming);
    const activeMembers = memberCount(context.activeRevision);
    const partial = !(activeMembers > 0 && incomingMembers >= activeMembers);
    const coverage = `${String(incomingMembers)}/${String(activeMembers)}`;

    if (prior === null) {
      await writeState(incoming, contentHash, partial, context.seedSource);
      log(
        `[topic.state] adopted topics=${String(incoming.topics.length)} ` +
          `members=${String(incomingMembers)} partial=${String(partial)} ` +
          `coverage=${coverage} seed=${context.seedSource} revision=${incoming.revisionId}`,
      );
      return {
        action: 'adopt',
        carried: false,
        priorTopicCount: 0,
        priorMemberCount: 0,
        membershipDelta: incomingMembers,
        partial,
        stateWritten: true,
        cursorWritten: false,
      };
    }

    if (contentHash === prior.file.contentHash) {
      const cursorWritten = incoming.revisionId !== prior.revisionId;
      if (cursorWritten) {
        await writeCursor(incoming, contentHash);
        loaded = {
          file: prior.file,
          revisionId: incoming.revisionId,
          visitSimilarityRevisionId: incoming.visitSimilarityRevisionId,
          producedAt: incoming.producedAt,
        };
        log(
          `[topic.state] cursor revision=${incoming.revisionId} ` +
            `(membership unchanged, state rewrite skipped)`,
        );
      }
      return {
        action: 'cursor-only',
        carried: true,
        priorTopicCount,
        priorMemberCount,
        membershipDelta: 0,
        partial,
        stateWritten: false,
        cursorWritten,
      };
    }

    const membershipDelta = computeMembershipDelta(prior.file.revision, incoming);
    await writeState(incoming, contentHash, partial, prior.file.seededFrom);
    log(
      `[topic.state] wrote topics=${String(incoming.topics.length)} ` +
        `members=${String(incomingMembers)} partial=${String(partial)} ` +
        `coverage=${coverage} delta=${String(membershipDelta)} revision=${incoming.revisionId}`,
    );
    return {
      action: 'update',
      carried: true,
      priorTopicCount,
      priorMemberCount,
      membershipDelta,
      partial,
      stateWritten: true,
      cursorWritten: false,
    };
  };

  return { readCarriedRevision, recordCycleResult };
};

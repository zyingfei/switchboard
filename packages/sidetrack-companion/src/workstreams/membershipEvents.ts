// Multi-membership event pair — Phase 1 of
// docs/plans/2026-08-16-category-flexibility-hyde.md §1.
//
// Today every subject (a canonical URL, a chat thread, a tab session) can
// belong to at most one workstream: `Thread.primaryWorkstreamId`,
// `TabSessionAttribution.workstreamId`, `UrlAttribution.workstreamId` are
// each a single scalar register. `workstream.membership.set` /
// `workstream.membership.removed` generalize that to 1-to-many: a subject
// may carry any number of `role: 'secondary'` membership rows alongside at
// most one `role: 'primary'` row.
//
// FOLD SEMANTICS — latest-wins PER (subjectId, workstreamId) PAIR, not a
// full causal `mergeRegister` conflict fold. Copied in spirit from
// `declineMemory.ts`'s per-URL latest-wins accumulator and
// `workstreamParentStore.ts`'s `isNewer`, just keyed on the pair instead of
// the bare subject. The tie-break compares the full (acceptedAtMs,
// replicaId, seq) tuple — workstreamParentStore's stronger 3-part
// comparator, not declineMemory's 2-part one — so the fold is deterministic
// and convergent regardless of ingest order even when two replicas accept
// events in the same millisecond.
//
// PRIMARY INVARIANT — at most one row per subject may carry `role:
// 'primary'`. This is a FOLD-TIME invariant, not a write-time lock: any
// number of `role: 'primary'` SET events may exist across different
// workstreamIds for the same subject (concurrent replicas can each file the
// same subject as primary into a different workstream before syncing); the
// fold demotes every row but the one whose winning SET event has the
// greatest (acceptedAtMs, replicaId, seq) tuple to `role: 'secondary'`.
// CRDT-safe the same way `workstreams/projection.ts`'s `mergeRegister`-based
// register folds are: replaying the same event set in any order converges
// to the same result.
import type { AcceptedEvent, Dot } from '../sync/causal.js';

export const WORKSTREAM_MEMBERSHIP_SET = 'workstream.membership.set' as const;
export const WORKSTREAM_MEMBERSHIP_REMOVED = 'workstream.membership.removed' as const;

export type WorkstreamMembershipEventType =
  | typeof WORKSTREAM_MEMBERSHIP_SET
  | typeof WORKSTREAM_MEMBERSHIP_REMOVED;

export const MEMBERSHIP_SUBJECT_KINDS = ['canonical-url', 'thread', 'tab-session'] as const;
export type MembershipSubjectKind = (typeof MEMBERSHIP_SUBJECT_KINDS)[number];

export const MEMBERSHIP_ROLES = ['primary', 'secondary'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const MEMBERSHIP_PROVENANCES = [
  'user-filed',
  'ai-suggested-accepted',
  'prototype-matched',
] as const;
export type MembershipProvenance = (typeof MEMBERSHIP_PROVENANCES)[number];

export const MEMBERSHIP_REMOVED_REASONS = ['user-declined', 'user-removed', 'superseded'] as const;
export type MembershipRemovedReason = (typeof MEMBERSHIP_REMOVED_REASONS)[number];

const LANE_OPPORTUNITY_ID_PATTERN = /^laneopp_[0-9a-f]{32}$/u;

export interface WorkstreamMembershipSetPayload {
  readonly payloadVersion: 1;
  readonly subjectKind: MembershipSubjectKind;
  readonly subjectId: string;
  readonly workstreamId: string;
  readonly role: MembershipRole;
  readonly provenance: MembershipProvenance;
  /** Ties this membership back to a served lane/opportunity, when one exists. */
  readonly sourceOpportunityId?: string;
}

export interface WorkstreamMembershipRemovedPayload {
  readonly payloadVersion: 1;
  readonly subjectKind: MembershipSubjectKind;
  readonly subjectId: string;
  readonly workstreamId: string;
  readonly reason: MembershipRemovedReason;
  readonly sourceOpportunityId?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isOptionalOpportunityId = (value: unknown): value is string | undefined =>
  value === undefined || (typeof value === 'string' && LANE_OPPORTUNITY_ID_PATTERN.test(value));

const SUBJECT_KINDS: ReadonlySet<string> = new Set(MEMBERSHIP_SUBJECT_KINDS);
const ROLES: ReadonlySet<string> = new Set(MEMBERSHIP_ROLES);
const PROVENANCES: ReadonlySet<string> = new Set(MEMBERSHIP_PROVENANCES);
const REMOVED_REASONS: ReadonlySet<string> = new Set(MEMBERSHIP_REMOVED_REASONS);

const isSubjectKind = (value: unknown): value is MembershipSubjectKind =>
  typeof value === 'string' && SUBJECT_KINDS.has(value);

const isRole = (value: unknown): value is MembershipRole =>
  typeof value === 'string' && ROLES.has(value);

const isProvenance = (value: unknown): value is MembershipProvenance =>
  typeof value === 'string' && PROVENANCES.has(value);

const isRemovedReason = (value: unknown): value is MembershipRemovedReason =>
  typeof value === 'string' && REMOVED_REASONS.has(value);

export const isWorkstreamMembershipSetPayload = (
  value: unknown,
): value is WorkstreamMembershipSetPayload =>
  isRecord(value) &&
  value['payloadVersion'] === 1 &&
  isSubjectKind(value['subjectKind']) &&
  isNonEmptyString(value['subjectId']) &&
  isNonEmptyString(value['workstreamId']) &&
  isRole(value['role']) &&
  isProvenance(value['provenance']) &&
  isOptionalOpportunityId(value['sourceOpportunityId']);

export const isWorkstreamMembershipRemovedPayload = (
  value: unknown,
): value is WorkstreamMembershipRemovedPayload =>
  isRecord(value) &&
  value['payloadVersion'] === 1 &&
  isSubjectKind(value['subjectKind']) &&
  isNonEmptyString(value['subjectId']) &&
  isNonEmptyString(value['workstreamId']) &&
  isRemovedReason(value['reason']) &&
  isOptionalOpportunityId(value['sourceOpportunityId']);

/** Deterministic aggregate id for the two membership event types — one causal
 * stream per (subjectKind, subjectId, workstreamId) pair, matching the fold's
 * own key. */
export const membershipAggregateId = (
  subjectKind: MembershipSubjectKind,
  subjectId: string,
  workstreamId: string,
): string => `workstream-membership:${subjectKind}:${subjectId}:${workstreamId}`;

// ---- fold ---------------------------------------------------------------

export interface WorkstreamMembershipRow {
  readonly subjectKind: MembershipSubjectKind;
  readonly subjectId: string;
  readonly workstreamId: string;
  /** Undefined when `deleted` (a removed pair has no role). */
  readonly role?: MembershipRole;
  readonly provenance?: MembershipProvenance;
  readonly deleted: boolean;
  readonly sourceOpportunityId?: string;
  readonly acceptedAtMs: number;
  readonly dot: Dot;
}

const orderTuple = (event: AcceptedEvent): readonly [number, string, number] => [
  event.acceptedAtMs,
  event.dot.replicaId,
  event.dot.seq,
];

// True when `candidate` strictly follows `incumbent` in the (acceptedAtMs,
// replicaId, seq) order — the SAME deterministic, order-independent
// comparator `workstreamParentStore.ts`'s `isNewer` uses.
const isNewerTuple = (
  candidate: readonly [number, string, number],
  incumbent: readonly [number, string, number] | undefined,
): boolean => {
  if (incumbent === undefined) return true;
  if (candidate[0] !== incumbent[0]) return candidate[0] > incumbent[0];
  if (candidate[1] !== incumbent[1]) return candidate[1] > incumbent[1];
  return candidate[2] > incumbent[2];
};

const isRelevant = (
  event: AcceptedEvent,
  subjectKind: MembershipSubjectKind,
  subjectId: string,
): event is AcceptedEvent<WorkstreamMembershipSetPayload | WorkstreamMembershipRemovedPayload> => {
  if (event.type === WORKSTREAM_MEMBERSHIP_SET) {
    return (
      isWorkstreamMembershipSetPayload(event.payload) &&
      event.payload.subjectKind === subjectKind &&
      event.payload.subjectId === subjectId
    );
  }
  if (event.type === WORKSTREAM_MEMBERSHIP_REMOVED) {
    return (
      isWorkstreamMembershipRemovedPayload(event.payload) &&
      event.payload.subjectKind === subjectKind &&
      event.payload.subjectId === subjectId
    );
  }
  return false;
};

/**
 * Fold one subject's COMPLETE membership-event history into one row per
 * workstreamId ever mentioned for it (latest-wins per pair), then apply the
 * cross-pair "at most one primary" invariant. Pure and order-independent —
 * pass the subject's full stored bucket (see `workstreamMembershipStore.ts`),
 * never a partial drain window, for the same reason
 * `threads/threadRegisterStore.ts` recomputes from a complete per-subject
 * bucket rather than an incremental single-row cache.
 */
export const foldWorkstreamMembership = (
  subjectKind: MembershipSubjectKind,
  subjectId: string,
  events: readonly AcceptedEvent[],
): readonly WorkstreamMembershipRow[] => {
  const relevant = events.filter((event) => isRelevant(event, subjectKind, subjectId));

  // Per-pair latest-wins.
  const winnerByWorkstream = new Map<
    string,
    { readonly event: AcceptedEvent; readonly tuple: readonly [number, string, number] }
  >();
  for (const event of relevant) {
    const payload = event.payload as
      | WorkstreamMembershipSetPayload
      | WorkstreamMembershipRemovedPayload;
    const tuple = orderTuple(event);
    const incumbent = winnerByWorkstream.get(payload.workstreamId);
    if (isNewerTuple(tuple, incumbent?.tuple)) {
      winnerByWorkstream.set(payload.workstreamId, { event, tuple });
    }
  }

  const rows: WorkstreamMembershipRow[] = [];
  let currentPrimary: { readonly workstreamId: string; readonly tuple: readonly [number, string, number] } | undefined;
  for (const [workstreamId, winner] of winnerByWorkstream) {
    const isSet = winner.event.type === WORKSTREAM_MEMBERSHIP_SET;
    const payload = winner.event.payload as
      | WorkstreamMembershipSetPayload
      | WorkstreamMembershipRemovedPayload;
    const row: WorkstreamMembershipRow = {
      subjectKind,
      subjectId,
      workstreamId,
      deleted: !isSet,
      acceptedAtMs: winner.event.acceptedAtMs,
      dot: winner.event.dot,
      ...(isSet ? { role: (payload as WorkstreamMembershipSetPayload).role } : {}),
      ...(isSet ? { provenance: (payload as WorkstreamMembershipSetPayload).provenance } : {}),
      ...(payload.sourceOpportunityId === undefined
        ? {}
        : { sourceOpportunityId: payload.sourceOpportunityId }),
    };
    rows.push(row);
    if (isSet && row.role === 'primary' && isNewerTuple(winner.tuple, currentPrimary?.tuple)) {
      currentPrimary = { workstreamId, tuple: winner.tuple };
    }
  }

  // Demote every non-winning primary. `currentPrimary` is undefined when no
  // row is primary at all (subject filed only into secondary workstreams, or
  // never filed).
  const demoted = rows.map((row) =>
    row.role === 'primary' && row.workstreamId !== currentPrimary?.workstreamId
      ? { ...row, role: 'secondary' as const }
      : row,
  );

  return demoted.sort((a, b) => (a.workstreamId < b.workstreamId ? -1 : a.workstreamId > b.workstreamId ? 1 : 0));
};

/** Active (non-deleted) rows only — the common read shape for "which
 * workstreams is this subject currently in". */
export const activeMembershipRows = (
  rows: readonly WorkstreamMembershipRow[],
): readonly WorkstreamMembershipRow[] => rows.filter((row) => !row.deleted);

/** The single `role: 'primary'` row, if any — the derived replacement for
 * `Thread.primaryWorkstreamId` / `TabSessionAttribution.workstreamId` /
 * `UrlAttribution.workstreamId`. */
export const primaryMembershipRow = (
  rows: readonly WorkstreamMembershipRow[],
): WorkstreamMembershipRow | undefined =>
  rows.find((row) => !row.deleted && row.role === 'primary');

/**
 * Fold ACTIVE membership rows for EVERY subject present in `events` at
 * once — one bucketing pass over the raw membership-event set, then one
 * cheap `foldWorkstreamMembership` call per subject over ONLY that
 * subject's own bucket (never the full event set per subject). Built for
 * list-view routes (e.g. `/v1/visits/inbox`, `/v1/visits/projection`) that
 * need membership chips for many subjects from a single batched read —
 * calling `foldWorkstreamMembership` once per item against the complete
 * event list would be O(subjects × events).
 */
export const foldAllActiveMemberships = (
  subjectKind: MembershipSubjectKind,
  events: readonly AcceptedEvent[],
): ReadonlyMap<string, readonly WorkstreamMembershipRow[]> => {
  const bySubject = new Map<string, AcceptedEvent[]>();
  for (const event of events) {
    let subjectId: string | undefined;
    if (event.type === WORKSTREAM_MEMBERSHIP_SET) {
      if (isWorkstreamMembershipSetPayload(event.payload) && event.payload.subjectKind === subjectKind) {
        subjectId = event.payload.subjectId;
      }
    } else if (event.type === WORKSTREAM_MEMBERSHIP_REMOVED) {
      if (
        isWorkstreamMembershipRemovedPayload(event.payload) &&
        event.payload.subjectKind === subjectKind
      ) {
        subjectId = event.payload.subjectId;
      }
    }
    if (subjectId === undefined) continue;
    const bucket = bySubject.get(subjectId);
    if (bucket === undefined) bySubject.set(subjectId, [event]);
    else bucket.push(event);
  }
  const out = new Map<string, readonly WorkstreamMembershipRow[]>();
  for (const [subjectId, subjectEvents] of bySubject) {
    out.set(
      subjectId,
      activeMembershipRows(foldWorkstreamMembership(subjectKind, subjectId, subjectEvents)),
    );
  }
  return out;
};

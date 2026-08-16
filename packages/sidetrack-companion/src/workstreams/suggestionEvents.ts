// Suggestion accept/decline event pair — Phase 1 of docs/plans/2026-08-16-
// category-flexibility-hyde.md §2 and §5.
//
// Fills a real gap: today there is no explicit accept event at all
// (acceptance is only ever inferred when a later `USER_ORGANIZED_ITEM move`
// happens to agree with a served suggestion), and decline is silently
// overloaded onto `USER_ORGANIZED_ITEM{toContainer:null}` with no
// suggestion-source attribution
// (`docs/audits/2026-07-29-recommendation-graph-feature-review.md` E6/G5).
//
// `suggestionSource` names WHICH suggestion mechanism produced the offer.
// This PR only emits the two structural sources below (split / new-category,
// design §4); the type stays open enough for future lanes (e.g. a
// prototype-lane suggestion) to reuse the same event pair without a schema
// break — see the design's §2 table, "fills a real gap, not a duplicate".
import type { MembershipSubjectKind } from './membershipEvents.js';

export const SUGGESTION_SOURCES = ['workstream-split', 'workstream-new-category'] as const;
export type SuggestionSource = (typeof SUGGESTION_SOURCES)[number];

export const SUGGESTION_ACCEPTED = 'workstream.suggestion.accepted' as const;
export const SUGGESTION_DECLINED = 'workstream.suggestion.declined' as const;

export type SuggestionEventType = typeof SUGGESTION_ACCEPTED | typeof SUGGESTION_DECLINED;

const LANE_OPPORTUNITY_ID_PATTERN = /^laneopp_[0-9a-f]{32}$/u;

export interface SuggestionAcceptedPayload {
  readonly payloadVersion: 1;
  readonly suggestionSource: SuggestionSource;
  readonly subjectKind: MembershipSubjectKind;
  readonly subjectId: string;
  readonly workstreamId: string;
  readonly servedOpportunityId?: string;
}

export interface SuggestionDeclinedPayload {
  readonly payloadVersion: 1;
  readonly suggestionSource: SuggestionSource;
  readonly subjectKind: MembershipSubjectKind;
  readonly subjectId: string;
  readonly workstreamId: string;
  readonly servedOpportunityId?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isOptionalOpportunityId = (value: unknown): value is string | undefined =>
  value === undefined || (typeof value === 'string' && LANE_OPPORTUNITY_ID_PATTERN.test(value));

const SUBJECT_KINDS: ReadonlySet<string> = new Set(['canonical-url', 'thread', 'tab-session']);
const SOURCES: ReadonlySet<string> = new Set(SUGGESTION_SOURCES);

const isSubjectKind = (value: unknown): value is MembershipSubjectKind =>
  typeof value === 'string' && SUBJECT_KINDS.has(value);

const isSuggestionSource = (value: unknown): value is SuggestionSource =>
  typeof value === 'string' && SOURCES.has(value);

const isSuggestionPayloadShape = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) &&
  value['payloadVersion'] === 1 &&
  isSuggestionSource(value['suggestionSource']) &&
  isSubjectKind(value['subjectKind']) &&
  isNonEmptyString(value['subjectId']) &&
  isNonEmptyString(value['workstreamId']) &&
  isOptionalOpportunityId(value['servedOpportunityId']);

export const isSuggestionAcceptedPayload = (value: unknown): value is SuggestionAcceptedPayload =>
  isSuggestionPayloadShape(value);

export const isSuggestionDeclinedPayload = (value: unknown): value is SuggestionDeclinedPayload =>
  isSuggestionPayloadShape(value);

export const suggestionAggregateId = (
  suggestionSource: SuggestionSource,
  subjectKind: MembershipSubjectKind,
  subjectId: string,
  workstreamId: string,
): string => `workstream-suggestion:${suggestionSource}:${subjectKind}:${subjectId}:${workstreamId}`;

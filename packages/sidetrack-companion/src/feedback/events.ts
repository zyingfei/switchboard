import { ENGAGEMENT_CLASSES, type EngagementClass } from '../connections/engagementClassifier.js';

export const USER_ORGANIZED_ITEM = 'user.organized.item' as const;
export const USER_ENGAGEMENT_RELABELED = 'user.engagement.relabeled' as const;
export const USER_FLOW_CONFIRMED = 'user.flow.confirmed' as const;
export const USER_FLOW_REJECTED = 'user.flow.rejected' as const;
export const USER_TOPIC_RENAMED = 'user.topic.renamed' as const;
export const USER_SNIPPET_PROMOTED = 'user.snippet.promoted' as const;

export const FEEDBACK_EVENT_TYPES = [
  USER_ORGANIZED_ITEM,
  USER_ENGAGEMENT_RELABELED,
  USER_FLOW_CONFIRMED,
  USER_FLOW_REJECTED,
  USER_TOPIC_RENAMED,
  USER_SNIPPET_PROMOTED,
] as const;

export type FeedbackEventType = (typeof FEEDBACK_EVENT_TYPES)[number];

export const USER_ORGANIZED_ITEM_KINDS = [
  'thread',
  'workstream',
  'visit',
  'topic',
  'snippet',
] as const;

export type UserOrganizedItemKind = (typeof USER_ORGANIZED_ITEM_KINDS)[number];

export const USER_ORGANIZED_ITEM_ACTIONS = [
  'move',
  'merge',
  'split',
  'rename',
  'promote',
  'ignore',
] as const;

export type UserOrganizedItemAction = (typeof USER_ORGANIZED_ITEM_ACTIONS)[number];

export interface UserOrganizedItemDetails {
  readonly rename?: string;
  readonly mergeMembers?: readonly string[];
  readonly splitInto?: readonly string[];
}

export interface UserOrganizedItemPayload {
  readonly payloadVersion: 1;
  readonly itemKind: UserOrganizedItemKind;
  readonly itemId: string;
  readonly action: UserOrganizedItemAction;
  readonly fromContainer?: string;
  readonly toContainer?: string;
  readonly details?: UserOrganizedItemDetails;
}

export interface UserEngagementRelabeledPayload {
  readonly payloadVersion: 1;
  readonly visitId: string;
  readonly fromClass: EngagementClass;
  readonly toClass: EngagementClass;
}

export const USER_FLOW_RELATION_KINDS = [
  'closest_visit',
  'visit_resembles_visit',
  'visit_continues_visit',
] as const;

export type UserFlowRelationKind = (typeof USER_FLOW_RELATION_KINDS)[number];

export interface UserFlowConfirmedPayload {
  readonly payloadVersion: 1;
  readonly relationKind: UserFlowRelationKind;
  readonly fromId: string;
  readonly toId: string;
}

export const USER_FLOW_REJECTION_REASONS = [
  'not-related',
  'wrong-order',
  'stale',
  'duplicate',
  'other',
] as const;

export type UserFlowRejectionReason = (typeof USER_FLOW_REJECTION_REASONS)[number];

export interface UserFlowRejectedPayload {
  readonly payloadVersion: 1;
  readonly relationKind: UserFlowRelationKind;
  readonly fromId: string;
  readonly toId: string;
  readonly reason?: UserFlowRejectionReason;
}

export const USER_TOPIC_RENAME_SOURCES = ['inline', 'bulk-edit', 'import'] as const;

export type UserTopicRenameSource = (typeof USER_TOPIC_RENAME_SOURCES)[number];

export interface UserTopicRenamedPayload {
  readonly payloadVersion: 1;
  readonly topicId: string;
  readonly previousName: string;
  readonly newName: string;
  readonly source: UserTopicRenameSource;
}

export const USER_SNIPPET_PROMOTION_TARGET_KINDS = [
  'source',
  'note',
  'thread',
  'workstream',
] as const;

export type UserSnippetPromotionTargetKind = (typeof USER_SNIPPET_PROMOTION_TARGET_KINDS)[number];

export interface UserSnippetPromotedPayload {
  readonly payloadVersion: 1;
  readonly snippetId: string;
  readonly targetKind: UserSnippetPromotionTargetKind;
  readonly targetId: string;
  readonly sourceVisitId?: string;
}

export type FeedbackPayload =
  | UserOrganizedItemPayload
  | UserEngagementRelabeledPayload
  | UserFlowConfirmedPayload
  | UserFlowRejectedPayload
  | UserTopicRenamedPayload
  | UserSnippetPromotedPayload;

const ORGANIZED_ITEM_KINDS: ReadonlySet<string> = new Set<string>(USER_ORGANIZED_ITEM_KINDS);
const ORGANIZED_ITEM_ACTIONS: ReadonlySet<string> = new Set<string>(USER_ORGANIZED_ITEM_ACTIONS);
const ENGAGEMENT_CLASS_VALUES: ReadonlySet<string> = new Set<string>(ENGAGEMENT_CLASSES);
const FLOW_RELATION_KINDS: ReadonlySet<string> = new Set<string>(USER_FLOW_RELATION_KINDS);
const FLOW_REJECTION_REASONS: ReadonlySet<string> = new Set<string>(USER_FLOW_REJECTION_REASONS);
const TOPIC_RENAME_SOURCES: ReadonlySet<string> = new Set<string>(USER_TOPIC_RENAME_SOURCES);
const SNIPPET_PROMOTION_TARGET_KINDS: ReadonlySet<string> = new Set<string>(
  USER_SNIPPET_PROMOTION_TARGET_KINDS,
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(isNonEmptyString);

const hasPayloadVersionAndNoDimensions = (value: Record<string, unknown>): boolean =>
  value['payloadVersion'] === 1 && value['dimensions'] === undefined;

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || isNonEmptyString(value);

const isOptionalStringArray = (value: unknown): value is readonly string[] | undefined =>
  value === undefined || isStringArray(value);

const isOrganizedItemKind = (value: unknown): value is UserOrganizedItemKind =>
  typeof value === 'string' && ORGANIZED_ITEM_KINDS.has(value);

const isOrganizedItemAction = (value: unknown): value is UserOrganizedItemAction =>
  typeof value === 'string' && ORGANIZED_ITEM_ACTIONS.has(value);

const isEngagementClass = (value: unknown): value is EngagementClass =>
  typeof value === 'string' && ENGAGEMENT_CLASS_VALUES.has(value);

const isFlowRelationKind = (value: unknown): value is UserFlowRelationKind =>
  typeof value === 'string' && FLOW_RELATION_KINDS.has(value);

const isOptionalFlowRejectionReason = (
  value: unknown,
): value is UserFlowRejectionReason | undefined =>
  value === undefined || (typeof value === 'string' && FLOW_REJECTION_REASONS.has(value));

const isTopicRenameSource = (value: unknown): value is UserTopicRenameSource =>
  typeof value === 'string' && TOPIC_RENAME_SOURCES.has(value);

const isSnippetPromotionTargetKind = (value: unknown): value is UserSnippetPromotionTargetKind =>
  typeof value === 'string' && SNIPPET_PROMOTION_TARGET_KINDS.has(value);

const isUserOrganizedItemDetails = (value: unknown): value is UserOrganizedItemDetails => {
  if (!isRecord(value)) return false;
  return (
    isOptionalString(value['rename']) &&
    isOptionalStringArray(value['mergeMembers']) &&
    isOptionalStringArray(value['splitInto'])
  );
};

const isOptionalUserOrganizedItemDetails = (
  value: unknown,
): value is UserOrganizedItemDetails | undefined =>
  value === undefined || isUserOrganizedItemDetails(value);

export const isUserOrganizedItemPayload = (value: unknown): value is UserOrganizedItemPayload =>
  isRecord(value) &&
  hasPayloadVersionAndNoDimensions(value) &&
  isOrganizedItemKind(value['itemKind']) &&
  isNonEmptyString(value['itemId']) &&
  isOrganizedItemAction(value['action']) &&
  isOptionalString(value['fromContainer']) &&
  isOptionalString(value['toContainer']) &&
  isOptionalUserOrganizedItemDetails(value['details']);

export const isUserEngagementRelabeledPayload = (
  value: unknown,
): value is UserEngagementRelabeledPayload =>
  isRecord(value) &&
  hasPayloadVersionAndNoDimensions(value) &&
  isNonEmptyString(value['visitId']) &&
  isEngagementClass(value['fromClass']) &&
  isEngagementClass(value['toClass']);

export const isUserFlowConfirmedPayload = (value: unknown): value is UserFlowConfirmedPayload =>
  isRecord(value) &&
  hasPayloadVersionAndNoDimensions(value) &&
  isFlowRelationKind(value['relationKind']) &&
  isNonEmptyString(value['fromId']) &&
  isNonEmptyString(value['toId']);

export const isUserFlowRejectedPayload = (value: unknown): value is UserFlowRejectedPayload =>
  isRecord(value) &&
  hasPayloadVersionAndNoDimensions(value) &&
  isFlowRelationKind(value['relationKind']) &&
  isNonEmptyString(value['fromId']) &&
  isNonEmptyString(value['toId']) &&
  isOptionalFlowRejectionReason(value['reason']);

export const isUserTopicRenamedPayload = (value: unknown): value is UserTopicRenamedPayload =>
  isRecord(value) &&
  hasPayloadVersionAndNoDimensions(value) &&
  isNonEmptyString(value['topicId']) &&
  isNonEmptyString(value['previousName']) &&
  isNonEmptyString(value['newName']) &&
  isTopicRenameSource(value['source']);

export const isUserSnippetPromotedPayload = (value: unknown): value is UserSnippetPromotedPayload =>
  isRecord(value) &&
  hasPayloadVersionAndNoDimensions(value) &&
  isNonEmptyString(value['snippetId']) &&
  isSnippetPromotionTargetKind(value['targetKind']) &&
  isNonEmptyString(value['targetId']) &&
  isOptionalString(value['sourceVisitId']);

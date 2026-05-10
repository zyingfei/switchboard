import { mintTabGroupLinkId } from './idMint';
import { createTabGroupOriginDetector, type TabGroupOriginDetector } from './originDetection';
import type { DurableTabGroupLink } from './reconciliation';

export type TabGroupFeedbackEvent =
  | {
      readonly type: 'user.organized.item';
      readonly payload: {
        readonly payloadVersion: 1;
        readonly itemKind: 'tab-session' | 'tab-group-link';
        readonly itemId: string;
        readonly action: 'move' | 'reject' | 'split';
        readonly fromContainer?: string;
        readonly toContainer?: string | null;
        readonly details?: {
          readonly attributionSource?: 'tab-group-pull-in' | 'tab-group-pull-out';
        };
      };
    }
  | {
      readonly type: 'user.flow.rejected';
      readonly payload: {
        readonly payloadVersion: 1;
        readonly relationKind: 'closest_visit';
        readonly fromId: string;
        readonly toId: string;
        readonly reason: 'other';
      };
    };

export interface TabGroupRuntime {
  readonly tabGroups: {
    readonly onCreated: ChromeEvent<(group: chrome.tabGroups.TabGroup) => void>;
    readonly onUpdated: ChromeEvent<(group: chrome.tabGroups.TabGroup) => void>;
    readonly onMoved: ChromeEvent<(group: chrome.tabGroups.TabGroup) => void>;
    readonly onRemoved: ChromeEvent<(group: chrome.tabGroups.TabGroup) => void>;
    readonly update: (
      groupId: number,
      properties: chrome.tabGroups.UpdateProperties,
    ) => Promise<chrome.tabGroups.TabGroup | undefined>;
  };
  readonly tabs: {
    readonly onUpdated: ChromeEvent<
      (tabId: number, changeInfo: TabGroupTabChangeInfo, tab: chrome.tabs.Tab) => void
    >;
    readonly group: (options: chrome.tabs.GroupOptions) => Promise<number>;
    readonly get: (tabId: number) => Promise<chrome.tabs.Tab>;
  };
}

export interface ChromeEvent<T> {
  readonly addListener: (listener: T) => void;
}

export interface TabGroupTabChangeInfo {
  readonly groupId?: number;
}

export interface TabGroupWiringDeps {
  readonly runtime: TabGroupRuntime;
  readonly postFeedbackEvent: (event: TabGroupFeedbackEvent) => Promise<void>;
  readonly tabSessionIdForTab: (tab: chrome.tabs.Tab) => Promise<string | null>;
  readonly canonicalUrlsForTabs: (tabIds: readonly number[]) => Promise<readonly string[]>;
  readonly originDetector?: TabGroupOriginDetector;
  readonly mintLinkId?: () => string;
}

export interface TabGroupWiring {
  readonly linkGroupToWorkstream: (groupId: number, workstreamId: string) => Promise<void>;
  readonly suggestGroupForTabs: (input: {
    readonly tabIds: readonly number[];
    readonly title: string;
    readonly color: chrome.tabGroups.Color;
  }) => Promise<DurableTabGroupLink>;
  readonly links: () => readonly DurableTabGroupLink[];
}

interface RuntimeLink extends DurableTabGroupLink {
  readonly groupId: number;
}

export const SYSTEM_GROUP_TITLE_PREFIX = '\u{1F504} ';

export const shouldAutoCreateTabGroup = (
  mode: 'conservative' | 'balanced' | 'aggressive',
  componentSize: number,
): boolean => {
  if (mode === 'conservative') return false;
  return componentSize >= (mode === 'balanced' ? 3 : 2);
};

const groupTitle = (group: chrome.tabGroups.TabGroup): string =>
  typeof group.title === 'string' && group.title.length > 0 ? group.title : 'Untitled group';

const groupColor = (group: chrome.tabGroups.TabGroup): string =>
  typeof group.color === 'string' ? group.color : 'grey';

const tabGroupFallback = (
  groupId: number,
  title: string,
  color: chrome.tabGroups.Color,
): chrome.tabGroups.TabGroup =>
  ({
    id: groupId,
    title: `${SYSTEM_GROUP_TITLE_PREFIX}${title}`,
    color,
    collapsed: false,
    windowId: chrome.windows.WINDOW_ID_NONE,
  }) as chrome.tabGroups.TabGroup;

const durableLink = (link: RuntimeLink): DurableTabGroupLink => ({
  linkId: link.linkId,
  title: link.title,
  color: link.color,
  ...(link.workstreamId === undefined ? {} : { workstreamId: link.workstreamId }),
  orderedCanonicalUrls: link.orderedCanonicalUrls,
  origin: link.origin,
});

export const createTabGroupWiring = (deps: TabGroupWiringDeps): TabGroupWiring => {
  const originDetector = deps.originDetector ?? createTabGroupOriginDetector();
  const mintLinkId = deps.mintLinkId ?? (() => mintTabGroupLinkId());
  const linksByGroupId = new Map<number, RuntimeLink>();
  const groupIdByTabId = new Map<number, number>();

  const ensureLink = async (group: chrome.tabGroups.TabGroup): Promise<RuntimeLink> => {
    const existing = linksByGroupId.get(group.id);
    if (existing !== undefined) {
      const next = {
        ...existing,
        title: groupTitle(group),
        color: groupColor(group),
      };
      linksByGroupId.set(group.id, next);
      return next;
    }
    const link: RuntimeLink = {
      groupId: group.id,
      linkId: mintLinkId(),
      title: groupTitle(group),
      color: groupColor(group),
      orderedCanonicalUrls: [],
      origin: originDetector.classify(group.id),
    };
    linksByGroupId.set(group.id, link);
    return link;
  };

  deps.runtime.tabGroups.onCreated.addListener((group) => {
    void ensureLink(group).catch(() => undefined);
  });
  deps.runtime.tabGroups.onUpdated.addListener((group) => {
    void ensureLink(group).catch(() => undefined);
  });
  deps.runtime.tabGroups.onMoved.addListener((group) => {
    void ensureLink(group).catch(() => undefined);
  });
  deps.runtime.tabGroups.onRemoved.addListener((group) => {
    linksByGroupId.delete(group.id);
  });

  deps.runtime.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const groupId = changeInfo.groupId;
    if (groupId === undefined) return;
    void (async () => {
      const tabSessionId = await deps.tabSessionIdForTab(tab);
      if (tabSessionId === null) return;
      if (groupId >= 0) {
        groupIdByTabId.set(tabId, groupId);
        const link = linksByGroupId.get(groupId);
        if (link?.workstreamId === undefined) return;
        await deps.postFeedbackEvent({
          type: 'user.organized.item',
          payload: {
            payloadVersion: 1,
            itemKind: 'tab-session',
            itemId: tabSessionId,
            action: 'move',
            toContainer: link.workstreamId,
            details: { attributionSource: 'tab-group-pull-in' },
          },
        });
        return;
      }
      const previousGroupId = groupIdByTabId.get(tabId);
      groupIdByTabId.delete(tabId);
      if (previousGroupId === undefined) return;
      const link = linksByGroupId.get(previousGroupId);
      if (link?.workstreamId === undefined) return;
      await deps.postFeedbackEvent({
        type: 'user.organized.item',
        payload: {
          payloadVersion: 1,
          itemKind: 'tab-session',
          itemId: tabSessionId,
          action: 'move',
          fromContainer: link.workstreamId,
          toContainer: null,
          details: { attributionSource: 'tab-group-pull-out' },
        },
      });
      await deps.postFeedbackEvent({
        type: 'user.flow.rejected',
        payload: {
          payloadVersion: 1,
          relationKind: 'closest_visit',
          fromId: `tab-session:${tabSessionId}`,
          toId: `workstream:${link.workstreamId}`,
          reason: 'other',
        },
      });
    })().catch(() => undefined);
  });

  return {
    linkGroupToWorkstream: async (groupId, workstreamId) => {
      const existing = linksByGroupId.get(groupId);
      if (existing === undefined) {
        throw new Error(`Cannot link unknown tab group ${String(groupId)}.`);
      }
      const next = { ...existing, workstreamId };
      linksByGroupId.set(groupId, next);
      await deps.postFeedbackEvent({
        type: 'user.organized.item',
        payload: {
          payloadVersion: 1,
          itemKind: 'tab-group-link',
          itemId: next.linkId,
          action: 'move',
          toContainer: workstreamId,
        },
      });
    },
    suggestGroupForTabs: async (input) => {
      const [firstTabId, ...remainingTabIds] = input.tabIds;
      if (firstTabId === undefined) {
        throw new Error('Cannot create a suggested tab group without tabs.');
      }
      const tabIds =
        remainingTabIds.length === 0
          ? firstTabId
          : ([firstTabId, ...remainingTabIds] as [number, ...number[]]);
      const groupId = await deps.runtime.tabs.group({ tabIds });
      originDetector.markSystemGroupCall(groupId);
      const updated = await deps.runtime.tabGroups.update(groupId, {
        title: `${SYSTEM_GROUP_TITLE_PREFIX}${input.title}`,
        color: input.color,
      });
      const group = updated ?? tabGroupFallback(groupId, input.title, input.color);
      const link: RuntimeLink = {
        groupId,
        linkId: mintLinkId(),
        title: groupTitle(group),
        color: groupColor(group),
        orderedCanonicalUrls: await deps.canonicalUrlsForTabs(input.tabIds),
        origin: 'system-suggested',
      };
      linksByGroupId.set(groupId, link);
      return durableLink(link);
    },
    links: () =>
      [...linksByGroupId.values()]
        .sort((left, right) => left.linkId.localeCompare(right.linkId))
        .map(durableLink),
  };
};

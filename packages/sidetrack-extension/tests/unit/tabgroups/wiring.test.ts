import { describe, expect, it, vi } from 'vitest';

import {
  SYSTEM_GROUP_TITLE_PREFIX,
  createTabGroupWiring,
  shouldAutoCreateTabGroup,
  type TabGroupFeedbackEvent,
  type TabGroupRuntime,
  type TabGroupTabChangeInfo,
} from '../../../src/tabgroups/wiring';
import { createTabGroupOriginDetector } from '../../../src/tabgroups/originDetection';
import {
  reconcileTabGroupLink,
  type DurableTabGroupLink,
} from '../../../src/tabgroups/reconciliation';

const event = <T>() => {
  const listeners: T[] = [];
  return {
    addListener: (listener: T) => {
      listeners.push(listener);
    },
    listeners,
  };
};

const blue = 'blue' as chrome.tabGroups.Color;

const tabGroup = (
  id: number,
  title = 'Security',
  color: chrome.tabGroups.Color = blue,
): chrome.tabGroups.TabGroup =>
  ({
    id,
    title,
    color,
    collapsed: false,
    windowId: 1,
  }) as chrome.tabGroups.TabGroup;

const tab = (id: number, groupId: number): chrome.tabs.Tab =>
  ({
    id,
    groupId,
    index: 0,
    highlighted: false,
    active: false,
    pinned: false,
    incognito: false,
    selected: false,
    discarded: false,
    autoDiscardable: true,
    windowId: 1,
    url: 'https://copy.fail',
  }) as chrome.tabs.Tab;

const createRuntime = () => {
  const onCreated = event<(group: chrome.tabGroups.TabGroup) => void>();
  const onUpdated = event<(group: chrome.tabGroups.TabGroup) => void>();
  const onMoved = event<(group: chrome.tabGroups.TabGroup) => void>();
  const onRemoved = event<(group: chrome.tabGroups.TabGroup) => void>();
  const onTabUpdated =
    event<(tabId: number, changeInfo: TabGroupTabChangeInfo, tabInfo: chrome.tabs.Tab) => void>();
  const runtime: TabGroupRuntime = {
    tabGroups: {
      onCreated,
      onUpdated,
      onMoved,
      onRemoved,
      update: vi.fn(async (groupId, properties) =>
        tabGroup(groupId, properties.title ?? 'Security', properties.color ?? 'blue'),
      ),
    },
    tabs: {
      onUpdated: onTabUpdated,
      group: vi.fn(async () => 42),
      get: vi.fn(async (tabId) => tab(tabId, 42)),
    },
  };
  return { runtime, onCreated, onUpdated, onRemoved, onTabUpdated };
};

const flushAsync = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

describe('tab group wiring', () => {
  it('classifies system-created groups inside the 200ms origin window', () => {
    const detector = createTabGroupOriginDetector(200, () => 1_000);
    detector.markSystemGroupCall(7, 1_000);

    expect(detector.classify(7, 1_150)).toBe('system-suggested');
    expect(detector.classify(8, 1_150)).toBe('user-created');
  });

  it('drag into linked group attributes, drag out unattributes and rejects prior workstream', async () => {
    const { runtime, onCreated, onTabUpdated } = createRuntime();
    const events: TabGroupFeedbackEvent[] = [];
    const wiring = createTabGroupWiring({
      runtime,
      postFeedbackEvent: async (feedbackEvent) => {
        events.push(feedbackEvent);
      },
      tabSessionIdForTab: async () => 'tses_a',
      canonicalUrlsForTabs: async () => ['https://copy.fail'],
      mintLinkId: () => 'tgrp_test',
    });

    onCreated.listeners[0]?.(tabGroup(42));
    await wiring.linkGroupToWorkstream(42, 'ws_security');
    onTabUpdated.listeners[0]?.(1, { groupId: 42 }, tab(1, 42));
    await flushAsync();
    onTabUpdated.listeners[0]?.(1, { groupId: -1 }, tab(1, -1));
    await flushAsync();

    expect(events).toEqual([
      expect.objectContaining({
        type: 'user.organized.item',
        payload: expect.objectContaining({
          itemKind: 'tab-group-link',
          itemId: 'tgrp_test',
          toContainer: 'ws_security',
        }),
      }),
      expect.objectContaining({
        type: 'user.organized.item',
        payload: expect.objectContaining({
          itemKind: 'tab-session',
          itemId: 'tses_a',
          toContainer: 'ws_security',
          details: { attributionSource: 'tab-group-pull-in' },
        }),
      }),
      expect.objectContaining({
        type: 'user.organized.item',
        payload: expect.objectContaining({
          itemKind: 'tab-session',
          itemId: 'tses_a',
          fromContainer: 'ws_security',
          toContainer: null,
          details: { attributionSource: 'tab-group-pull-out' },
        }),
      }),
      expect.objectContaining({
        type: 'user.flow.rejected',
        payload: expect.objectContaining({
          fromId: 'tab-session:tses_a',
          toId: 'workstream:ws_security',
        }),
      }),
    ]);
  });

  it('suggested groups use the visual marker and durable link id, not chrome group id', async () => {
    const { runtime } = createRuntime();
    const wiring = createTabGroupWiring({
      runtime,
      postFeedbackEvent: async () => {},
      tabSessionIdForTab: async () => null,
      canonicalUrlsForTabs: async () => [
        'https://copy.fail',
        'https://github.com/zyingfei/switchboard',
      ],
      mintLinkId: () => 'tgrp_suggested',
    });

    const link = await wiring.suggestGroupForTabs({
      tabIds: [1, 2],
      title: 'Security research',
      color: blue,
    });

    expect(runtime.tabs.group).toHaveBeenCalledWith({ tabIds: [1, 2] });
    expect(runtime.tabGroups.update).toHaveBeenCalledWith(42, {
      title: `${SYSTEM_GROUP_TITLE_PREFIX}Security research`,
      color: 'blue',
    });
    expect(link).toMatchObject({
      linkId: 'tgrp_suggested',
      origin: 'system-suggested',
      orderedCanonicalUrls: ['https://copy.fail', 'https://github.com/zyingfei/switchboard'],
    });
    expect(JSON.stringify(link)).not.toContain('"groupId"');
  });

  it('reconciles restart state silently only on strong match', () => {
    const link: DurableTabGroupLink = {
      linkId: 'tgrp_a',
      title: 'Security',
      color: 'blue',
      orderedCanonicalUrls: ['https://copy.fail'],
      origin: 'user-created',
    };

    expect(
      reconcileTabGroupLink(
        { title: 'Security', color: 'blue', orderedCanonicalUrls: ['https://copy.fail'] },
        [link],
      ),
    ).toEqual({ action: 'silent-relink', link });
    expect(
      reconcileTabGroupLink(
        { title: 'Security', color: 'blue', orderedCanonicalUrls: ['https://different.test'] },
        [link],
      ),
    ).toEqual({ action: 'show-relink-banner', candidates: [link] });
  });

  it('auto-create policy follows conservative balanced aggressive thresholds', () => {
    expect(shouldAutoCreateTabGroup('conservative', 10)).toBe(false);
    expect(shouldAutoCreateTabGroup('balanced', 2)).toBe(false);
    expect(shouldAutoCreateTabGroup('balanced', 3)).toBe(true);
    expect(shouldAutoCreateTabGroup('aggressive', 2)).toBe(true);
  });
});

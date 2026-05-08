export interface TabOpenerStore {
  rememberCreated(tabId: number, openerTabId: number | null): void;
  markRemoved(tabId: number): void;
  openerFor(tabId: number): number | null;
  wasRemoved(tabId: number): boolean;
}

export interface TabsListenerApi {
  readonly onCreated: {
    addListener(listener: (tab: { readonly id?: number; readonly openerTabId?: number }) => void): void;
  };
  readonly onRemoved: {
    addListener(listener: (tabId: number) => void): void;
  };
}

export const createTabOpenerStore = (): TabOpenerStore => {
  const openerByTabId = new Map<number, number | null>();
  const removedTabIds = new Set<number>();

  return {
    rememberCreated(tabId, openerTabId) {
      openerByTabId.set(tabId, openerTabId);
      removedTabIds.delete(tabId);
    },
    markRemoved(tabId) {
      removedTabIds.add(tabId);
      openerByTabId.delete(tabId);
    },
    openerFor(tabId) {
      return openerByTabId.get(tabId) ?? null;
    },
    wasRemoved(tabId) {
      return removedTabIds.has(tabId);
    },
  };
};

export const registerTabLifecycleListeners = (
  tabs: TabsListenerApi,
  store: TabOpenerStore,
): void => {
  tabs.onCreated.addListener((tab) => {
    if (typeof tab.id !== 'number') return;
    store.rememberCreated(tab.id, typeof tab.openerTabId === 'number' ? tab.openerTabId : null);
  });
  tabs.onRemoved.addListener((tabId) => {
    store.markRemoved(tabId);
  });
};

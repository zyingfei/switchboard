import { describe, expect, it, vi } from 'vitest';

import {
  createTabOpenerStore,
  registerTabLifecycleListeners,
  type TabsListenerApi,
} from './tabs';

describe('tab opener lifecycle', () => {
  it('captures openerTabId synchronously on tab creation', () => {
    let createdListener: Parameters<TabsListenerApi['onCreated']['addListener']>[0] =
      () => undefined;
    let removedListener: Parameters<TabsListenerApi['onRemoved']['addListener']>[0] =
      () => undefined;
    const tabs: TabsListenerApi = {
      onCreated: { addListener: vi.fn((listener) => { createdListener = listener; }) },
      onRemoved: { addListener: vi.fn((listener) => { removedListener = listener; }) },
    };
    const store = createTabOpenerStore();
    registerTabLifecycleListeners(tabs, store);

    createdListener({ id: 2, openerTabId: 1 });
    expect(store.openerFor(2)).toBe(1);
    expect(store.wasRemoved(1)).toBe(false);

    removedListener(1);
    expect(store.wasRemoved(1)).toBe(true);
    expect(store.openerFor(2)).toBe(1);
  });

  it('uses null opener for tabs created without openerTabId', () => {
    const store = createTabOpenerStore();
    store.rememberCreated(3, null);
    expect(store.openerFor(3)).toBeNull();
  });
});

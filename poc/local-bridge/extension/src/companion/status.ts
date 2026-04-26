import type { BridgeSettings } from '../shared/messages';

const SETTINGS_KEY = 'bac.localBridge.settings';

export const loadSettings = async (): Promise<BridgeSettings | null> => {
  const result = await chrome.storage.local.get({ [SETTINGS_KEY]: null });
  return result[SETTINGS_KEY] as BridgeSettings | null;
};

export const saveSettings = async (settings: BridgeSettings): Promise<void> => {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
};

export const publicSettings = (
  settings: BridgeSettings | null,
): (Omit<BridgeSettings, 'key'> & { keyPresent: boolean }) | undefined =>
  settings
    ? {
        transport: settings.transport,
        port: settings.port,
        nativeHost: settings.nativeHost,
        keyPresent: Boolean(settings.key),
      }
    : undefined;

import type { CompanionSettings } from './model';

const SETTINGS_KEY = 'sidetrack.settings';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

// Read companion connection details (port + bridge key) from
// chrome.storage.local. Returns null when the user hasn't completed
// setup or chrome.storage isn't available (e.g., jsdom unit tests).
export const readCompanionSettingsFromStorage = async (): Promise<CompanionSettings | null> => {
  try {
    const result = await chrome.storage.local.get({ [SETTINGS_KEY]: undefined });
    const settings = result[SETTINGS_KEY];
    if (!isRecord(settings) || !isRecord(settings.companion)) return null;
    const companion = settings.companion;
    if (typeof companion.port !== 'number' || typeof companion.bridgeKey !== 'string') {
      return null;
    }
    if (companion.bridgeKey.trim().length === 0) return null;
    return { port: companion.port, bridgeKey: companion.bridgeKey };
  } catch {
    return null;
  }
};

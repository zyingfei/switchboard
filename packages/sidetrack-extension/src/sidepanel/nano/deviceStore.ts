// Device-local settings for the on-device AI stack — chrome.storage.LOCAL only.
//
// WHY A DEDICATED MODULE, AND WHY IT NAMES EXACTLY ONE STORAGE AREA.
// One of the values persisted through here is a user-supplied API key for the
// OPTIONAL remote engine (remoteConfig.ts). `chrome.storage.sync` replicates
// through the signed-in Chrome profile to Google's servers — writing a
// credential there would ship it off the device by default, which is precisely
// the property this product sells against. So the area is chosen ONCE, here,
// and no call site is given the option to pick a different one. There is no
// exported `sync` accessor anywhere in this codebase, and a test asserts that
// nothing this module writes ever reaches `chrome.storage.sync`.
//
// Every operation is best-effort and never throws: a browserless test harness
// (jsdom without a chrome stub) simply reads back nothing.

interface StorageAreaLike {
  readonly get: (key: string) => Promise<Record<string, unknown>>;
  readonly set: (entries: Record<string, unknown>) => Promise<void>;
  readonly remove: (key: string) => Promise<void>;
}

/**
 * The one storage area. Returns null when the extension APIs are absent (unit
 * tests, a non-extension page) so callers degrade to defaults.
 */
const localArea = (): StorageAreaLike | null => {
  const area = (
    globalThis as {
      chrome?: { storage?: { local?: unknown } };
    }
  ).chrome?.storage?.local;
  if (area === undefined || area === null) return null;
  return area as StorageAreaLike;
};

/** Read one JSON-ish value. Null when absent, unreadable, or storage is gone. */
export const readDeviceValue = async <T>(key: string): Promise<T | null> => {
  const area = localArea();
  if (area === null) return null;
  try {
    const got = await area.get(key);
    const value = got[key];
    return value === undefined ? null : (value as T);
  } catch {
    return null;
  }
};

/** Write one value. Best-effort — a failure must never break a render path. */
export const writeDeviceValue = async (key: string, value: unknown): Promise<void> => {
  const area = localArea();
  if (area === null) return;
  try {
    await area.set({ [key]: value });
  } catch {
    // Storage unavailable — the setting stays session-local. Never throw.
  }
};

/** Delete one value (the "Clear key" action's storage half). */
export const removeDeviceValue = async (key: string): Promise<void> => {
  const area = localArea();
  if (area === null) return;
  try {
    await area.remove(key);
  } catch {
    // Same contract as the writer: best-effort, never throws.
  }
};

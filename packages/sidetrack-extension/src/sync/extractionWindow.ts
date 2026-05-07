// Sync Contract v1 / Class F + E — plugin-tier active extraction window.
//
// Mode P invariant: the plugin's active window must hold ENOUGH FULL
// CONTENT to render and locally search recent conversations without
// the companion. Companion owns extended history + old revisions +
// large embeddings + cross-replica sync; the plugin owns the active
// slice the user is interacting with.
//
// This module is the plugin-side mirror of the companion's
// extraction store (`packages/sidetrack-companion/src/recall/
// extraction/store.ts`). It stores the FULL active extraction
// revision content (turns + role + text + headings) in
// chrome.storage so the side panel can render + locally search
// without a network round trip.
//
// Bounded by Class F's activeSetCount + activeSetBytes budgets
// (budgetConfig.ts). Eviction is LRU by lastSeenAt: when adding a
// new active revision pushes the window past budget, the oldest
// one rolls out. Eviction is reversible — a follow-up may move
// evicted revisions to a bounded spool, but for v1 they're simply
// "fall back to companion fetchExtended."

export interface PluginActiveExtractionRevision {
  readonly sourceUnitId: string;
  readonly extractionRevisionId: string;
  readonly extractorId: string;
  readonly extractorVersion: string;
  readonly content: {
    readonly turns: readonly {
      readonly ordinal: number;
      readonly role: 'user' | 'assistant' | 'system' | 'unknown';
      readonly text: string;
      readonly markdown?: string;
      readonly modelName?: string;
    }[];
    readonly title?: string;
    readonly threadUrl?: string;
    readonly capturedAt: string;
  };
  readonly lastSeenAt: string; // for LRU eviction
}

const STORAGE_KEY = 'sidetrack.sync.extractionWindow';

interface ChromeStorageLike {
  readonly get: (key: string) => Promise<Record<string, unknown>>;
  readonly set: (entries: Record<string, unknown>) => Promise<void>;
}

const storage = (): ChromeStorageLike => {
  const c = (globalThis as unknown as { chrome?: { storage?: { local?: ChromeStorageLike } } })
    .chrome;
  const local = c?.storage?.local;
  if (local === undefined) {
    throw new Error('chrome.storage.local is unavailable');
  }
  return local;
};

const isRevision = (value: unknown): value is PluginActiveExtractionRevision => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['sourceUnitId'] === 'string' &&
    typeof v['extractionRevisionId'] === 'string' &&
    typeof v['content'] === 'object'
  );
};

export const readActiveExtractionWindow = async (): Promise<
  readonly PluginActiveExtractionRevision[]
> => {
  const got = await storage().get(STORAGE_KEY);
  const raw = got[STORAGE_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRevision);
};

export const writeActiveExtractionWindow = async (
  revisions: readonly PluginActiveExtractionRevision[],
): Promise<void> => {
  await storage().set({ [STORAGE_KEY]: [...revisions] });
};

// LRU upsert: replace any prior revision for the same sourceUnitId,
// stamp lastSeenAt to now, evict oldest until under budget.
export const upsertActiveExtractionRevision = async (
  revision: Omit<PluginActiveExtractionRevision, 'lastSeenAt'>,
  budget: number,
): Promise<{ kept: number; evicted: number }> => {
  const now = new Date().toISOString();
  const existing = await readActiveExtractionWindow();
  const dedup = existing.filter((r) => r.sourceUnitId !== revision.sourceUnitId);
  const next: PluginActiveExtractionRevision = { ...revision, lastSeenAt: now };
  const merged: PluginActiveExtractionRevision[] = [...dedup, next];
  // Evict oldest by lastSeenAt until under budget.
  let evicted = 0;
  if (merged.length > budget) {
    merged.sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt));
    while (merged.length > budget) {
      merged.shift();
      evicted += 1;
    }
  }
  await writeActiveExtractionWindow(merged);
  return { kept: merged.length, evicted };
};

// Read a specific source's active extraction content. Returns null
// when the source unit is not in the active window (caller should
// fall back to companion fetchExtended).
export const readActiveRevisionForSource = async (
  sourceUnitId: string,
): Promise<PluginActiveExtractionRevision | null> => {
  const all = await readActiveExtractionWindow();
  return all.find((r) => r.sourceUnitId === sourceUnitId) ?? null;
};

// Bump lastSeenAt without changing content. Caller invokes when
// the side panel surfaces a turn so LRU evicts cold sources first.
export const touchActiveRevision = async (sourceUnitId: string): Promise<void> => {
  const all = await readActiveExtractionWindow();
  const found = all.find((r) => r.sourceUnitId === sourceUnitId);
  if (found === undefined) return;
  const next = all.map((r) =>
    r.sourceUnitId === sourceUnitId ? { ...r, lastSeenAt: new Date().toISOString() } : r,
  );
  await writeActiveExtractionWindow(next);
};

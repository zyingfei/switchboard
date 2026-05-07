import { buildScopedResult, type ScopedResult } from './resultScope';

// Sync Contract v1 / Class F — extended-query fallback.
//
// When the side panel queries something that may not fit in the
// active window (recall search beyond the cached chunks; thread by
// id when not in sidetrack.threads; older queue items), it calls
// runExtendedQuery. The result is a ScopedResult — the side panel
// renders the boundary truthfully (gate L3-G4 + L3-G9).
//
// Three modes:
//   - Companion reachable + reaches the data → 'companion-extended'.
//   - Companion reachable but data is in an exported archive that
//     hasn't been imported → 'archive-exported-not-imported'.
//   - Companion unreachable → 'plugin-active-only-companion-unreachable'.

export interface ExtendedQueryPort<TItem> {
  // Returns true when the companion is reachable AND able to
  // serve. Implementations check the companion-status cache.
  readonly companionReachable: () => Promise<boolean>;
  // Hits the companion's HTTP endpoint for the surface in
  // question. Returns null when the call fails (network drop
  // mid-request, timeout, 5xx). Returning null does NOT change the
  // scope by itself — the scope is determined by companionReachable.
  readonly fetchFromCompanion: () => Promise<readonly TItem[] | null>;
  // Optional: returns the local active set. Used as a starting
  // point that companion results merge into when companion is
  // reachable, OR as the only result when companion is offline.
  readonly readActive: () => Promise<readonly TItem[]>;
  // Optional: identity selector for dedup when merging local +
  // companion. Default is reference equality.
  readonly idOf?: (item: TItem) => string;
  // Optional: returns true when the user has exported archive
  // packs that the companion has not imported yet. Surfaced via
  // ScopedResult.scope = 'archive-exported-not-imported'.
  readonly archiveExportedAwaitingImport?: () => Promise<boolean>;
}

export const runExtendedQuery = async <TItem>(
  port: ExtendedQueryPort<TItem>,
): Promise<ScopedResult<TItem>> => {
  const reachable = await port.companionReachable();
  const active = await port.readActive();
  if (!reachable) {
    const archived = (await port.archiveExportedAwaitingImport?.()) ?? false;
    if (archived) {
      return buildScopedResult('archive-exported-not-imported', active);
    }
    return buildScopedResult('plugin-active-only-companion-unreachable', active);
  }
  const remote = await port.fetchFromCompanion();
  if (remote === null) {
    // Companion was reachable on probe but the call dropped.
    // Treat as offline for scope honesty — user sees the
    // boundary instead of silent partial results.
    return buildScopedResult('plugin-active-only-companion-unreachable', active);
  }
  // Merge remote with active (active takes precedence on id
  // collision so unsaved local edits aren't overwritten).
  const idOf = port.idOf ?? ((item: TItem) => JSON.stringify(item));
  const seen = new Set<string>();
  const merged: TItem[] = [];
  for (const item of active) {
    const id = idOf(item);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(item);
  }
  for (const item of remote) {
    const id = idOf(item);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(item);
  }
  return buildScopedResult('companion-extended', merged);
};

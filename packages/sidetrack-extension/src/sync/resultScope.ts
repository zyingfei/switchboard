// Sync Contract v1 / Class F — extended-query honesty.
//
// Every query that crosses the active-window boundary returns a
// ScopedResult so the side panel can render the boundary
// truthfully. No silent truncation; no surprising empty results.

export type ResultScope =
  // Satisfied entirely from the plugin's active window. Fast path.
  | 'plugin-active'
  // Active window plus companion-fetched extended results. Mode P+C.
  | 'companion-extended'
  // Companion is offline; only the active window was searched.
  | 'plugin-active-only-companion-unreachable'
  // Older history is in exported archive packs that the companion
  // hasn't imported yet. Includes a hint so the user can run
  // `sidetrack-companion ingest --import <path>` to bring it back.
  | 'archive-exported-not-imported';

export interface ScopedResult<T> {
  readonly scope: ResultScope;
  readonly items: readonly T[];
  // Human-readable explanation rendered in the side panel. The
  // contract requires that this be non-empty for every non-trivial
  // scope so users see WHY their results are partial.
  readonly note?: string;
}

const NOTE_BY_SCOPE: Record<ResultScope, string | undefined> = {
  'plugin-active': undefined,
  'companion-extended': undefined,
  'plugin-active-only-companion-unreachable':
    'Showing recent local history only — companion unavailable.',
  'archive-exported-not-imported':
    'Older history is in exported archive packs that the companion has not imported yet.',
};

export const noteForScope = (scope: ResultScope): string | undefined => NOTE_BY_SCOPE[scope];

export const buildScopedResult = <T>(scope: ResultScope, items: readonly T[]): ScopedResult<T> => {
  const note = noteForScope(scope);
  return note === undefined ? { scope, items } : { scope, items, note };
};

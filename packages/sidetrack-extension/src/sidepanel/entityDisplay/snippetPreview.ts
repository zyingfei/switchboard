import { useEffect, useState } from 'react';

// Local-only preview cache, written by the content script on copy. The
// companion stays hash-only — this is a per-browser convenience that
// lets the side-panel snippet card show what the user actually copied.
// Keyed by full selectionHash (sha-256 hex of the normalized text); a
// 12-char prefix is also accepted because the snapshot only ships the
// prefix as `metadata.charHashPrefix`.

const STORAGE_KEY = 'sidetrack.snippetPreviewByHash';

type PreviewMap = Readonly<Record<string, string>>;

interface PreviewLookup {
  readonly previews: PreviewMap;
  readonly lookup: (hashOrPrefix: string | undefined) => string | undefined;
}

const buildLookup = (map: PreviewMap): PreviewLookup => {
  const byPrefix: Map<string, string> = new Map();
  for (const [hash, preview] of Object.entries(map)) {
    byPrefix.set(hash.slice(0, 12), preview);
  }
  return {
    previews: map,
    lookup: (hashOrPrefix) => {
      if (hashOrPrefix === undefined || hashOrPrefix.length === 0) return undefined;
      const direct = map[hashOrPrefix];
      if (direct !== undefined) return direct;
      return byPrefix.get(hashOrPrefix.slice(0, 12));
    },
  };
};

const EMPTY_LOOKUP: PreviewLookup = {
  previews: {},
  lookup: () => undefined,
};

export const useSnippetPreviewMap = (): PreviewLookup => {
  const [state, setState] = useState<PreviewLookup>(EMPTY_LOOKUP);

  useEffect(() => {
    const storage = (
      globalThis as {
        chrome?: { storage?: { local?: chrome.storage.LocalStorageArea } };
      }
    ).chrome?.storage?.local;
    if (storage === undefined) return;

    let cancelled = false;
    void storage
      .get(STORAGE_KEY)
      .then((result: Record<string, unknown>) => {
        if (cancelled) return;
        const map = result[STORAGE_KEY];
        if (typeof map !== 'object' || map === null || Array.isArray(map)) return;
        setState(buildLookup(map as PreviewMap));
      })
      .catch(() => {
        // Best-effort.
      });

    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ): void => {
      if (areaName !== 'local') return;
      const change = changes[STORAGE_KEY];
      if (change === undefined) return;
      const next = change.newValue;
      if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
        setState(buildLookup(next as PreviewMap));
      }
    };
    const onChangedHub = (
      globalThis as {
        chrome?: {
          storage?: {
            onChanged?: {
              addListener: (callback: typeof onChanged) => void;
              removeListener: (callback: typeof onChanged) => void;
            };
          };
        };
      }
    ).chrome?.storage?.onChanged;
    onChangedHub?.addListener(onChanged);
    return () => {
      cancelled = true;
      onChangedHub?.removeListener(onChanged);
    };
  }, []);

  return state;
};

import { normalizeSelectionText } from '../../graph/normalize-selection';
import { simhash64Base64 } from '../../graph/simhash64';

export type ContentKindHint = 'code-block' | 'prose' | 'url' | 'mixed';

export interface SelectionCopiedPayload {
  readonly payloadVersion: 1;
  readonly visitId: string;
  readonly selectionHash: string;
  readonly simhash64: string;
  readonly charCount: number;
  readonly lineCount: number;
  readonly contentKindHint: ContentKindHint;
  readonly rawTextStored: false;
}

export interface SelectionPastedPayload {
  readonly payloadVersion: 1;
  readonly destinationKind: 'thread' | 'dispatch' | 'search' | 'note' | 'capture';
  readonly destinationId: string;
  readonly selectionHash: string;
  readonly simhash64: string;
  readonly charCount: number;
  readonly rawTextStored: false;
}

export type SelectionLineageMessage =
  | {
      readonly type: 'sidetrack.selection.copied';
      readonly version: 1;
      readonly payload: SelectionCopiedPayload;
    }
  | {
      readonly type: 'sidetrack.selection.pasted';
      readonly version: 1;
      readonly payload: SelectionPastedPayload;
    };

const bytesToHex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

const sha256Hex = async (value: string): Promise<string> =>
  bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));

const contentKindFor = (value: string): ContentKindHint => {
  const trimmed = value.trim();
  const looksUrl = /^https?:\/\/\S+$/u.test(trimmed);
  const hasCodeSignals = /(?:^|\n)\s*(?:const|let|function|class|import|export|\{|\}|<\/?[a-z])/u.test(value);
  const hasSentence = /[.!?]\s/u.test(value);
  if (looksUrl) return 'url';
  if (hasCodeSignals && hasSentence) return 'mixed';
  if (hasCodeSignals) return 'code-block';
  return 'prose';
};

const destinationKindForLocation = (
  location: Pick<Location, 'hostname' | 'pathname' | 'href' | 'search'>,
): SelectionPastedPayload['destinationKind'] => {
  const host = location.hostname.toLowerCase();
  if (host.includes('google.') || host.includes('bing.') || host.includes('duckduckgo.')) {
    return 'search';
  }
  if (
    host === 'chatgpt.com' ||
    host === 'chat.openai.com' ||
    host === 'claude.ai' ||
    host === 'gemini.google.com'
  ) {
    return 'thread';
  }
  if (location.pathname.includes('dispatch')) return 'dispatch';
  if (location.pathname.includes('capture')) return 'capture';
  return 'note';
};

const digestSelection = async (value: string): Promise<{
  readonly normalized: string;
  readonly selectionHash: string;
  readonly simhash64: string;
}> => {
  const normalized = normalizeSelectionText(value);
  return {
    normalized,
    selectionHash: await sha256Hex(normalized),
    simhash64: simhash64Base64(normalized),
  };
};

// Local-only preview cache (chrome.storage.local). The companion never
// sees this — the wire payload stays rawTextStored:false. This is a
// per-browser convenience so the side-panel snippet card can show the
// first 120 chars of what the user copied instead of just "Code · 12
// lines". LRU-capped at 200 entries.
const SNIPPET_PREVIEW_KEY = 'sidetrack.snippetPreviewByHash';
const SNIPPET_PREVIEW_MAX = 200;
const SNIPPET_PREVIEW_CHARS = 120;

const cacheSnippetPreview = async (selectionHash: string, text: string): Promise<void> => {
  const preview = text.slice(0, SNIPPET_PREVIEW_CHARS);
  try {
    const storage = (globalThis as { chrome?: { storage?: { local?: chrome.storage.LocalStorageArea } } })
      .chrome?.storage?.local;
    if (storage === undefined) return;
    const existing = await storage.get(SNIPPET_PREVIEW_KEY);
    const map: Record<string, string> =
      (existing[SNIPPET_PREVIEW_KEY] as Record<string, string> | undefined) ?? {};
    // Simple LRU: delete then re-add to push to most-recent position.
    if (selectionHash in map) delete map[selectionHash];
    map[selectionHash] = preview;
    const keys = Object.keys(map);
    if (keys.length > SNIPPET_PREVIEW_MAX) {
      const trimmed: Record<string, string> = {};
      for (const key of keys.slice(keys.length - SNIPPET_PREVIEW_MAX)) {
        trimmed[key] = map[key] ?? '';
      }
      await storage.set({ [SNIPPET_PREVIEW_KEY]: trimmed });
    } else {
      await storage.set({ [SNIPPET_PREVIEW_KEY]: map });
    }
  } catch {
    // Best-effort — chrome.storage failures are non-fatal for the
    // hash-only lineage flow.
  }
};

export const attachCopyPasteLineage = (input: {
  readonly visitId: string;
  readonly send: (message: SelectionLineageMessage) => void;
  readonly location: Pick<Location, 'hostname' | 'pathname' | 'href' | 'search'>;
  readonly selection: () => Selection | null;
}): void => {
  document.addEventListener('copy', () => {
    const selectedText = input.selection()?.toString() ?? '';
    void digestSelection(selectedText).then((digest) => {
      if (digest.normalized.length === 0) return;
      input.send({
        type: 'sidetrack.selection.copied',
        version: 1,
        payload: {
          payloadVersion: 1,
          visitId: input.visitId,
          selectionHash: digest.selectionHash,
          simhash64: digest.simhash64,
          charCount: digest.normalized.length,
          lineCount: digest.normalized.split(/\n/u).length,
          contentKindHint: contentKindFor(digest.normalized),
          rawTextStored: false,
        },
      });
      void cacheSnippetPreview(digest.selectionHash, digest.normalized);
    });
  });
  document.addEventListener('paste', (event) => {
    const pastedText = event.clipboardData?.getData('text/plain') ?? '';
    void digestSelection(pastedText).then((digest) => {
      if (digest.normalized.length === 0) return;
      input.send({
        type: 'sidetrack.selection.pasted',
        version: 1,
        payload: {
          payloadVersion: 1,
          destinationKind: destinationKindForLocation(input.location),
          destinationId: input.location.href.replace(/#.*$/u, ''),
          selectionHash: digest.selectionHash,
          simhash64: digest.simhash64,
          charCount: digest.normalized.length,
          rawTextStored: false,
        },
      });
    });
  });
};

export const isSelectionLineageMessage = (
  value: unknown,
): value is SelectionLineageMessage => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record['version'] !== 1 ||
    (record['type'] !== 'sidetrack.selection.copied' &&
      record['type'] !== 'sidetrack.selection.pasted')
  ) {
    return false;
  }
  const payload = record['payload'];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  return (
    p['payloadVersion'] === 1 &&
    p['rawTextStored'] === false &&
    typeof p['selectionHash'] === 'string' &&
    typeof p['simhash64'] === 'string' &&
    typeof p['charCount'] === 'number'
  );
};

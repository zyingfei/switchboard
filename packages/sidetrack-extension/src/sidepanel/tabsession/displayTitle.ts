// Shared title/url derivation for tab-session UI surfaces (InboxCard,
// SuggestionBanner, and the current-tab card in App.tsx). All three used
// to roll their own fallback chains — some leaked the raw tabSessionId
// into the title, others leaked opaque URL path segments. This helper
// keeps them aligned: real title first, then host, never the internal id.

import type { TabSessionRecord } from './types';

const blankToUndefined = (input: string | undefined | null): string | undefined => {
  if (input === undefined || input === null) return undefined;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const tabSessionDisplayTitle = (record: TabSessionRecord): string => {
  const title = blankToUndefined(record.latestTitle);
  if (title !== undefined) return title;
  const url = blankToUndefined(record.latestUrl);
  if (url !== undefined) {
    try {
      const parsed = new URL(url);
      return parsed.host.length > 0 ? parsed.host : url;
    } catch {
      return url;
    }
  }
  return '(untracked tab)';
};

export const tabSessionDisplayUrl = (record: TabSessionRecord): string | undefined =>
  blankToUndefined(record.latestUrl);

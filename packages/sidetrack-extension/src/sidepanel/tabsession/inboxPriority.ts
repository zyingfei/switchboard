import type { TabSessionRecord } from './types';

export const TAB_SESSION_INBOX_PANEL_CAP = 50;

export interface InboxSlice {
  readonly visible: readonly TabSessionRecord[];
  readonly hiddenCount: number;
}

// file:// pages are kept in the projection (the Flow Path view uses
// them as opener anchors — the manual L5 launchpad.html is the
// canonical example), but they should never appear in the Inbox
// triage queue: there is no workstream to attribute a local scaffold
// to.
const isUntriageableForInbox = (record: TabSessionRecord): boolean => {
  const url = record.latestUrl;
  if (typeof url !== 'string') return false;
  return url.startsWith('file:');
};

const dedupeKey = (record: TabSessionRecord): string => record.latestUrl ?? record.tabSessionId;

const compareLastActivityDesc = (left: TabSessionRecord, right: TabSessionRecord): number =>
  left.lastActivityAt < right.lastActivityAt ? 1 : left.lastActivityAt > right.lastActivityAt ? -1 : 0;

// Multiple tab sessions can share the same URL (the user opened the
// same page in two tabs, or the boundary state machine re-minted a
// session after an idle window without closing the previous one). In
// the Inbox we only want the most-recent session per URL — attributing
// one stamps an explicit signal that benefits the next resolver run on
// any same-URL sibling.
const dedupeByUrl = (
  records: readonly TabSessionRecord[],
): readonly TabSessionRecord[] => {
  const sorted = [...records].sort(compareLastActivityDesc);
  const seen = new Set<string>();
  const out: TabSessionRecord[] = [];
  for (const record of sorted) {
    const key = dedupeKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
};

export const sliceInboxForPanel = (
  records: readonly TabSessionRecord[],
  total: number,
  cap = TAB_SESSION_INBOX_PANEL_CAP,
): InboxSlice => {
  const filtered = records.filter((record) => !isUntriageableForInbox(record));
  const deduped = dedupeByUrl(filtered);
  const visible = deduped.slice(0, cap);
  // `total` is the companion-side count and includes the file://
  // records we filtered out plus any duplicates we collapsed.
  // Subtract both so the "Take a break — review more later" sentinel
  // only fires when there are still triageable items beyond the cap.
  const droppedUntriageable = records.length - filtered.length;
  const collapsedDuplicates = filtered.length - deduped.length;
  return {
    visible,
    hiddenCount: Math.max(
      0,
      total - droppedUntriageable - collapsedDuplicates - visible.length,
    ),
  };
};

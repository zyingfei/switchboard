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

export const sliceInboxForPanel = (
  records: readonly TabSessionRecord[],
  total: number,
  cap = TAB_SESSION_INBOX_PANEL_CAP,
): InboxSlice => {
  const filtered = records.filter((record) => !isUntriageableForInbox(record));
  const visible = filtered.slice(0, cap);
  // `total` is the companion-side count and includes the file://
  // records we filtered out. Subtract what we dropped in the loaded
  // page so the "Take a break — review more later" sentinel only
  // fires when there are still triageable items beyond the cap.
  const dropped = records.length - filtered.length;
  return {
    visible,
    hiddenCount: Math.max(0, total - dropped - visible.length),
  };
};

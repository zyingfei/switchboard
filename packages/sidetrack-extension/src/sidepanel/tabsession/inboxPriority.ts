import type { TabSessionRecord } from './types';

export const TAB_SESSION_INBOX_PANEL_CAP = 50;

export interface InboxSlice {
  readonly visible: readonly TabSessionRecord[];
  readonly hiddenCount: number;
}

export const sliceInboxForPanel = (
  records: readonly TabSessionRecord[],
  total: number,
  cap = TAB_SESSION_INBOX_PANEL_CAP,
): InboxSlice => {
  const visible = records.slice(0, cap);
  return {
    visible,
    hiddenCount: Math.max(0, total - visible.length),
  };
};

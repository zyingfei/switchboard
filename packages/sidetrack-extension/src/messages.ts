import type { SerializedAnchor } from './annotation/anchors';
import type {
  CaptureEvent,
  CaptureNoteCreate,
  CaptureNoteUpdate,
  CodingAttachTokenCreate,
  CodingAttachTokenRecord,
  CompanionSettings,
  QueueCreate,
  QueueUpdate,
  ReminderCreate,
  ReminderUpdate,
  WorkstreamCreate,
  WorkstreamUpdate,
} from './companion/model';
import type { ReviewVerdict } from './review/types';
import type {
  AllThreadsBucket,
  PrivacyMode,
  TrackingMode,
  WorkboardSection,
  WorkboardState,
} from './workboard';

export const messageTypes = {
  captureVisibleThread: 'sidetrack.capture.visible-thread',
  autoCapture: 'sidetrack.capture.auto',
  captureFeedback: 'sidetrack.capture.feedback',
  selectorCanary: 'sidetrack.capture.selector-canary',
  getWorkboardState: 'sidetrack.workboard.state',
  saveCompanionSettings: 'sidetrack.settings.companion.save',
  captureCurrentTab: 'sidetrack.capture.current-tab',
  createWorkstream: 'sidetrack.workstream.create',
  updateWorkstream: 'sidetrack.workstream.update',
  bulkUpdateWorkstreamPrivacy: 'sidetrack.workstream.privacy.bulkUpdate',
  moveThread: 'sidetrack.thread.move',
  updateThreadTracking: 'sidetrack.thread.tracking.update',
  setThreadAutoSend: 'sidetrack.thread.autoSend.set',
  // Background asks the content script in the chat tab to type+send
  // a single queue item's text. Content script reports back when the
  // AI is done responding (Stop button → Send button transition).
  autoSendItem: 'sidetrack.queue.autoSend.item',
  autoSendInterimReport: 'sidetrack.queue.autoSend.interimReport',
  // Side panel asks the background to retry a queue item that
  // previously failed (lastError set). Background clears lastError,
  // re-fires the drain for the item's thread.
  retryAutoSend: 'sidetrack.queue.autoSend.retry',
  // Side panel asks the background to (re-)dispatch a recorded
  // packet by opening the target chat URL in a new tab and
  // auto-sending the body via the existing content-script driver
  // once the tab finishes loading. Used by Recent Dispatches'
  // "Dispatch" button on auto-send-mode rows.
  dispatchAutoSendInNewTab: 'sidetrack.dispatch.autoSend.newTab',
  // Side panel records the unredacted dispatch body (what the user
  // actually copied to clipboard) keyed by the companion-assigned
  // dispatch bac_id. Background stashes it in chrome.storage so the
  // auto-link matcher can match against the unredacted text instead
  // of the redacted form the companion stores.
  cacheDispatchOriginal: 'sidetrack.dispatch.cacheOriginal',
  // Side panel records the user's last Send-to target per thread so
  // the SendToDropdown can highlight it under the "Recent" header
  // for a one-click repeat.
  cacheLastDispatchTarget: 'sidetrack.dispatch.cacheLastTarget',
  // Content script asks the background to surface the matching
  // thread row in the side panel (scroll + flash). Sent from the
  // floating "↗ Sidetrack" button injected into provider chat
  // pages. Background relays via the workboard broadcast so the
  // side panel can pick up the focus target.
  focusThreadInSidePanel: 'sidetrack.sidepanel.focusThread',
  restoreThreadTab: 'sidetrack.thread.restore-tab',
  queueFollowUp: 'sidetrack.queue.create',
  updateQueueItem: 'sidetrack.queue.update',
  // User dropped queue rows in a new order. Payload is the ordered
  // list of pending bac_ids; the storage layer stamps each one's
  // sortOrder so the auto-send drain ships them in that order.
  reorderQueueItems: 'sidetrack.queue.reorder',
  createReminder: 'sidetrack.reminder.create',
  updateReminder: 'sidetrack.reminder.update',
  setCollapsedSections: 'sidetrack.sections.collapsed.set',
  setCollapsedBuckets: 'sidetrack.threadBuckets.collapsed.set',
  setScreenShareMode: 'sidetrack.screenShareMode.set',
  workboardChanged: 'sidetrack.workboard.changed',
  createCodingAttachToken: 'sidetrack.coding.attach-token.create',
  detachCodingSession: 'sidetrack.coding.session.detach',
  codingAttachListOffers: 'sidetrack.codingAttach.listOffers',
  codingAttachMarkStatus: 'sidetrack.codingAttach.markStatus',
  saveLocalPreferences: 'sidetrack.preferences.local.save',
  createCaptureNote: 'sidetrack.capture.note.create',
  updateCaptureNote: 'sidetrack.capture.note.update',
  deleteCaptureNote: 'sidetrack.capture.note.delete',
  // Inline review (selection-anchored) draft mutators. Content script
  // appends a span when the user comments on a highlighted phrase;
  // the side panel edits + sends. The "send-as-follow-up" path
  // bundles the draft into a queue item via the existing follow-up
  // pipeline so it inherits ordering, auto-send, and notifications.
  appendReviewDraftSpan: 'sidetrack.review.draft.appendSpan',
  dropReviewDraftSpan: 'sidetrack.review.draft.dropSpan',
  updateReviewDraft: 'sidetrack.review.draft.update',
  discardReviewDraft: 'sidetrack.review.draft.discard',
  sendReviewDraftAsFollowUp: 'sidetrack.review.draft.sendAsFollowUp',
  // Recent Dispatches lifecycle: archive hides a row from the default
  // list; unarchive brings it back. Both update the dispatch's local
  // status field; the companion vault record is unchanged (archive
  // is a UI-only filter).
  archiveDispatch: 'sidetrack.dispatch.archive',
  unarchiveDispatch: 'sidetrack.dispatch.unarchive',
} as const;

export interface SelectorCanaryReport {
  readonly provider: CaptureEvent['provider'];
  readonly url: string;
  readonly title: string;
  readonly selectorCanary: NonNullable<CaptureEvent['selectorCanary']>;
  readonly checkedAt: string;
}

export interface CaptureFeedbackMessage {
  readonly type: typeof messageTypes.captureFeedback;
  readonly host: string;
}

export interface WorkboardChangedMessage {
  readonly type: typeof messageTypes.workboardChanged;
  readonly reason:
    | 'capture'
    | 'mutation'
    | 'companion-status'
    | 'reminder'
    | 'queue'
    | 'workstream'
    | 'thread'
    | 'settings';
}

export const isWorkboardChangedMessage = (value: unknown): value is WorkboardChangedMessage =>
  isRecord(value) &&
  value.type === messageTypes.workboardChanged &&
  typeof value.reason === 'string';

// Broadcast: side panel should scroll to + flash the row whose
// thread.threadUrl matches. Fired by the background after a
// content-script focus button click.
export interface FocusThreadInSidePanelMessage {
  readonly type: typeof messageTypes.focusThreadInSidePanel;
  readonly threadUrl: string;
}

export const isFocusThreadInSidePanelMessage = (
  value: unknown,
): value is FocusThreadInSidePanelMessage =>
  isRecord(value) &&
  value.type === messageTypes.focusThreadInSidePanel &&
  typeof value.threadUrl === 'string';

export interface ContentRequest {
  readonly type: typeof messageTypes.captureVisibleThread;
}

export type ContentResponse =
  | {
      readonly ok: true;
      readonly capture: CaptureEvent;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

export const isContentResponse = (value: unknown): value is ContentResponse => {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    return false;
  }
  if (value.ok) {
    return isRecord(value.capture);
  }
  return typeof value.error === 'string';
};

export type WorkboardRequest =
  | {
      readonly type: typeof messageTypes.getWorkboardState;
    }
  | {
      readonly type: typeof messageTypes.saveCompanionSettings;
      readonly settings: CompanionSettings;
    }
  | {
      readonly type: typeof messageTypes.captureCurrentTab;
    }
  | {
      readonly type: typeof messageTypes.createWorkstream;
      readonly workstream: WorkstreamCreate;
    }
  | {
      readonly type: typeof messageTypes.updateWorkstream;
      readonly workstreamId: string;
      readonly update: WorkstreamUpdate;
    }
  | {
      readonly type: typeof messageTypes.bulkUpdateWorkstreamPrivacy;
      readonly from: PrivacyMode;
      readonly to: PrivacyMode;
    }
  | {
      readonly type: typeof messageTypes.moveThread;
      readonly threadId: string;
      readonly workstreamId: string;
    }
  | {
      readonly type: typeof messageTypes.updateThreadTracking;
      readonly threadId: string;
      readonly trackingMode: TrackingMode;
    }
  | {
      readonly type: typeof messageTypes.setThreadAutoSend;
      readonly threadId: string;
      readonly enabled: boolean;
    }
  | {
      readonly type: typeof messageTypes.restoreThreadTab;
      readonly threadId: string;
    }
  | {
      readonly type: typeof messageTypes.queueFollowUp;
      readonly item: QueueCreate;
    }
  | {
      readonly type: typeof messageTypes.updateQueueItem;
      readonly queueItemId: string;
      readonly update: QueueUpdate;
    }
  | {
      readonly type: typeof messageTypes.reorderQueueItems;
      readonly queueItemIds: readonly string[];
    }
  | {
      readonly type: typeof messageTypes.retryAutoSend;
      readonly queueItemId: string;
    }
  | {
      readonly type: typeof messageTypes.dispatchAutoSendInNewTab;
      readonly dispatchId: string;
      readonly url: string;
      readonly body: string;
    }
  | {
      readonly type: typeof messageTypes.cacheDispatchOriginal;
      readonly dispatchId: string;
      readonly body: string;
    }
  | {
      readonly type: typeof messageTypes.cacheLastDispatchTarget;
      readonly threadId: string;
      readonly target: string;
    }
  | {
      readonly type: typeof messageTypes.focusThreadInSidePanel;
      readonly threadUrl: string;
    }
  | {
      readonly type: typeof messageTypes.createReminder;
      readonly reminder: ReminderCreate;
    }
  | {
      readonly type: typeof messageTypes.updateReminder;
      readonly reminderId: string;
      readonly update: ReminderUpdate;
    }
  | {
      readonly type: typeof messageTypes.setCollapsedSections;
      readonly collapsedSections: readonly WorkboardSection['id'][];
    }
  | {
      readonly type: typeof messageTypes.setCollapsedBuckets;
      readonly collapsedBuckets: readonly AllThreadsBucket[];
    }
  | {
      readonly type: typeof messageTypes.setScreenShareMode;
      readonly enabled: boolean;
    }
  | {
      readonly type: typeof messageTypes.createCodingAttachToken;
      readonly request: CodingAttachTokenCreate;
    }
  | {
      readonly type: typeof messageTypes.detachCodingSession;
      readonly codingSessionId: string;
    }
  | {
      readonly type: typeof messageTypes.codingAttachListOffers;
    }
  | {
      readonly type: typeof messageTypes.codingAttachMarkStatus;
      readonly tabId: number;
      readonly status: 'pending' | 'accepted' | 'declined' | 'expired';
    }
  | {
      readonly type: typeof messageTypes.saveLocalPreferences;
      readonly preferences: {
        readonly autoTrack?: boolean;
        readonly vaultPath?: string;
        readonly notifyOnQueueComplete?: boolean;
      };
    }
  | {
      readonly type: typeof messageTypes.createCaptureNote;
      readonly note: CaptureNoteCreate;
    }
  | {
      readonly type: typeof messageTypes.updateCaptureNote;
      readonly noteId: string;
      readonly update: CaptureNoteUpdate;
    }
  | {
      readonly type: typeof messageTypes.deleteCaptureNote;
      readonly noteId: string;
    }
  | {
      readonly type: typeof messageTypes.appendReviewDraftSpan;
      readonly threadUrl: string;
      readonly anchor: SerializedAnchor;
      readonly quote: string;
      readonly comment: string;
      readonly capturedAt: string;
    }
  | {
      readonly type: typeof messageTypes.dropReviewDraftSpan;
      readonly threadId: string;
      readonly spanId: string;
    }
  | {
      readonly type: typeof messageTypes.updateReviewDraft;
      readonly threadId: string;
      readonly overall?: string;
      readonly verdict?: ReviewVerdict;
    }
  | {
      readonly type: typeof messageTypes.discardReviewDraft;
      readonly threadId: string;
    }
  | {
      readonly type: typeof messageTypes.sendReviewDraftAsFollowUp;
      readonly threadId: string;
      // true → also flip the thread's auto-send chip on so the queue
      // item ships immediately (Send now). false → just queue, leave
      // the user to trigger the drain manually (Add to queue).
      readonly autoSend: boolean;
    }
  | {
      readonly type: typeof messageTypes.archiveDispatch;
      readonly dispatchId: string;
    }
  | {
      readonly type: typeof messageTypes.unarchiveDispatch;
      readonly dispatchId: string;
    };

export type RuntimeRequest =
  | WorkboardRequest
  | {
      readonly type: typeof messageTypes.autoCapture;
      readonly capture: CaptureEvent;
    }
  | {
      readonly type: typeof messageTypes.autoSendInterimReport;
      readonly itemId: string;
      readonly phase: 'waiting';
    }
  | {
      readonly type: typeof messageTypes.selectorCanary;
      readonly report: SelectorCanaryReport;
    };

export type RuntimeResponse =
  | {
      readonly ok: true;
      readonly state: WorkboardState;
      readonly attachToken?: CodingAttachTokenRecord;
      readonly codingAttachOffers?: readonly unknown[];
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly state?: WorkboardState;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const isCaptureFeedbackMessage = (value: unknown): value is CaptureFeedbackMessage =>
  isRecord(value) && value.type === messageTypes.captureFeedback && typeof value.host === 'string';

const hasType = <TType extends string>(
  value: Record<string, unknown>,
  type: TType,
): value is Record<string, unknown> & { readonly type: TType } => value.type === type;

export const isRuntimeRequest = (value: unknown): value is RuntimeRequest => {
  if (!isRecord(value)) {
    return false;
  }

  if (
    hasType(value, messageTypes.getWorkboardState) ||
    hasType(value, messageTypes.captureCurrentTab)
  ) {
    return true;
  }

  if (hasType(value, messageTypes.saveCompanionSettings)) {
    const settings = value.settings;
    return (
      isRecord(settings) &&
      typeof settings.port === 'number' &&
      Number.isInteger(settings.port) &&
      typeof settings.bridgeKey === 'string'
    );
  }

  if (hasType(value, messageTypes.selectorCanary)) {
    const report = value.report;
    return (
      isRecord(report) && typeof report.url === 'string' && typeof report.checkedAt === 'string'
    );
  }

  if (hasType(value, messageTypes.autoCapture)) {
    return isRecord(value.capture);
  }

  if (hasType(value, messageTypes.autoSendInterimReport)) {
    return typeof value.itemId === 'string' && value.phase === 'waiting';
  }

  if (hasType(value, messageTypes.createWorkstream)) {
    const workstream = value.workstream;
    return isRecord(workstream) && typeof workstream.title === 'string';
  }

  if (hasType(value, messageTypes.updateWorkstream)) {
    return typeof value.workstreamId === 'string' && isRecord(value.update);
  }

  if (hasType(value, messageTypes.bulkUpdateWorkstreamPrivacy)) {
    return (
      (value.from === 'private' || value.from === 'shared' || value.from === 'public') &&
      (value.to === 'private' || value.to === 'shared' || value.to === 'public')
    );
  }

  if (hasType(value, messageTypes.moveThread)) {
    return typeof value.threadId === 'string' && typeof value.workstreamId === 'string';
  }

  if (hasType(value, messageTypes.updateThreadTracking)) {
    return (
      typeof value.threadId === 'string' &&
      (value.trackingMode === 'auto' ||
        value.trackingMode === 'manual' ||
        value.trackingMode === 'stopped' ||
        value.trackingMode === 'removed' ||
        value.trackingMode === 'archived')
    );
  }

  if (hasType(value, messageTypes.setThreadAutoSend)) {
    return typeof value.threadId === 'string' && typeof value.enabled === 'boolean';
  }

  if (hasType(value, messageTypes.restoreThreadTab)) {
    return typeof value.threadId === 'string';
  }

  if (hasType(value, messageTypes.queueFollowUp)) {
    const item = value.item;
    return isRecord(item) && typeof item.text === 'string' && typeof item.scope === 'string';
  }

  if (hasType(value, messageTypes.updateQueueItem)) {
    return typeof value.queueItemId === 'string' && isRecord(value.update);
  }

  if (hasType(value, messageTypes.reorderQueueItems)) {
    return (
      Array.isArray(value.queueItemIds) &&
      value.queueItemIds.every((id) => typeof id === 'string')
    );
  }

  if (hasType(value, messageTypes.retryAutoSend)) {
    return typeof value.queueItemId === 'string';
  }

  if (hasType(value, messageTypes.dispatchAutoSendInNewTab)) {
    return (
      typeof value.dispatchId === 'string' &&
      typeof value.url === 'string' &&
      typeof value.body === 'string'
    );
  }

  if (hasType(value, messageTypes.cacheDispatchOriginal)) {
    return typeof value.dispatchId === 'string' && typeof value.body === 'string';
  }

  if (hasType(value, messageTypes.cacheLastDispatchTarget)) {
    return typeof value.threadId === 'string' && typeof value.target === 'string';
  }

  if (hasType(value, messageTypes.focusThreadInSidePanel)) {
    return typeof value.threadUrl === 'string';
  }

  if (hasType(value, messageTypes.createReminder)) {
    const reminder = value.reminder;
    return (
      isRecord(reminder) &&
      typeof reminder.threadId === 'string' &&
      typeof reminder.detectedAt === 'string'
    );
  }

  if (hasType(value, messageTypes.updateReminder)) {
    return typeof value.reminderId === 'string' && isRecord(value.update);
  }

  if (hasType(value, messageTypes.setCollapsedSections)) {
    return (
      Array.isArray(value.collapsedSections) &&
      value.collapsedSections.every((section) => typeof section === 'string')
    );
  }

  if (hasType(value, messageTypes.setCollapsedBuckets)) {
    return (
      Array.isArray(value.collapsedBuckets) &&
      value.collapsedBuckets.every((bucket) => typeof bucket === 'string')
    );
  }

  if (hasType(value, messageTypes.setScreenShareMode)) {
    return typeof value.enabled === 'boolean';
  }

  if (hasType(value, messageTypes.createCodingAttachToken)) {
    return isRecord(value.request);
  }

  if (hasType(value, messageTypes.detachCodingSession)) {
    return typeof value.codingSessionId === 'string';
  }

  if (hasType(value, messageTypes.codingAttachListOffers)) {
    return true;
  }

  if (hasType(value, messageTypes.codingAttachMarkStatus)) {
    return (
      typeof value.tabId === 'number' &&
      (value.status === 'pending' ||
        value.status === 'accepted' ||
        value.status === 'declined' ||
        value.status === 'expired')
    );
  }

  if (hasType(value, messageTypes.saveLocalPreferences)) {
    return isRecord(value.preferences);
  }

  if (hasType(value, messageTypes.createCaptureNote)) {
    const note = value.note;
    return isRecord(note) && typeof note.text === 'string';
  }

  if (hasType(value, messageTypes.updateCaptureNote)) {
    return typeof value.noteId === 'string' && isRecord(value.update);
  }

  if (hasType(value, messageTypes.deleteCaptureNote)) {
    return typeof value.noteId === 'string';
  }

  if (hasType(value, messageTypes.appendReviewDraftSpan)) {
    return (
      typeof value.threadUrl === 'string' &&
      isRecord(value.anchor) &&
      typeof value.quote === 'string' &&
      typeof value.comment === 'string' &&
      typeof value.capturedAt === 'string'
    );
  }

  if (hasType(value, messageTypes.dropReviewDraftSpan)) {
    return typeof value.threadId === 'string' && typeof value.spanId === 'string';
  }

  if (hasType(value, messageTypes.updateReviewDraft)) {
    return typeof value.threadId === 'string';
  }

  if (hasType(value, messageTypes.discardReviewDraft)) {
    return typeof value.threadId === 'string';
  }

  if (hasType(value, messageTypes.sendReviewDraftAsFollowUp)) {
    return typeof value.threadId === 'string' && typeof value.autoSend === 'boolean';
  }

  if (
    hasType(value, messageTypes.archiveDispatch) ||
    hasType(value, messageTypes.unarchiveDispatch)
  ) {
    return typeof value.dispatchId === 'string';
  }

  return false;
};

export const isRuntimeResponse = (value: unknown): value is RuntimeResponse => {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    return false;
  }
  if (value.ok) {
    return isRecord(value.state);
  }
  return typeof value.error === 'string';
};

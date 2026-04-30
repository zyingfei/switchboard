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
import type { TrackingMode, WorkboardSection, WorkboardState } from './workboard';

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
  moveThread: 'sidetrack.thread.move',
  updateThreadTracking: 'sidetrack.thread.tracking.update',
  setThreadAutoSend: 'sidetrack.thread.autoSend.set',
  // Background asks the content script in the chat tab to type+send
  // a single queue item's text. Content script reports back when the
  // AI is done responding (Stop button → Send button transition).
  autoSendItem: 'sidetrack.queue.autoSend.item',
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
  restoreThreadTab: 'sidetrack.thread.restore-tab',
  queueFollowUp: 'sidetrack.queue.create',
  updateQueueItem: 'sidetrack.queue.update',
  createReminder: 'sidetrack.reminder.create',
  updateReminder: 'sidetrack.reminder.update',
  setCollapsedSections: 'sidetrack.sections.collapsed.set',
  workboardChanged: 'sidetrack.workboard.changed',
  createCodingAttachToken: 'sidetrack.coding.attach-token.create',
  detachCodingSession: 'sidetrack.coding.session.detach',
  saveLocalPreferences: 'sidetrack.preferences.local.save',
  createCaptureNote: 'sidetrack.capture.note.create',
  updateCaptureNote: 'sidetrack.capture.note.update',
  deleteCaptureNote: 'sidetrack.capture.note.delete',
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
      readonly type: typeof messageTypes.createCodingAttachToken;
      readonly request: CodingAttachTokenCreate;
    }
  | {
      readonly type: typeof messageTypes.detachCodingSession;
      readonly codingSessionId: string;
    }
  | {
      readonly type: typeof messageTypes.saveLocalPreferences;
      readonly preferences: {
        readonly autoTrack?: boolean;
        readonly vaultPath?: string;
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
    };

export type RuntimeRequest =
  | WorkboardRequest
  | {
      readonly type: typeof messageTypes.autoCapture;
      readonly capture: CaptureEvent;
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

  if (hasType(value, messageTypes.createWorkstream)) {
    const workstream = value.workstream;
    return isRecord(workstream) && typeof workstream.title === 'string';
  }

  if (hasType(value, messageTypes.updateWorkstream)) {
    return typeof value.workstreamId === 'string' && isRecord(value.update);
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

  if (hasType(value, messageTypes.createCodingAttachToken)) {
    return isRecord(value.request);
  }

  if (hasType(value, messageTypes.detachCodingSession)) {
    return typeof value.codingSessionId === 'string';
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

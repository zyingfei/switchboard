import { useEffect, useMemo, useState, type CSSProperties, type SyntheticEvent } from 'react';

import {
  companionStatusLabel,
  createEmptyWorkboardState,
  initialWorkboardSections,
  maskTitleForPrivacy,
  type InboundReminder,
  type PrivacyMode,
  type TrackedThread,
  type WorkboardState,
  type WorkstreamNode,
} from '../../src/workboard';
import type { ChecklistItem, WorkstreamUpdate } from '../../src/companion/model';
import {
  isCaptureFeedbackMessage,
  isRuntimeResponse,
  isWorkboardChangedMessage,
  messageTypes,
  type WorkboardRequest,
} from '../../src/messages';
import {
  CodingAttach,
  type ComposedPacket,
  DispatchConfirm,
  InboundCard,
  MoveToPicker,
  PacketComposer,
  RecentDispatches,
  ReviewComposer,
  SettingsPanel,
  type SettingsValue,
  SystemBannersStack,
  TabRecovery,
  Wizard,
  type DispatchEvent as LegacyDispatchEvent,
  type InboundReminder as InboundCardReminder,
  type RestoreStrategy,
  type ReviewVerdict,
  type WorkstreamOption,
} from './components';
import { createDispatchClient } from '../../src/dispatch/client';
import {
  type DispatchEventRecord,
  type DispatchMode,
  dispatchKindToUiPacketKind,
  mapUiPacketKind,
  mapUiTarget,
} from '../../src/dispatch/types';
import { createReviewClient } from '../../src/review/client';
import type { ReviewOutcome } from '../../src/review/types';
import { createSettingsClient } from '../../src/settings/client';
import { isProviderWithOptIn, type SettingsDocument } from '../../src/settings/types';
import { createTurnsClient, type CapturedTurnRecord } from '../../src/turns/client';
import './style.css';

const TARGET_PROVIDER_LABEL: Record<string, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  codex: 'Codex',
  claude_code: 'Claude Code',
  cursor: 'Cursor',
  other: 'Other',
};

const dispatchKindToLegacyKind = (
  kind: DispatchEventRecord['kind'],
): LegacyDispatchEvent['dispatchKind'] => {
  switch (kind) {
    case 'research':
      return 'research_packet';
    case 'coding':
      return 'coding_agent_packet';
    case 'review':
      return 'submit_back';
    case 'note':
    case 'other':
      return 'dispatch_out';
  }
};

const dispatchStatusToLegacyStatus = (
  status: DispatchEventRecord['status'],
): LegacyDispatchEvent['status'] => {
  if (status === 'replied' || status === 'noted' || status === 'pending') {
    return status;
  }
  return 'sent';
};

const recordToLegacyEvent = (record: DispatchEventRecord): LegacyDispatchEvent => ({
  bac_id: record.bac_id,
  sourceTitle: record.title,
  targetProviderLabel: TARGET_PROVIDER_LABEL[record.target.provider] ?? record.target.provider,
  targetThreadTitle: 'new chat',
  dispatchKind: dispatchKindToLegacyKind(record.kind),
  dispatchedAt: record.createdAt,
  status: dispatchStatusToLegacyStatus(record.status),
});

const sendRequest = async (request: WorkboardRequest): Promise<WorkboardState> => {
  const response = (await chrome.runtime.sendMessage(request)) as unknown;
  if (!isRuntimeResponse(response)) {
    throw new Error('Sidetrack background returned an invalid response.');
  }
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response.state;
};

const providerLabel = (provider: TrackedThread['provider']): string => {
  if (provider === 'chatgpt') {
    return 'ChatGPT';
  }
  if (provider === 'claude') {
    return 'Claude';
  }
  if (provider === 'gemini') {
    return 'Gemini';
  }
  return 'Generic';
};

const privacyLabel = (privacy: PrivacyMode): string => {
  if (privacy === 'private') {
    return 'Private';
  }
  if (privacy === 'public') {
    return 'Public';
  }
  return 'Shared';
};

const formatRelative = (isoDate: string): string => {
  const then = Date.parse(isoDate);
  if (Number.isNaN(then)) {
    return 'recently';
  }
  const seconds = Math.max(1, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) {
    return `${String(seconds)} sec ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${String(minutes)} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${String(hours)} hr ago`;
  }
  return `${String(Math.round(hours / 24))} days ago`;
};

const checklistId = (): string => `check_${crypto.randomUUID().replaceAll('-', '_')}`;

const SETUP_COMPLETED_KEY = 'sidetrack:setupCompleted';
const CODING_SESSIONS_KEY = 'sidetrack:codingSessions';

interface StoredCodingSession {
  readonly tool: string;
  readonly cwd: string;
  readonly branch: string;
  readonly sessionId: string;
  readonly name: string;
  readonly resumeCommand: string;
  readonly workstreamId: string;
  readonly attachedAt: string;
}

const writeCodingSession = async (session: StoredCodingSession): Promise<void> => {
  const result = await chrome.storage.local.get({ [CODING_SESSIONS_KEY]: [] });
  const existing = result[CODING_SESSIONS_KEY];
  const list = Array.isArray(existing) ? (existing as StoredCodingSession[]) : [];
  await chrome.storage.local.set({ [CODING_SESSIONS_KEY]: [session, ...list].slice(0, 50) });
};

const readCodingSessions = async (): Promise<readonly StoredCodingSession[]> => {
  const result = await chrome.storage.local.get({ [CODING_SESSIONS_KEY]: [] });
  const list = result[CODING_SESSIONS_KEY];
  return Array.isArray(list) ? (list as StoredCodingSession[]) : [];
};
const DEFAULT_VAULT_PATH = '~/Documents/Sidetrack-vault';

const readSetupCompleted = async (): Promise<boolean> => {
  const result = await chrome.storage.local.get({ [SETUP_COMPLETED_KEY]: false });
  return result[SETUP_COMPLETED_KEY] === true;
};

const writeSetupCompleted = async (): Promise<void> => {
  await chrome.storage.local.set({ [SETUP_COMPLETED_KEY]: true });
};

const workstreamPath = (
  workstreamId: string | undefined,
  workstreams: readonly WorkstreamNode[],
): string => {
  if (workstreamId === undefined) {
    return 'Needs organize';
  }

  const byId = new Map(workstreams.map((workstream) => [workstream.bac_id, workstream]));
  const visited = new Set<string>();
  const titles: string[] = [];
  let cursor = byId.get(workstreamId);

  while (cursor !== undefined && !visited.has(cursor.bac_id)) {
    visited.add(cursor.bac_id);
    titles.unshift(cursor.title);
    cursor = cursor.parentId === undefined ? undefined : byId.get(cursor.parentId);
  }

  return titles.length > 0 ? titles.join(' / ') : 'Needs organize';
};

const buildWorkstreamOptions = (
  workstreams: readonly WorkstreamNode[],
): readonly WorkstreamOption[] =>
  workstreams.map((workstream) => ({
    bac_id: workstream.bac_id,
    path: workstreamPath(workstream.bac_id, workstreams),
  }));

const isThreadPrivate = (thread: TrackedThread, workstreams: readonly WorkstreamNode[]): boolean =>
  workstreams.some(
    (workstream) =>
      workstream.bac_id === thread.primaryWorkstreamId && workstream.privacy === 'private',
  );

const visibleThreads = (threads: readonly TrackedThread[]): readonly TrackedThread[] =>
  threads.filter((thread) => thread.status !== 'removed' && thread.trackingMode !== 'removed');

const reminderCardStatus = (status: InboundReminder['status']): InboundCardReminder['status'] => {
  if (status === 'dismissed') {
    return 'dismissed';
  }
  if (status === 'seen' || status === 'relevant') {
    return 'seen';
  }
  return 'unseen';
};

const restoreStrategyForThread = (thread: TrackedThread): RestoreStrategy =>
  thread.tabSnapshot?.tabId === undefined ? 'reopen_url' : 'focus_open';

const WorkstreamLine = ({
  node,
  all,
  selectedId,
  onSelect,
  depth = 0,
}: {
  readonly node: WorkstreamNode;
  readonly all: readonly WorkstreamNode[];
  readonly selectedId: string;
  readonly onSelect: (workstreamId: string) => void;
  readonly depth?: number;
}) => (
  <>
    <li className="tree-line" style={{ '--depth': String(depth) } as CSSProperties}>
      <button
        className={'tree-button' + (selectedId === node.bac_id ? ' selected' : '')}
        onClick={() => {
          onSelect(node.bac_id);
        }}
        type="button"
      >
        <span>{node.title}</span>
        <span className="muted">{privacyLabel(node.privacy)}</span>
      </button>
    </li>
    {node.children
      .map((childId) => all.find((candidate) => candidate.bac_id === childId))
      .filter((child): child is WorkstreamNode => child !== undefined)
      .map((child) => (
        <WorkstreamLine
          all={all}
          depth={depth + 1}
          key={child.bac_id}
          node={child}
          onSelect={onSelect}
          selectedId={selectedId}
        />
      ))}
  </>
);

const App = () => {
  const [state, setState] = useState<WorkboardState>(() => createEmptyWorkboardState());
  const [bridgeKey, setBridgeKey] = useState('');
  const [port, setPort] = useState('17373');
  const [workstreamTitle, setWorkstreamTitle] = useState('');
  const [queueText, setQueueText] = useState('');
  const [checklistText, setChecklistText] = useState('');
  const [tagText, setTagText] = useState('');
  const [selectedWorkstream, setSelectedWorkstream] = useState('');
  const [selectedThread, setSelectedThread] = useState('');
  const [moveThreadId, setMoveThreadId] = useState<string | null>(null);
  const [recoveryThreadId, setRecoveryThreadId] = useState<string | null>(null);
  const [expandedWorkstreamId, setExpandedWorkstreamId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [composeThreadId, setComposeThreadId] = useState<string | null>(null);
  const [pendingDispatch, setPendingDispatch] = useState<ComposedPacket | null>(null);
  const [recentDispatches, setRecentDispatches] = useState<readonly DispatchEventRecord[]>([]);
  const [dispatchInFlight, setDispatchInFlight] = useState(false);
  const [reviewThreadId, setReviewThreadId] = useState<string | null>(null);
  const [reviewInFlight, setReviewInFlight] = useState(false);
  const [reviewTurnsByUrl, setReviewTurnsByUrl] = useState<ReadonlyMap<string, readonly CapturedTurnRecord[]>>(
    () => new Map<string, readonly CapturedTurnRecord[]>(),
  );
  const [settings, setSettings] = useState<SettingsDocument | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [codingAttachOpen, setCodingAttachOpen] = useState(false);
  const [codingSessions, setCodingSessions] = useState<readonly StoredCodingSession[]>([]);
  const [setupCompleted, setSetupCompleted] = useState<boolean | null>(null);
  const [stateLoaded, setStateLoaded] = useState(false);
  const [vaultPath, setVaultPath] = useState(DEFAULT_VAULT_PATH);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [captureToastHost, setCaptureToastHost] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const threads = useMemo(() => visibleThreads(state.threads), [state.threads]);
  const rootWorkstreams = useMemo(
    () => state.workstreams.filter((workstream) => workstream.parentId === undefined),
    [state.workstreams],
  );
  const workstreamOptions = useMemo(
    () => buildWorkstreamOptions(state.workstreams),
    [state.workstreams],
  );
  const activeWorkstream = useMemo(
    () => state.workstreams.find((workstream) => workstream.bac_id === selectedWorkstream),
    [selectedWorkstream, state.workstreams],
  );
  const moveThread = useMemo(
    () => threads.find((thread) => thread.bac_id === moveThreadId),
    [moveThreadId, threads],
  );
  const recoveryThread = useMemo(
    () => threads.find((thread) => thread.bac_id === recoveryThreadId),
    [recoveryThreadId, threads],
  );
  const composeThread = useMemo(
    () => threads.find((thread) => thread.bac_id === composeThreadId),
    [composeThreadId, threads],
  );
  const reviewThread = useMemo(
    () => threads.find((thread) => thread.bac_id === reviewThreadId),
    [reviewThreadId, threads],
  );
  const composeWorkstream = useMemo(() => {
    if (composeThread === undefined) {
      return undefined;
    }
    return state.workstreams.find(
      (workstream) => workstream.bac_id === composeThread.primaryWorkstreamId,
    );
  }, [composeThread, state.workstreams]);
  const recentDispatchEvents = useMemo<readonly LegacyDispatchEvent[]>(
    () => recentDispatches.map(recordToLegacyEvent),
    [recentDispatches],
  );

  interface WorkstreamCardSummary {
    readonly bac_id: string | null; // null for the synthetic "Inbox / unplaced" card
    readonly title: string;
    readonly threadCount: number;
    readonly queuedCount: number;
    readonly closedCount: number;
    readonly hasInbound: boolean;
  }

  const workstreamCards = useMemo<readonly WorkstreamCardSummary[]>(() => {
    const summaries: WorkstreamCardSummary[] = [];
    for (const ws of state.workstreams) {
      if (ws.parentId !== undefined) {
        continue; // only top-level cards in Active Work; sub-workstreams render in detail
      }
      const wsThreads = threads.filter((t) => t.primaryWorkstreamId === ws.bac_id);
      summaries.push({
        bac_id: ws.bac_id,
        title: ws.title,
        threadCount: wsThreads.length,
        queuedCount: state.queueItems.filter((q) => q.targetId === ws.bac_id).length,
        closedCount: wsThreads.filter((t) => t.status === 'closed' || t.status === 'restorable').length,
        hasInbound: state.reminders.some((r) => wsThreads.some((t) => t.bac_id === r.threadId)),
      });
    }
    const unplacedThreads = threads.filter((t) => t.primaryWorkstreamId === undefined);
    if (unplacedThreads.length > 0) {
      summaries.push({
        bac_id: null,
        title: 'Inbox · unplaced',
        threadCount: unplacedThreads.length,
        queuedCount: 0,
        closedCount: unplacedThreads.filter((t) => t.status === 'closed' || t.status === 'restorable')
          .length,
        hasInbound: false,
      });
    }
    return summaries;
  }, [state.workstreams, state.queueItems, state.reminders, threads]);

  const expandedWorkstream = useMemo(
    () =>
      expandedWorkstreamId === null
        ? null
        : (state.workstreams.find((w) => w.bac_id === expandedWorkstreamId) ?? null),
    [expandedWorkstreamId, state.workstreams],
  );

  const expandedWorkstreamThreads = useMemo<readonly TrackedThread[]>(() => {
    if (expandedWorkstreamId === null) {
      return threads.filter((t) => t.primaryWorkstreamId === undefined);
    }
    return threads.filter((t) => t.primaryWorkstreamId === expandedWorkstreamId);
  }, [expandedWorkstreamId, threads]);

  const filteredRecent = useMemo<readonly TrackedThread[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    if (q.length === 0) {
      return threads.slice(0, 5);
    }
    return threads
      .filter(
        (t) => t.title.toLowerCase().includes(q) || t.threadUrl.toLowerCase().includes(q),
      )
      .slice(0, 10);
  }, [searchQuery, threads]);

  const refresh = async () => {
    const next = await sendRequest({ type: messageTypes.getWorkboardState });
    setState(next);
    setBridgeKey(next.settings.companion.bridgeKey);
    setPort(String(next.settings.companion.port));
    setError(next.lastError ?? null);
    if (next.vaultPath !== undefined) {
      setVaultPath(next.vaultPath);
    }
    if (selectedWorkstream === '' && next.workstreams.length > 0) {
      setSelectedWorkstream(next.workstreams[0]?.bac_id ?? '');
    }
  };

  useEffect(() => {
    void refresh()
      .catch((loadError: unknown) => {
        setError(
          loadError instanceof Error ? loadError.message : 'Could not load Sidetrack state.',
        );
      })
      .finally(() => {
        setStateLoaded(true);
      });
    void readSetupCompleted()
      .then(setSetupCompleted)
      .catch(() => {
        setSetupCompleted(false);
      });
  }, []);

  useEffect(() => {
    const runtimeMessages = chrome.runtime.onMessage;
    let pendingRefresh: number | undefined;
    const listener = (message: unknown) => {
      if (isCaptureFeedbackMessage(message)) {
        setCaptureToastHost(message.host);
        return;
      }
      if (isWorkboardChangedMessage(message)) {
        // Debounce bursts of mutations into one refresh.
        if (pendingRefresh !== undefined) {
          window.clearTimeout(pendingRefresh);
        }
        pendingRefresh = window.setTimeout(() => {
          pendingRefresh = undefined;
          void refresh().catch(() => {
            // Silent: SystemBanners covers the broader companion/vault state.
          });
        }, 150);
      }
    };
    runtimeMessages.addListener(listener);
    return () => {
      runtimeMessages.removeListener(listener);
      if (pendingRefresh !== undefined) {
        window.clearTimeout(pendingRefresh);
      }
    };
  }, []);

  useEffect(() => {
    if (captureToastHost === null) {
      return undefined;
    }
    const timeoutId = window.setTimeout(() => {
      setCaptureToastHost(null);
    }, 3_000);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [captureToastHost]);

  useEffect(() => {
    if (state.companionStatus !== 'connected' || bridgeKey.length === 0) {
      return undefined;
    }
    const portNumber = Number(port);
    if (!Number.isFinite(portNumber) || portNumber <= 0) {
      return undefined;
    }
    let cancelled = false;
    const client = createDispatchClient({ port: portNumber, bridgeKey });
    client
      .listRecent({ limit: 10 })
      .then((list) => {
        if (!cancelled) {
          setRecentDispatches(list);
        }
      })
      .catch(() => {
        // Companion may not yet have the dispatches endpoint or the vault is
        // unreachable — surface nothing here; SystemBanners shows the broader
        // companion/vault state already.
      });
    return () => {
      cancelled = true;
    };
  }, [state.companionStatus, bridgeKey, port]);

  useEffect(() => {
    // Defensive auto-save: if the user typed a plausible bridge key + port in
    // the inline settings form but didn't click Connect, persist after a
    // short debounce so closing the panel doesn't lose the value. Skips when
    // the form is empty (initial state) or matches what's already persisted.
    if (!stateLoaded) {
      return undefined;
    }
    const portNumber = Number(port);
    if (!Number.isFinite(portNumber) || portNumber <= 0 || bridgeKey.trim().length === 0) {
      return undefined;
    }
    if (
      bridgeKey === state.settings.companion.bridgeKey &&
      portNumber === state.settings.companion.port
    ) {
      return undefined;
    }
    const handle = window.setTimeout(() => {
      void runAction(() =>
        sendRequest({
          type: messageTypes.saveCompanionSettings,
          settings: { bridgeKey, port: portNumber },
        }),
      );
    }, 700);
    return () => {
      window.clearTimeout(handle);
    };
  }, [bridgeKey, port, stateLoaded, state.settings.companion.bridgeKey, state.settings.companion.port]);

  useEffect(() => {
    if (
      reviewThread === undefined ||
      bridgeKey.length === 0 ||
      reviewTurnsByUrl.has(reviewThread.threadUrl)
    ) {
      return undefined;
    }
    const portNumber = Number(port);
    if (!Number.isFinite(portNumber) || portNumber <= 0) {
      return undefined;
    }
    let cancelled = false;
    const client = createTurnsClient({ port: portNumber, bridgeKey });
    const targetUrl = reviewThread.threadUrl;
    void client
      .recentForThread(targetUrl, { limit: 5, role: 'assistant' })
      .then((list) => {
        if (!cancelled) {
          setReviewTurnsByUrl((prev) => new Map(prev).set(targetUrl, list));
        }
      })
      .catch(() => {
        // Companion older than turns endpoint, or vault unreachable. Fall back
        // to thread-title synthetic span.
        if (!cancelled) {
          setReviewTurnsByUrl((prev) => new Map(prev).set(targetUrl, []));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reviewThread, bridgeKey, port, reviewTurnsByUrl]);

  useEffect(() => {
    let cancelled = false;
    void readCodingSessions()
      .then((list) => {
        if (!cancelled) {
          setCodingSessions(list);
        }
      })
      .catch(() => {
        // chrome.storage unavailable in test/dev — leave the list empty.
      });
    return () => {
      cancelled = true;
    };
  }, [codingAttachOpen]);

  useEffect(() => {
    if (state.companionStatus !== 'connected' || bridgeKey.length === 0) {
      return undefined;
    }
    const portNumber = Number(port);
    if (!Number.isFinite(portNumber) || portNumber <= 0) {
      return undefined;
    }
    let cancelled = false;
    const client = createSettingsClient({ port: portNumber, bridgeKey });
    client
      .read()
      .then((document) => {
        if (!cancelled) {
          setSettings(document);
        }
      })
      .catch(() => {
        // Companion may not yet have the settings endpoint; SystemBanners
        // already covers companion/vault state.
      });
    return () => {
      cancelled = true;
    };
  }, [state.companionStatus, bridgeKey, port]);

  const runAction = async (action: () => Promise<WorkboardState>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setState(next);
      setError(next.lastError ?? null);
      setBridgeKey(next.settings.companion.bridgeKey);
      setPort(String(next.settings.companion.port));
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Sidetrack action failed.');
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runAction(() =>
      sendRequest({
        type: messageTypes.saveCompanionSettings,
        settings: { bridgeKey, port: Number(port) },
      }),
    );
  };

  const completeSetup = async (saveCompanionFirst: boolean): Promise<void> => {
    if (saveCompanionFirst) {
      await runAction(() =>
        sendRequest({
          type: messageTypes.saveCompanionSettings,
          settings: { bridgeKey, port: Number(port) },
        }),
      );
    }
    await writeSetupCompleted();
    setSetupCompleted(true);
    setWizardOpen(false);
  };

  const createWorkstream = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!workstreamTitle.trim()) {
      return;
    }
    void runAction(async () => {
      const next = await sendRequest({
        type: messageTypes.createWorkstream,
        workstream: {
          title: workstreamTitle.trim(),
          ...(selectedWorkstream ? { parentId: selectedWorkstream } : {}),
          privacy: 'private',
        },
      });
      setWorkstreamTitle('');
      return next;
    });
  };

  const handleMoveTarget = (target: WorkstreamOption | { readonly create: string }) => {
    if (moveThreadId === null) {
      return;
    }

    void runAction(async () => {
      if ('create' in target) {
        const afterCreate = await sendRequest({
          type: messageTypes.createWorkstream,
          workstream: { title: target.create, privacy: 'private' },
        });
        const created = afterCreate.workstreams.find(
          (workstream) => workstream.title === target.create && workstream.parentId === undefined,
        );
        if (created === undefined) {
          setMoveThreadId(null);
          return afterCreate;
        }
        const afterMove = await sendRequest({
          type: messageTypes.moveThread,
          threadId: moveThreadId,
          workstreamId: created.bac_id,
        });
        setMoveThreadId(null);
        return afterMove;
      }

      const next = await sendRequest({
        type: messageTypes.moveThread,
        threadId: moveThreadId,
        workstreamId: target.bac_id,
      });
      setMoveThreadId(null);
      return next;
    });
  };

  const restoreThread = (threadId: string) => {
    void runAction(() =>
      sendRequest({
        type: messageTypes.restoreThreadTab,
        threadId,
      }),
    );
  };

  const updateTracking = (threadId: string, trackingMode: TrackedThread['trackingMode']) => {
    void runAction(() =>
      sendRequest({
        type: messageTypes.updateThreadTracking,
        threadId,
        trackingMode,
      }),
    );
  };

  const handlePacketDispatch = (packet: ComposedPacket) => {
    setPendingDispatch(packet);
    setComposeThreadId(null);
  };

  const handlePacketSave = (packet: ComposedPacket) => {
    // Save-to-vault routes through the same companion endpoint with status:'noted'.
    setPendingDispatch({ ...packet });
    setComposeThreadId(null);
  };

  const handlePacketCopy = (packet: ComposedPacket) => {
    void navigator.clipboard
      .writeText(packet.body)
      .catch(() => {
        // Clipboard rejected (permissions, focus); fall through silently.
      });
    setComposeThreadId(null);
  };

  const submitPendingDispatch = async () => {
    if (pendingDispatch === null || bridgeKey.length === 0) {
      return;
    }
    const portNumber = Number(port);
    if (!Number.isFinite(portNumber) || portNumber <= 0) {
      setError('Invalid companion port.');
      return;
    }
    setDispatchInFlight(true);
    setError(null);
    try {
      const client = createDispatchClient({ port: portNumber, bridgeKey });
      const idempotencyKey = `disp_ui_${String(Date.now())}_${Math.random().toString(36).slice(2, 10)}`;
      const provider = mapUiTarget(pendingDispatch.target);
      const mode: DispatchMode =
        settings !== null && isProviderWithOptIn(provider) && settings.autoSendOptIn[provider]
          ? 'auto-send'
          : 'paste';
      await client.submit(
        {
          kind: mapUiPacketKind(pendingDispatch.kind),
          target: { provider, mode },
          title: pendingDispatch.title,
          body: pendingDispatch.body,
          ...(pendingDispatch.sourceThreadId !== undefined
            ? { sourceThreadId: pendingDispatch.sourceThreadId }
            : {}),
          ...(pendingDispatch.workstreamId !== undefined
            ? { workstreamId: pendingDispatch.workstreamId }
            : {}),
        },
        idempotencyKey,
      );
      const refreshed = await client.listRecent({ limit: 10 });
      setRecentDispatches(refreshed);
      setPendingDispatch(null);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Dispatch failed.');
    } finally {
      setDispatchInFlight(false);
    }
  };

  const handleSettingsSave = (next: {
    readonly autoSendOptIn: SettingsValue['autoSendOptIn'];
    readonly defaultPacketKind: SettingsValue['defaultPacketKind'];
    readonly defaultDispatchTarget: SettingsValue['defaultDispatchTarget'];
    readonly screenShareSafeMode: boolean;
  }) => {
    if (settings === null || bridgeKey.length === 0) {
      setSettingsError('Connect the companion first to save settings.');
      return;
    }
    const portNumber = Number(port);
    if (!Number.isFinite(portNumber) || portNumber <= 0) {
      setSettingsError('Invalid companion port.');
      return;
    }
    setSettingsBusy(true);
    setSettingsError(null);
    const client = createSettingsClient({ port: portNumber, bridgeKey });
    void client
      .patch({
        revision: settings.revision,
        autoSendOptIn: next.autoSendOptIn,
        defaultPacketKind: next.defaultPacketKind,
        defaultDispatchTarget: next.defaultDispatchTarget,
        screenShareSafeMode: next.screenShareSafeMode,
      })
      .then((updated) => {
        setSettings(updated);
        setSettingsOpen(false);
      })
      .catch((settingsErr: unknown) => {
        setSettingsError(
          settingsErr instanceof Error ? settingsErr.message : 'Could not save settings.',
        );
      })
      .finally(() => {
        setSettingsBusy(false);
      });
  };

  const submitReview = async (
    thread: TrackedThread,
    payload: { readonly verdict: ReviewVerdict; readonly reviewerNote: string; readonly perSpan: Record<string, string> },
    outcome: ReviewOutcome,
    spanContext: ReadonlyMap<string, { readonly text: string; readonly ordinal: number; readonly capturedAt?: string }>,
  ): Promise<boolean> => {
    if (bridgeKey.length === 0) {
      setError('Connect the companion to record reviews.');
      return false;
    }
    const portNumber = Number(port);
    if (!Number.isFinite(portNumber) || portNumber <= 0) {
      setError('Invalid companion port.');
      return false;
    }
    const trimmedNote = payload.reviewerNote.trim();
    if (trimmedNote.length === 0) {
      setError('Reviewer note is required before saving the review.');
      return false;
    }
    setReviewInFlight(true);
    setError(null);
    try {
      const client = createReviewClient({ port: portNumber, bridgeKey });
      const idempotencyKey = `rev_ui_${String(Date.now())}_${Math.random().toString(36).slice(2, 10)}`;
      const spans = Object.entries(payload.perSpan)
        .filter(([, comment]) => comment.trim().length > 0)
        .map(([id, comment]) => {
          const context = spanContext.get(id);
          return {
            id,
            text: context?.text ?? thread.title,
            comment: comment.trim(),
            ...(context?.capturedAt !== undefined ? { capturedAt: context.capturedAt } : {}),
          };
        });
      const firstWithComment = Object.entries(payload.perSpan).find(
        ([, comment]) => comment.trim().length > 0,
      );
      const sourceTurnOrdinal =
        firstWithComment !== undefined ? (spanContext.get(firstWithComment[0])?.ordinal ?? 0) : 0;
      await client.submit(
        {
          sourceThreadId: thread.bac_id,
          sourceTurnOrdinal,
          provider: thread.provider,
          verdict: payload.verdict,
          reviewerNote: trimmedNote,
          spans,
          outcome,
        },
        idempotencyKey,
      );
      return true;
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Review failed.');
      return false;
    } finally {
      setReviewInFlight(false);
    }
  };

  const queueFollowUp = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!queueText.trim()) {
      return;
    }
    void runAction(async () => {
      const next = await sendRequest({
        type: messageTypes.queueFollowUp,
        item: {
          text: queueText.trim(),
          scope: selectedThread ? 'thread' : selectedWorkstream ? 'workstream' : 'global',
          ...(selectedThread
            ? { targetId: selectedThread }
            : selectedWorkstream
              ? { targetId: selectedWorkstream }
              : {}),
        },
      });
      setQueueText('');
      return next;
    });
  };

  const updateWorkstream = (
    workstream: WorkstreamNode,
    update: Omit<WorkstreamUpdate, 'revision'>,
  ) => {
    void runAction(() =>
      sendRequest({
        type: messageTypes.updateWorkstream,
        workstreamId: workstream.bac_id,
        update: {
          revision: workstream.revision,
          ...update,
        },
      }),
    );
  };

  const togglePrivacy = (workstream: WorkstreamNode) => {
    const nextPrivacy: PrivacyMode = workstream.privacy === 'private' ? 'shared' : 'private';
    updateWorkstream(workstream, { privacy: nextPrivacy });
  };

  const addChecklistItem = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (activeWorkstream === undefined || !checklistText.trim()) {
      return;
    }
    const timestamp = new Date().toISOString();
    const item: ChecklistItem = {
      id: checklistId(),
      text: checklistText.trim(),
      checked: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    void runAction(async () => {
      const next = await sendRequest({
        type: messageTypes.updateWorkstream,
        workstreamId: activeWorkstream.bac_id,
        update: {
          revision: activeWorkstream.revision,
          checklist: [...activeWorkstream.checklist, item],
        },
      });
      setChecklistText('');
      return next;
    });
  };

  const toggleChecklistItem = (workstream: WorkstreamNode, itemId: string) => {
    const timestamp = new Date().toISOString();
    void runAction(() =>
      sendRequest({
        type: messageTypes.updateWorkstream,
        workstreamId: workstream.bac_id,
        update: {
          revision: workstream.revision,
          checklist: workstream.checklist.map((item) =>
            item.id === itemId ? { ...item, checked: !item.checked, updatedAt: timestamp } : item,
          ),
        },
      }),
    );
  };

  const addTag = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (activeWorkstream === undefined || !tagText.trim()) {
      return;
    }
    const tag = tagText.trim();
    void runAction(async () => {
      const next = await sendRequest({
        type: messageTypes.updateWorkstream,
        workstreamId: activeWorkstream.bac_id,
        update: {
          revision: activeWorkstream.revision,
          tags: [...new Set([...activeWorkstream.tags, tag])],
        },
      });
      setTagText('');
      return next;
    });
  };

  const updateReminderStatus = (reminderId: string, status: InboundReminder['status']) => {
    void runAction(() =>
      sendRequest({
        type: messageTypes.updateReminder,
        reminderId,
        update: { status },
      }),
    );
  };

  const toggleSection = (sectionId: (typeof initialWorkboardSections)[number]['id']) => {
    const collapsed = state.collapsedSections.includes(sectionId)
      ? state.collapsedSections.filter((id) => id !== sectionId)
      : [...state.collapsedSections, sectionId];
    void runAction(() =>
      sendRequest({
        type: messageTypes.setCollapsedSections,
        collapsedSections: collapsed,
      }),
    );
  };

  const providerHealth = state.selectorHealth.find((entry) => entry.latestStatus !== 'ok');
  const selectedWorkstreamQueue = activeWorkstream
    ? state.queueItems.filter((item) => item.targetId === activeWorkstream.bac_id)
    : [];
  const firstLaunch =
    stateLoaded && setupCompleted === false && bridgeKey.trim().length === 0;
  const showWizard = firstLaunch || wizardOpen;
  const companionDisconnected =
    bridgeKey.trim().length === 0 || state.companionStatus === 'disconnected';
  const vaultUnreachable = state.companionStatus === 'vault-error';
  const hasSystemBanners =
    companionDisconnected ||
    vaultUnreachable ||
    providerHealth !== undefined ||
    state.queuedCaptureCount > 0 ||
    captureToastHost !== null;

  return (
    <main className="workboard" aria-label="Sidetrack workboard">
      <header className="workboard-header">
        <div>
          <p className="eyebrow">Sidetrack</p>
          <h1>Current Work</h1>
          <p className="subtle">
            vault: {state.companionStatus === 'vault-error' ? 'error' : 'connected'}
          </p>
        </div>
        <div className="header-actions">
          <span className={`status-pill ${state.companionStatus}`}>
            {companionStatusLabel(state.companionStatus)}
          </span>
          <button
            className="btn btn-ghost"
            onClick={() => {
              setCodingAttachOpen(true);
            }}
            type="button"
          >
            Coding session
          </button>
          <button
            className="btn btn-ghost"
            disabled={state.companionStatus !== 'connected' || bridgeKey.length === 0}
            onClick={() => {
              setSettingsOpen(true);
            }}
            type="button"
          >
            Settings
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => {
              setWizardOpen(true);
            }}
            type="button"
          >
            Setup wizard
          </button>
        </div>
      </header>

      {hasSystemBanners ? (
        <div className="banner-stack">
          <SystemBannersStack
            captureSuccessHost={captureToastHost ?? undefined}
            companionActionLabel="Open setup"
            companionStatus={companionDisconnected ? 'down' : 'running'}
            vaultStatus={vaultUnreachable ? 'unreachable' : 'connected'}
            providerHealth={providerHealth ? 'degraded' : 'ok'}
            providerHealthDetail={providerHealth?.warning}
            queuedCount={state.queuedCaptureCount}
            onQueueDiagnostic={() => {
              void refresh();
            }}
            onRePickVault={() => {
              setWizardOpen(true);
            }}
            onRetryCompanion={() => {
              setWizardOpen(true);
            }}
          />
        </div>
      ) : null}

      {error ? <div className="banner danger">{error}</div> : null}

      <section className="toolbar">
        <button
          disabled={busy}
          onClick={() => {
            void runAction(() => sendRequest({ type: messageTypes.captureCurrentTab }));
          }}
          type="button"
        >
          Track current tab
        </button>
        <button
          disabled={busy}
          onClick={() => {
            void refresh();
          }}
          type="button"
        >
          Refresh
        </button>
      </section>

      <form className="settings-row" onSubmit={saveSettings}>
        <label>
          Port
          <input
            inputMode="numeric"
            onChange={(event) => {
              setPort(event.target.value);
            }}
            value={port}
          />
        </label>
        <label>
          Bridge key
          <input
            onChange={(event) => {
              setBridgeKey(event.target.value);
            }}
            type="password"
            value={bridgeKey}
          />
        </label>
        <button disabled={busy} type="submit">
          Connect
        </button>
      </form>

      <section className="section-list" aria-label="Workboard sections">
        {initialWorkboardSections.map((section) => {
          const collapsed = state.collapsedSections.includes(section.id);
          return (
            <article className="section-row" key={section.id}>
              <button
                className="section-heading"
                onClick={() => {
                  toggleSection(section.id);
                }}
                type="button"
              >
                <h2>{section.label}</h2>
                <span className="mono">{collapsed ? 'show' : 'hide'}</span>
              </button>
              {collapsed ? null : (
                <>
                  {section.id === 'current-tab' ? (
                    state.currentTab ? (
                      <div className="current-tab-row">
                        <div className="current-tab-title">
                          <strong>{state.currentTab.title}</strong>
                          <span className={'chip chip-' + state.currentTab.provider}>
                            {providerLabel(state.currentTab.provider)}
                          </span>
                        </div>
                        <div className="current-tab-actions">
                          <button
                            className="btn-link"
                            disabled={busy}
                            onClick={() => {
                              void runAction(() =>
                                sendRequest({ type: messageTypes.captureCurrentTab }),
                              );
                            }}
                            type="button"
                          >
                            Track
                          </button>
                          <button
                            className="btn-link"
                            disabled={
                              state.companionStatus !== 'connected' || bridgeKey.length === 0
                            }
                            onClick={() => {
                              if (state.currentTab !== undefined) {
                                setComposeThreadId(state.currentTab.bac_id);
                              }
                            }}
                            type="button"
                          >
                            Packet
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p>{section.emptyText}</p>
                    )
                  ) : null}
                  {section.id === 'active-work' ? (
                    expandedWorkstreamId === null ? (
                      <div className="ws-cards">
                        {workstreamCards.length === 0 ? <p>{section.emptyText}</p> : null}
                        {workstreamCards.map((card) => (
                          <button
                            type="button"
                            className="ws-card"
                            key={card.bac_id ?? '__inbox'}
                            onClick={() => {
                              setExpandedWorkstreamId(card.bac_id);
                              setSelectedWorkstream(card.bac_id ?? '');
                            }}
                          >
                            <div className="ws-card-head">
                              <strong>{card.title}</strong>
                              {card.hasInbound ? <span className="dot signal" aria-hidden /> : null}
                            </div>
                            <div className="ws-card-meta mono">
                              {card.threadCount} thread{card.threadCount === 1 ? '' : 's'} ·{' '}
                              {card.queuedCount} queued · {card.closedCount} closed
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="ws-detail-inline">
                        <button
                          type="button"
                          className="btn-link ws-back"
                          onClick={() => {
                            setExpandedWorkstreamId(null);
                          }}
                        >
                          ← Active work
                        </button>
                        <div className="ws-detail-head">
                          <strong>
                            {expandedWorkstream === null
                              ? 'Inbox · unplaced'
                              : workstreamPath(expandedWorkstream.bac_id, state.workstreams)}
                          </strong>
                          {expandedWorkstream !== null ? (
                            <span className="subtle mono">
                              {privacyLabel(expandedWorkstream.privacy)}
                              {expandedWorkstream.tags.length > 0
                                ? ' · ' + expandedWorkstream.tags.join(', ')
                                : ''}
                            </span>
                          ) : null}
                        </div>
                        <div className="item-list">
                          {expandedWorkstreamThreads.length === 0 ? (
                            <p>No threads here yet.</p>
                          ) : null}
                          {expandedWorkstreamThreads.map((thread) => (
                            <div className="thread-row" key={thread.bac_id}>
                              <div>
                                <strong>{maskTitleForPrivacy(thread, state.workstreams)}</strong>
                                <p>
                                  {providerLabel(thread.provider)} / {thread.trackingMode} /{' '}
                                  {thread.status}
                                </p>
                              </div>
                              <div className="thread-actions">
                                <button
                                  className="btn-link"
                                  disabled={
                                    state.companionStatus !== 'connected' ||
                                    bridgeKey.length === 0
                                  }
                                  onClick={() => {
                                    setComposeThreadId(thread.bac_id);
                                  }}
                                  type="button"
                                >
                                  Send to…
                                </button>
                                <button
                                  className="btn-link"
                                  disabled={
                                    state.companionStatus !== 'connected' ||
                                    bridgeKey.length === 0
                                  }
                                  onClick={() => {
                                    setReviewThreadId(thread.bac_id);
                                  }}
                                  type="button"
                                >
                                  Review
                                </button>
                                <button
                                  className="btn-link"
                                  onClick={() => {
                                    setMoveThreadId(thread.bac_id);
                                  }}
                                  type="button"
                                >
                                  Move to…
                                </button>
                                {thread.trackingMode === 'stopped' ? (
                                  <button
                                    className="btn-link"
                                    onClick={() => {
                                      updateTracking(
                                        thread.bac_id,
                                        thread.provider === 'unknown' ? 'manual' : 'auto',
                                      );
                                    }}
                                    type="button"
                                  >
                                    Resume
                                  </button>
                                ) : (
                                  <button
                                    className="btn-link"
                                    onClick={() => {
                                      updateTracking(thread.bac_id, 'stopped');
                                    }}
                                    type="button"
                                  >
                                    Stop
                                  </button>
                                )}
                                <button
                                  className="btn-link btn-muted"
                                  onClick={() => {
                                    updateTracking(thread.bac_id, 'removed');
                                  }}
                                  type="button"
                                >
                                  Remove
                                </button>
                                {thread.status === 'restorable' ? (
                                  <button
                                    className="btn-link"
                                    onClick={() => {
                                      setRecoveryThreadId(thread.bac_id);
                                    }}
                                    type="button"
                                  >
                                    Reopen
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  ) : null}
                  {section.id === 'queued' ? (
                    <div className="item-list">
                      {state.queueItems.length === 0 ? <p>{section.emptyText}</p> : null}
                      {state.queueItems.map((item) => {
                        const targetThread =
                          item.scope === 'thread' && item.targetId !== undefined
                            ? threads.find((t) => t.bac_id === item.targetId)
                            : undefined;
                        return (
                          <div className="queued-row" key={item.bac_id}>
                            {targetThread !== undefined ? (
                              <span className={'chip chip-' + targetThread.provider}>
                                {providerLabel(targetThread.provider)}
                              </span>
                            ) : (
                              <span className="chip chip-other mono">{item.scope}</span>
                            )}
                            <span className="queued-text">{item.text}</span>
                            <span className={'pill pill-' + item.status}>{item.status}</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                  {section.id === 'inbound' ? (
                    <div className="item-list">
                      {state.reminders.length === 0 ? <p>{section.emptyText}</p> : null}
                      {state.reminders.map((reminder) => {
                        const thread = threads.find(
                          (candidate) => candidate.bac_id === reminder.threadId,
                        );
                        return (
                          <InboundCard
                            key={reminder.bac_id}
                            masked={thread ? isThreadPrivate(thread, state.workstreams) : false}
                            reminder={{
                              bac_id: reminder.bac_id,
                              threadTitle: thread?.title ?? reminder.threadId,
                              provider: reminder.provider,
                              providerLabel: providerLabel(reminder.provider),
                              inboundTurnAt: formatRelative(reminder.detectedAt),
                              status: reminderCardStatus(reminder.status),
                              aiAuthored: true,
                            }}
                            onOpen={() => {
                              restoreThread(reminder.threadId);
                            }}
                            onMarkRelevant={() => {
                              updateReminderStatus(reminder.bac_id, 'relevant');
                            }}
                            onDismiss={() => {
                              updateReminderStatus(reminder.bac_id, 'dismissed');
                            }}
                          />
                        );
                      })}
                    </div>
                  ) : null}
                  {section.id === 'needs-organize' ? (
                    <p>
                      {threads.filter((thread) => !thread.primaryWorkstreamId).length} unplaced
                      tracked items
                    </p>
                  ) : null}
                  {section.id === 'recent-search' ? (
                    <div className="recent-search">
                      <input
                        type="search"
                        placeholder="Search threads, captures, packets…"
                        value={searchQuery}
                        onChange={(e) => {
                          setSearchQuery(e.target.value);
                        }}
                        className="recent-search-input"
                      />
                      {filteredRecent.length === 0 ? (
                        <p className="subtle">
                          {searchQuery.trim().length > 0 ? 'No matches.' : section.emptyText}
                        </p>
                      ) : null}
                      {filteredRecent.map((thread) => (
                        <button
                          type="button"
                          key={thread.bac_id}
                          className="recent-search-row"
                          onClick={() => {
                            const ws = state.workstreams.find(
                              (w) => w.bac_id === thread.primaryWorkstreamId,
                            );
                            if (ws !== undefined) {
                              setExpandedWorkstreamId(ws.bac_id);
                              setSelectedWorkstream(ws.bac_id);
                            } else {
                              setExpandedWorkstreamId(null);
                            }
                          }}
                        >
                          <span className={'chip chip-' + thread.provider}>
                            {providerLabel(thread.provider)}
                          </span>
                          <span className="recent-search-title">{thread.title}</span>
                          <span className="subtle mono">{formatRelative(thread.lastSeenAt)}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </>
              )}
            </article>
          );
        })}
      </section>

      {recentDispatchEvents.length > 0 ? (
        <section className="recent-dispatches-section" aria-label="Recent dispatches">
          <header className="section-head">
            <h2>Recent dispatches</h2>
          </header>
          <RecentDispatches dispatches={recentDispatchEvents} />
        </section>
      ) : null}

      {codingSessions.length > 0 ? (
        <section className="coding-sessions-section" aria-label="Coding sessions">
          <header className="section-head">
            <h2>Coding sessions</h2>
          </header>
          <div className="coding-sessions-list">
            {codingSessions.slice(0, 5).map((session) => (
              <div key={session.sessionId + ':' + session.attachedAt} className="coding-session-row">
                <div className="coding-session-meta">
                  <strong>{session.name || session.sessionId}</strong>
                  <span className="mono subtle">
                    {session.tool} · {workstreamPath(session.workstreamId, state.workstreams)} ·{' '}
                    {formatRelative(session.attachedAt)}
                  </span>
                  <code className="mono coding-session-cmd">{session.resumeCommand}</code>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    void navigator.clipboard.writeText(session.resumeCommand).catch(() => {
                      // Clipboard rejected (permissions, focus); silently ignore.
                    });
                  }}
                >
                  Copy
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="detail-panel">
        <div>
          <h2>Workstreams</h2>
          <ul className="tree">
            {rootWorkstreams.map((node) => (
              <WorkstreamLine
                all={state.workstreams}
                key={node.bac_id}
                node={node}
                onSelect={setSelectedWorkstream}
                selectedId={selectedWorkstream}
              />
            ))}
          </ul>
        </div>
        <form onSubmit={createWorkstream}>
          <label>
            Parent
            <select
              onChange={(event) => {
                setSelectedWorkstream(event.target.value);
              }}
              value={selectedWorkstream}
            >
              <option value="">Root</option>
              {workstreamOptions.map((workstream) => (
                <option key={workstream.bac_id} value={workstream.bac_id}>
                  {workstream.path}
                </option>
              ))}
            </select>
          </label>
          <label>
            New subcluster
            <input
              onChange={(event) => {
                setWorkstreamTitle(event.target.value);
              }}
              value={workstreamTitle}
            />
          </label>
          <button disabled={busy} type="submit">
            Create
          </button>
        </form>

        {activeWorkstream ? (
          <div className="workstream-detail">
            <div className="detail-head">
              <div>
                <h2>{workstreamPath(activeWorkstream.bac_id, state.workstreams)}</h2>
                <p className="subtle">
                  {privacyLabel(activeWorkstream.privacy)} /{' '}
                  {activeWorkstream.tags.join(', ') || 'no tags'}
                </p>
              </div>
              <button
                className="btn btn-ghost"
                onClick={() => {
                  togglePrivacy(activeWorkstream);
                }}
                type="button"
              >
                Toggle privacy
              </button>
            </div>

            <div className="checklist">
              {activeWorkstream.checklist.length === 0 ? (
                <p className="subtle">No checklist items yet.</p>
              ) : null}
              {activeWorkstream.checklist.map((item) => (
                <label className="check-row detail-check" key={item.id}>
                  <input
                    checked={item.checked}
                    onChange={() => {
                      toggleChecklistItem(activeWorkstream, item.id);
                    }}
                    type="checkbox"
                  />
                  <span>{item.text}</span>
                </label>
              ))}
            </div>

            <form className="inline-form" onSubmit={addChecklistItem}>
              <label>
                Checklist item
                <input
                  onChange={(event) => {
                    setChecklistText(event.target.value);
                  }}
                  value={checklistText}
                />
              </label>
              <button disabled={busy} type="submit">
                Add item
              </button>
            </form>

            <form className="inline-form" onSubmit={addTag}>
              <label>
                Tag
                <input
                  onChange={(event) => {
                    setTagText(event.target.value);
                  }}
                  value={tagText}
                />
              </label>
              <button disabled={busy} type="submit">
                Add tag
              </button>
            </form>

            <div className="item-list">
              <h2>Queued asks</h2>
              {selectedWorkstreamQueue.length === 0 ? (
                <p className="subtle">No queued asks for this workstream.</p>
              ) : null}
              {selectedWorkstreamQueue.map((item) => (
                <div className="compact-row" key={item.bac_id}>
                  <span>{item.text}</span>
                  <span className="status-chip">{item.status}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <form className="queue-form" onSubmit={queueFollowUp}>
        <label>
          Queue follow-up
          <input
            onChange={(event) => {
              setQueueText(event.target.value);
            }}
            value={queueText}
          />
        </label>
        <select
          onChange={(event) => {
            setSelectedThread(event.target.value);
          }}
          value={selectedThread}
        >
          <option value="">No thread target</option>
          {threads.map((thread) => (
            <option key={thread.bac_id} value={thread.bac_id}>
              {thread.title}
            </option>
          ))}
        </select>
        <button disabled={busy} type="submit">
          Queue
        </button>
      </form>

      {moveThread ? (
        <MoveToPicker
          currentPath={workstreamPath(moveThread.primaryWorkstreamId, state.workstreams)}
          itemTitle={moveThread.title}
          onClose={() => {
            setMoveThreadId(null);
          }}
          onMove={handleMoveTarget}
          workstreams={workstreamOptions}
        />
      ) : null}

      {composeThread ? (
        <PacketComposer
          defaultTitle={composeThread.title}
          defaultBody={`# ${composeThread.title}\n\n## Source thread\n${providerLabel(composeThread.provider)} · ${composeThread.threadUrl}\n\n## Context\n…\n\n## Ask\n…`}
          {...(settings !== null
            ? { defaultKind: dispatchKindToUiPacketKind(settings.defaultPacketKind) }
            : {})}
          scope={{
            label: composeThread.title,
            meta: `${providerLabel(composeThread.provider)} · ${formatRelative(composeThread.lastSeenAt)}`,
            sourceThreadId: composeThread.bac_id,
            ...(composeWorkstream !== undefined ? { workstreamId: composeWorkstream.bac_id } : {}),
          }}
          onCancel={() => {
            setComposeThreadId(null);
          }}
          onCopy={handlePacketCopy}
          onSave={handlePacketSave}
          onDispatch={handlePacketDispatch}
        />
      ) : null}

      {pendingDispatch ? (
        <DispatchConfirm
          target={
            TARGET_PROVIDER_LABEL[mapUiTarget(pendingDispatch.target)] ??
            mapUiTarget(pendingDispatch.target)
          }
          tokenEstimate={pendingDispatch.tokenEstimate}
          redactedCount={pendingDispatch.redactedItems.reduce((sum, r) => sum + r.count, 0)}
          {...(pendingDispatch.redactedItems.length > 0
            ? {
                redactedKinds: pendingDispatch.redactedItems.map(
                  (r) => `${String(r.count)} ${r.kind}`,
                ),
              }
            : {})}
          onCancel={() => {
            setPendingDispatch(null);
          }}
          onEdit={() => {
            setComposeThreadId(pendingDispatch.sourceThreadId ?? composeThreadId);
            setPendingDispatch(null);
          }}
          onConfirm={() => {
            if (!dispatchInFlight) {
              void submitPendingDispatch();
            }
          }}
        />
      ) : null}

      {reviewThread
        ? (() => {
            const fetchedTurns = reviewTurnsByUrl.get(reviewThread.threadUrl);
            const realSpans =
              fetchedTurns !== undefined && fetchedTurns.length > 0
                ? fetchedTurns.map((turn) => ({
                    id: `turn_${String(turn.ordinal)}`,
                    text: turn.text.length > 600 ? `${turn.text.slice(0, 600)}…` : turn.text,
                    capturedAt: turn.capturedAt,
                  }))
                : [
                    {
                      id: `${reviewThread.bac_id}_overall`,
                      text: reviewThread.title,
                      capturedAt: reviewThread.lastSeenAt,
                    },
                  ];
            const spanContext = new Map(
              fetchedTurns !== undefined && fetchedTurns.length > 0
                ? fetchedTurns.map(
                    (turn) =>
                      [
                        `turn_${String(turn.ordinal)}`,
                        { text: turn.text, ordinal: turn.ordinal, capturedAt: turn.capturedAt },
                      ] as const,
                  )
                : [
                    [
                      `${reviewThread.bac_id}_overall`,
                      { text: reviewThread.title, ordinal: 0, capturedAt: reviewThread.lastSeenAt },
                    ] as const,
                  ],
            );
            return (
              <div
                className="modal-backdrop"
                onClick={() => {
                  setReviewThreadId(null);
                }}
              >
                <div
                  className="review-modal-shell"
                  onClick={(e) => {
                    e.stopPropagation();
                  }}
                >
                  <ReviewComposer
                    provider={providerLabel(reviewThread.provider)}
                    capturedAt={formatRelative(reviewThread.lastSeenAt)}
                    spans={realSpans}
                    onClose={() => {
                      setReviewThreadId(null);
                    }}
                    onSave={(payload) => {
                      if (reviewInFlight) {
                        return;
                      }
                      void submitReview(reviewThread, payload, 'save', spanContext).then((ok) => {
                        if (ok) {
                          setReviewThreadId(null);
                        }
                      });
                    }}
                    onSubmitBack={() => {
                      if (reviewInFlight) {
                        return;
                      }
                      void submitReview(
                        reviewThread,
                        {
                          verdict: 'partial',
                          reviewerNote: `Submit-back from Sidetrack — ${reviewThread.title}`,
                          perSpan: {},
                        },
                        'submit_back',
                        spanContext,
                      ).then((ok) => {
                        if (ok) {
                          setReviewThreadId(null);
                        }
                      });
                    }}
                    onDispatchOut={() => {
                      const dispatchPacket: ComposedPacket = {
                        kind: 'context_pack',
                        template: null,
                        target: 'claude',
                        title: `Review: ${reviewThread.title}`,
                        body: `# Review notes\n\n## Source thread\n${providerLabel(reviewThread.provider)} · ${reviewThread.threadUrl}\n\n## Notes\n…`,
                        scopeLabel: reviewThread.title,
                        sourceThreadId: reviewThread.bac_id,
                        ...(reviewThread.primaryWorkstreamId !== undefined
                          ? { workstreamId: reviewThread.primaryWorkstreamId }
                          : {}),
                        tokenEstimate: 0,
                        redactedItems: [],
                      };
                      setReviewThreadId(null);
                      setPendingDispatch(dispatchPacket);
                    }}
                  />
                </div>
              </div>
            );
          })()
        : null}

      {recoveryThread ? (
        <TabRecovery
          onClose={() => {
            setRecoveryThreadId(null);
          }}
          onFocusOpen={() => {
            restoreThread(recoveryThread.bac_id);
            setRecoveryThreadId(null);
          }}
          onReopenUrl={() => {
            restoreThread(recoveryThread.bac_id);
            setRecoveryThreadId(null);
          }}
          snapshot={{
            title: recoveryThread.title,
            url: recoveryThread.threadUrl,
            provider: providerLabel(recoveryThread.provider),
            favIconUrl: recoveryThread.tabSnapshot?.favIconUrl,
            capturedAt: recoveryThread.tabSnapshot?.capturedAt ?? recoveryThread.lastSeenAt,
            lastActiveAt: formatRelative(recoveryThread.lastSeenAt),
            restoreStrategy: restoreStrategyForThread(recoveryThread),
          }}
        />
      ) : null}

      {showWizard ? (
        <Wizard
          bridgeKey={bridgeKey}
          companionReachable={state.companionStatus === 'connected'}
          onClose={() => {
            if (!firstLaunch) {
              setWizardOpen(false);
            }
          }}
          onFinish={() => {
            void completeSetup(true).catch((setupError: unknown) => {
              setError(
                setupError instanceof Error ? setupError.message : 'Could not finish setup.',
              );
            });
          }}
          onBridgeKeyChange={setBridgeKey}
          onSkip={() => {
            void completeSetup(false).catch((setupError: unknown) => {
              setError(
                setupError instanceof Error ? setupError.message : 'Could not finish setup.',
              );
            });
          }}
          onVaultPathChange={setVaultPath}
          port={Number.isFinite(Number(port)) && Number(port) > 0 ? Number(port) : 17_373}
          vaultPath={vaultPath}
        />
      ) : null}

      {codingAttachOpen ? (
        <CodingAttach
          {...(selectedWorkstream !== '' ? { defaultWorkstreamId: selectedWorkstream } : {})}
          workstreams={workstreamOptions}
          onCancel={() => {
            setCodingAttachOpen(false);
          }}
          onAttach={(input) => {
            void writeCodingSession({ ...input, attachedAt: new Date().toISOString() });
            void navigator.clipboard.writeText(input.resumeCommand).catch(() => {
              // Clipboard rejected (permissions, focus); resume command is still saved locally.
            });
            setCodingAttachOpen(false);
          }}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsPanel
          settings={
            settings === null
              ? null
              : {
                  autoSendOptIn: settings.autoSendOptIn,
                  defaultPacketKind: settings.defaultPacketKind,
                  defaultDispatchTarget: settings.defaultDispatchTarget,
                  screenShareSafeMode: settings.screenShareSafeMode,
                  revision: settings.revision,
                }
          }
          busy={settingsBusy}
          error={settingsError}
          onClose={() => {
            setSettingsOpen(false);
            setSettingsError(null);
          }}
          onSave={handleSettingsSave}
        />
      ) : null}
    </main>
  );
};

export default App;

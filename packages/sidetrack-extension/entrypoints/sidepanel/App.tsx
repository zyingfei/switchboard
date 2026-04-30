import { useEffect, useMemo, useState } from 'react';

import {
  companionStatusLabel,
  createEmptyWorkboardState,
  type CodingSession,
  type TrackedThread,
  type WorkboardState,
  type WorkstreamNode,
} from '../../src/workboard';
import {
  isCaptureFeedbackMessage,
  isRuntimeResponse,
  isWorkboardChangedMessage,
  messageTypes,
  type RuntimeResponse,
  type WorkboardRequest,
} from '../../src/messages';
import {
  CodingAttach,
  type ComposedPacket,
  DispatchConfirm,
  MoveToPicker,
  PacketComposer,
  ReviewComposer,
  SettingsPanel,
  type SettingsValue,
  SystemBannersStack,
  TabRecovery,
  Wizard,
  type RestoreStrategy,
  type ReviewVerdict,
  type WorkstreamOption,
} from './components';
import { createDispatchClient } from '../../src/dispatch/client';
import {
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
import { deriveLifecycle } from '../../src/sidepanel/lifecycle';
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

const sendRequestRaw = async (
  request: WorkboardRequest,
): Promise<Extract<RuntimeResponse, { ok: true }>> => {
  const response = (await chrome.runtime.sendMessage(request)) as unknown;
  if (!isRuntimeResponse(response)) {
    throw new Error('Sidetrack background returned an invalid response.');
  }
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response;
};

const sendRequest = async (request: WorkboardRequest): Promise<WorkboardState> =>
  (await sendRequestRaw(request)).state;

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

const SETUP_COMPLETED_KEY = 'sidetrack:setupCompleted';

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
  threads.filter(
    (thread) =>
      thread.status !== 'removed' &&
      thread.status !== 'archived' &&
      thread.trackingMode !== 'removed' &&
      thread.trackingMode !== 'archived',
  );

// Lifecycle derivation lives in src/sidepanel/lifecycle.ts so it can
// be unit-tested without rendering the full App tree.

const restoreStrategyForThread = (thread: TrackedThread): RestoreStrategy =>
  thread.tabSnapshot?.tabId === undefined ? 'reopen_url' : 'focus_open';

const App = () => {
  const [state, setState] = useState<WorkboardState>(() => createEmptyWorkboardState());
  const [bridgeKey, setBridgeKey] = useState('');
  const [port, setPort] = useState('17373');
  const [selectedWorkstream, setSelectedWorkstream] = useState('');
  const [moveThreadId, setMoveThreadId] = useState<string | null>(null);
  const [recoveryThreadId, setRecoveryThreadId] = useState<string | null>(null);
  const [expandedWorkstreamId, setExpandedWorkstreamId] = useState<string | null>(null);
  const [wsPickerOpen, setWsPickerOpen] = useState(false);
  const [wsPickerCreateMode, setWsPickerCreateMode] = useState(false);
  const [viewMode, setViewMode] = useState<'workstream' | 'all'>('workstream');
  const [queueComposeFor, setQueueComposeFor] = useState<string | null>(null);
  const [queueDraft, setQueueDraft] = useState('');
  const [queueExpandFor, setQueueExpandFor] = useState<string | null>(null);
  const [queueCopiedId, setQueueCopiedId] = useState<string | null>(null);
  const [noteComposeOpen, setNoteComposeOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteEditId, setNoteEditId] = useState<string | null>(null);
  // Per-thread inline note compose. Holds the thread bac_id whose
  // history strip is currently in compose mode; null = none open.
  // Separate from noteComposeOpen so the workstream-level rail and
  // the per-thread strip don't fight each other for state.
  const [threadNoteFor, setThreadNoteFor] = useState<string | null>(null);
  const [threadNoteDraft, setThreadNoteDraft] = useState('');
  const [threadHistoryOpen, setThreadHistoryOpen] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [composeThreadId, setComposeThreadId] = useState<string | null>(null);
  const [pendingDispatch, setPendingDispatch] = useState<ComposedPacket | null>(null);
  const [dispatchInFlight, setDispatchInFlight] = useState(false);
  const [reviewThreadId, setReviewThreadId] = useState<string | null>(null);
  const [reviewInFlight, setReviewInFlight] = useState(false);
  const [reviewTurnsByUrl, setReviewTurnsByUrl] = useState<
    ReadonlyMap<string, readonly CapturedTurnRecord[]>
  >(() => new Map<string, readonly CapturedTurnRecord[]>());
  const [settings, setSettings] = useState<SettingsDocument | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [codingAttachOpen, setCodingAttachOpen] = useState(false);
  const [setupCompleted, setSetupCompleted] = useState<boolean | null>(null);
  const [stateLoaded, setStateLoaded] = useState(false);
  const [vaultPath, setVaultPath] = useState(DEFAULT_VAULT_PATH);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [captureToastHost, setCaptureToastHost] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const threads = useMemo(() => visibleThreads(state.threads), [state.threads]);
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

  const refresh = async () => {
    const next = await sendRequest({ type: messageTypes.getWorkboardState });
    setState(next);
    setBridgeKey(next.settings.companion.bridgeKey);
    setPort(String(next.settings.companion.port));
    setError(next.lastError ?? null);
    if (next.vaultPath !== undefined) {
      setVaultPath(next.vaultPath);
    }
    // Default to "not set" (Inbox) on first load — user picks via the ws-bar.
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

  // Spec: if the current tab is tracked and lives in a workstream, focus
  // that workstream. If the current tab isn't tracked, leave the picker on
  // whatever the user last had selected — the panel doesn't follow random
  // tab switches into "not set".
  useEffect(() => {
    const currentWsForTab = state.currentTab?.primaryWorkstreamId;
    if (currentWsForTab === undefined) {
      return;
    }
    if (selectedWorkstream === currentWsForTab) {
      return;
    }
    setSelectedWorkstream(currentWsForTab);
    setExpandedWorkstreamId(null);
  }, [state.currentTab?.bac_id, state.currentTab?.primaryWorkstreamId, selectedWorkstream]);

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
  }, [
    bridgeKey,
    port,
    stateLoaded,
    state.settings.companion.bridgeKey,
    state.settings.companion.port,
  ]);

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

  // Mirror of the review-turns fetch for the packet composer. Loads the
  // most-recent N turns (both roles) so the composer can offer a
  // "Include last N turns" picker with live token preview.
  const [composeTurnsByUrl, setComposeTurnsByUrl] = useState<
    ReadonlyMap<string, readonly CapturedTurnRecord[]>
  >(() => new Map<string, readonly CapturedTurnRecord[]>());
  useEffect(() => {
    if (
      composeThread === undefined ||
      bridgeKey.length === 0 ||
      composeTurnsByUrl.has(composeThread.threadUrl)
    ) {
      return undefined;
    }
    const portNumber = Number(port);
    if (!Number.isFinite(portNumber) || portNumber <= 0) {
      return undefined;
    }
    let cancelled = false;
    const client = createTurnsClient({ port: portNumber, bridgeKey });
    const targetUrl = composeThread.threadUrl;
    void client
      .recentForThread(targetUrl, { limit: 12 })
      .then((list) => {
        if (!cancelled) {
          setComposeTurnsByUrl((prev) => new Map(prev).set(targetUrl, list));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setComposeTurnsByUrl((prev) => new Map(prev).set(targetUrl, []));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [composeThread, bridgeKey, port, composeTurnsByUrl]);

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

  // Switch to the thread's existing tab if still alive, otherwise open a new
  // one at the same URL.
  // (1) Try chrome.tabs.update(tabId) using the captured tabId.
  // (2) If that fails (tab was closed and re-opened, so tabId is stale),
  //     query all tabs matching threadUrl and focus the first one.
  // (3) Otherwise create a new tab at threadUrl.
  const openTabForThread = (thread: TrackedThread) => {
    const tabId = thread.tabSnapshot?.tabId;
    const focusByQuery = async () => {
      try {
        const tabs = await chrome.tabs.query({ url: thread.threadUrl });
        const live = tabs.find((t) => typeof t.id === 'number');
        if (live !== undefined && typeof live.id === 'number') {
          await chrome.tabs.update(live.id, { active: true });
          await chrome.windows.update(live.windowId, { focused: true });
          return true;
        }
      } catch {
        // chrome.tabs.query may fail without host_permissions on the URL —
        // fall through to create.
      }
      return false;
    };
    void (async () => {
      if (typeof tabId === 'number') {
        try {
          const tab = await chrome.tabs.update(tabId, { active: true });
          if (tab?.windowId !== undefined) {
            await chrome.windows.update(tab.windowId, { focused: true });
          }
          return;
        } catch {
          // tabId is stale — fall through.
        }
      }
      const focused = await focusByQuery();
      if (focused) {
        return;
      }
      await chrome.tabs.create({ url: thread.threadUrl });
    })();
  };

  const submitQueueFollowUp = (threadId: string) => {
    const text = queueDraft.trim();
    if (text.length === 0) {
      return;
    }
    void runAction(async () => {
      const next = await sendRequest({
        type: messageTypes.queueFollowUp,
        item: { text, scope: 'thread', targetId: threadId },
      });
      setQueueDraft('');
      setQueueComposeFor(null);
      setQueueExpandFor(threadId);
      return next;
    });
  };

  const dismissQueueItem = (queueItemId: string) => {
    void runAction(() =>
      sendRequest({
        type: messageTypes.updateQueueItem,
        queueItemId,
        update: { status: 'dismissed' },
      }),
    );
  };

  const submitNote = () => {
    const text = noteDraft.trim();
    if (text.length === 0) {
      return;
    }
    if (noteEditId !== null) {
      const editId = noteEditId;
      void runAction(async () => {
        const next = await sendRequest({
          type: messageTypes.updateCaptureNote,
          noteId: editId,
          update: { text },
        });
        setNoteDraft('');
        setNoteEditId(null);
        setNoteComposeOpen(false);
        return next;
      });
      return;
    }
    void runAction(async () => {
      const next = await sendRequest({
        type: messageTypes.createCaptureNote,
        note: {
          text,
          kind: 'manual',
          ...(currentWsId === null ? {} : { workstreamId: currentWsId }),
        },
      });
      setNoteDraft('');
      setNoteComposeOpen(false);
      return next;
    });
  };

  const deleteNote = (noteId: string) => {
    void runAction(() => sendRequest({ type: messageTypes.deleteCaptureNote, noteId }));
  };

  const beginEditNote = (noteId: string, text: string) => {
    setNoteComposeOpen(true);
    setNoteEditId(noteId);
    setNoteDraft(text);
  };

  const submitThreadNote = (threadId: string) => {
    const text = threadNoteDraft.trim();
    if (text.length === 0) {
      return;
    }
    const targetThread = state.threads.find((t) => t.bac_id === threadId);
    void runAction(async () => {
      const next = await sendRequest({
        type: messageTypes.createCaptureNote,
        note: {
          text,
          kind: 'manual',
          threadId,
          ...(targetThread?.primaryWorkstreamId === undefined
            ? {}
            : { workstreamId: targetThread.primaryWorkstreamId }),
        },
      });
      setThreadNoteDraft('');
      setThreadNoteFor(null);
      // Make sure the strip stays expanded after add so the user sees
      // the new entry land.
      setThreadHistoryOpen((prev) => {
        if (prev.has(threadId)) {
          return prev;
        }
        const nextSet = new Set(prev);
        nextSet.add(threadId);
        return nextSet;
      });
      return next;
    });
  };

  const toggleThreadHistory = (threadId: string) => {
    setThreadHistoryOpen((prev) => {
      const nextSet = new Set(prev);
      if (nextSet.has(threadId)) {
        nextSet.delete(threadId);
      } else {
        nextSet.add(threadId);
      }
      return nextSet;
    });
  };

  const copyQueueItemText = (queueItemId: string, text: string) => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
        setQueueCopiedId(queueItemId);
        setTimeout(() => {
          setQueueCopiedId((current) => (current === queueItemId ? null : current));
        }, 1200);
      } catch {
        // Clipboard API can be unavailable in some contexts; fail quietly.
      }
    })();
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
    void navigator.clipboard.writeText(packet.body).catch(() => {
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
    payload: {
      readonly verdict: ReviewVerdict;
      readonly reviewerNote: string;
      readonly perSpan: Record<string, string>;
    },
    outcome: ReviewOutcome,
    spanContext: ReadonlyMap<
      string,
      { readonly text: string; readonly ordinal: number; readonly capturedAt?: string }
    >,
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

  // Auto-pop the wizard ONLY for true first-launch users (no setupCompleted
  // flag AND no bridge key in storage on first mount). Existing-user
  // migration: a non-empty bridge key from a prior install means they
  // already configured it; don't re-pop. After "Done" or "Skip",
  // setupCompleted=true → never re-pops.
  //
  // We anchor firstLaunch on the initial mount via a sticky flag —
  // otherwise typing into the bridge-key field inside the wizard would
  // flip firstLaunch to false and yank the wizard out from under the
  // user mid-interaction.
  const firstLaunchPending =
    stateLoaded && setupCompleted === false && bridgeKey.trim().length === 0;
  const [firstLaunchAnchored, setFirstLaunchAnchored] = useState(false);
  useEffect(() => {
    if (firstLaunchPending && !firstLaunchAnchored) {
      setFirstLaunchAnchored(true);
    }
  }, [firstLaunchPending, firstLaunchAnchored]);
  const inFirstLaunchMode = firstLaunchAnchored && setupCompleted === false;
  const showWizard = inFirstLaunchMode || wizardOpen;
  const localOnlyMode = state.companionStatus === 'local-only';
  // When local-only is the chosen mode, the companion isn't expected;
  // "disconnected" only applies when a bridge key was set but the companion
  // is unreachable.
  const companionDisconnected =
    !localOnlyMode && (bridgeKey.trim().length === 0 || state.companionStatus === 'disconnected');
  const vaultUnreachable = state.companionStatus === 'vault-error';
  const providerHealth = state.selectorHealth.find((entry) => entry.latestStatus !== 'ok');
  const workstreamOptions = useMemo(
    () => buildWorkstreamOptions(state.workstreams),
    [state.workstreams],
  );
  const hasSystemBanners =
    companionDisconnected ||
    vaultUnreachable ||
    providerHealth !== undefined ||
    state.queuedCaptureCount > 0 ||
    captureToastHost !== null;

  // Current workstream id; null = "not set / Inbox" (special).
  const currentWsId =
    expandedWorkstreamId === null && selectedWorkstream === ''
      ? null
      : (expandedWorkstreamId ?? (selectedWorkstream || null));
  const currentWs =
    currentWsId === null ? null : (state.workstreams.find((w) => w.bac_id === currentWsId) ?? null);
  const currentWsLabel =
    currentWs === null ? 'not set' : workstreamPath(currentWs.bac_id, state.workstreams);
  const currentWsThreads =
    currentWsId === null
      ? threads.filter((t) => t.primaryWorkstreamId === undefined)
      : threads.filter((t) => t.primaryWorkstreamId === currentWsId);
  const activeCount = currentWsThreads.filter(
    (t) => t.status !== 'closed' && t.status !== 'archived' && t.status !== 'removed',
  ).length;
  const staleCount = currentWsThreads.filter(
    (t) => t.status === 'closed' || t.status === 'restorable' || t.status === 'needs_organize',
  ).length;
  const setCurrentWs = (id: string | null) => {
    setExpandedWorkstreamId(id);
    setSelectedWorkstream(id ?? '');
  };

  // Open vs closed/stale buckets across ALL workstreams (used by All view)
  const openStatuses: TrackedThread['status'][] = ['active', 'tracked', 'queued', 'needs_organize'];
  const allOpenThreads = threads.filter(
    (t) => openStatuses.includes(t.status) && t.trackingMode !== 'stopped',
  );
  const allClosedThreads = threads
    .filter((t) => !openStatuses.includes(t.status) || t.trackingMode === 'stopped')
    .slice()
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));

  // Captures: manual notes filtered by the current workstream (or Inbox)
  // plus inbound reminders whose linked thread sits in scope. Notes that
  // are anchored to a specific thread render under that thread's history
  // strip instead — exclude them here so they don't double-render.
  const scopedNotes = (
    viewMode === 'all'
      ? state.captureNotes
      : state.captureNotes.filter((note) =>
          currentWsId === null
            ? note.workstreamId === undefined
            : note.workstreamId === currentWsId,
        )
  ).filter((note) => note.threadId === undefined);
  // Coding sessions (registered via the agent's MCP register tool) render
  // alongside chat threads in the same workstream group.
  const attachedSessions = state.codingSessions.filter((s) => s.status === 'attached');
  const currentWsCodingSessions =
    currentWsId === null
      ? attachedSessions.filter((s) => s.workstreamId === undefined)
      : attachedSessions.filter((s) => s.workstreamId === currentWsId);
  const codingSessionsByWs = (() => {
    const groups = new Map<string | null, CodingSession[]>();
    groups.set(null, []);
    for (const ws of state.workstreams) {
      groups.set(ws.bac_id, []);
    }
    for (const session of attachedSessions) {
      const key = session.workstreamId ?? null;
      const list = groups.get(key);
      if (list === undefined) {
        groups.set(key, [session]);
      } else {
        list.push(session);
      }
    }
    return groups;
  })();

  // Group open threads by primary workstream id (null = inbox/not-set)
  const openGroups = (() => {
    const groups = new Map<string | null, TrackedThread[]>();
    groups.set(null, []);
    for (const ws of state.workstreams) {
      groups.set(ws.bac_id, []);
    }
    for (const t of allOpenThreads) {
      const key = t.primaryWorkstreamId ?? null;
      const list = groups.get(key);
      if (list === undefined) {
        groups.set(key, [t]);
      } else {
        list.push(t);
      }
    }
    // Show a group if it has any threads OR coding sessions, plus always
    // surface the inbox so the user can see what hasn't been organized.
    return Array.from(groups.entries()).filter(([key, list]) => {
      if (key === null) return true;
      if (list.length > 0) return true;
      const sessions = codingSessionsByWs.get(key);
      return sessions !== undefined && sessions.length > 0;
    });
  })();

  // Inline thread-row renderer reused across views.
  const renderThreadRow = (thread: TrackedThread) => {
    const isPrivate = isThreadPrivate(thread, state.workstreams);
    const lifecycle = deriveLifecycle(thread, state.reminders);
    const { dotClass, stampLabel, lifecyclePill } = lifecycle;
    const stamp =
      thread.status === 'restorable'
        ? `Tab closed · ${formatRelative(thread.lastSeenAt)}`
        : thread.trackingMode === 'stopped'
          ? `Tracking stopped · ${formatRelative(thread.lastSeenAt)}`
          : `${stampLabel} · ${formatRelative(thread.lastSeenAt)}`;
    const titleDisplay = isPrivate ? '[private]' : thread.title;
    const pendingQueueItems = state.queueItems.filter(
      (q) => q.targetId === thread.bac_id && q.status === 'pending',
    );
    const queuedCount = pendingQueueItems.length;
    const queueExpanded = queueExpandFor === thread.bac_id && queuedCount > 0;
    const childForks = state.threads.filter((t) => t.parentThreadId === thread.bac_id);
    const parent =
      thread.parentThreadId === undefined
        ? undefined
        : state.threads.find((t) => t.bac_id === thread.parentThreadId);
    // Thread-anchored notes form the inline history under the row,
    // sorted newest-first to match the workstream rail.
    const threadNotes = state.captureNotes
      .filter((note) => note.threadId === thread.bac_id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const historyOpen = threadHistoryOpen.has(thread.bac_id);
    const historyComposeOpen = threadNoteFor === thread.bac_id;
    return (
      <div key={thread.bac_id} className="thread">
        <div className="row1">
          <span className={'provider ' + thread.provider}>{providerLabel(thread.provider)}</span>
          <button
            type="button"
            className="thread-name-btn"
            title={isPrivate ? 'Open thread tab' : `Open: ${thread.title}`}
            onClick={(e) => {
              e.stopPropagation();
              openTabForThread(thread);
            }}
          >
            <span className="name">{titleDisplay}</span>
          </button>
          {queuedCount > 0 ? (
            <button
              type="button"
              className={'thread-queued mono' + (queueExpanded ? ' on' : '')}
              title={`Show ${String(queuedCount)} queued follow-up${queuedCount === 1 ? '' : 's'} — copy or dismiss before replying`}
              aria-expanded={queueExpanded}
              onClick={(e) => {
                e.stopPropagation();
                setQueueExpandFor(queueExpanded ? null : thread.bac_id);
              }}
            >
              {String(queuedCount)} queued
            </button>
          ) : null}
        </div>
        <div className="row2">
          <span className={'dot ' + dotClass} />
          <span className="stamp">{stamp}</span>
          {lifecyclePill === undefined ? null : (
            <span className={'lifecycle-pill mono ' + lifecyclePill.tone}>
              {lifecyclePill.label}
            </span>
          )}
        </div>
        {parent !== undefined || thread.parentTitle !== undefined ? (
          <div className="row2 thread-lineage" title="Branched from a tracked thread">
            <span className="lineage-arrow">↰</span>
            <span className="lineage-from mono">from</span>
            {parent === undefined ? (
              <span className="lineage-name">{thread.parentTitle ?? 'untracked thread'}</span>
            ) : (
              <button
                type="button"
                className="btn-link lineage-name"
                title={`Switch to parent thread: ${parent.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  openTabForThread(parent);
                }}
              >
                {parent.title}
              </button>
            )}
          </div>
        ) : null}
        {childForks.length > 0 ? (
          <div
            className="row2 thread-lineage"
            title={`This thread has ${String(childForks.length)} fork${
              childForks.length === 1 ? '' : 's'
            }`}
          >
            <span className="lineage-arrow">↳</span>
            <span className="lineage-from mono">
              {String(childForks.length)} fork{childForks.length === 1 ? '' : 's'}
            </span>
          </div>
        ) : null}
        <div className="thread-actions row2">
          <button
            type="button"
            className="btn-link"
            title="Open the thread's tab (or reopen if closed)"
            onClick={(e) => {
              e.stopPropagation();
              openTabForThread(thread);
            }}
          >
            Open
          </button>
          <button
            type="button"
            className="btn-link"
            title="Queue a follow-up question that fires when this AI replies"
            onClick={(e) => {
              e.stopPropagation();
              setQueueComposeFor(queueComposeFor === thread.bac_id ? null : thread.bac_id);
              setQueueDraft('');
            }}
          >
            Queue
          </button>
          {(() => {
            const requiresCompanion = state.companionStatus !== 'connected' || bridgeKey.length === 0;
            // Don't use the `disabled` attribute when companion is missing —
            // a click should explain how to enable, not be silently swallowed.
            // The `.disabled-look` class mutes the colour while the button
            // remains a real, clickable target.
            const explainNeedsCompanion = (action: 'Send' | 'Review') => {
              setError(
                `${action} needs a connected companion to read this thread's turns from the vault. Open Settings (cog, top right) → enter the bridge port and key → Save, then try again.`,
              );
            };
            return (
              <>
                <button
                  type="button"
                  className={'btn-link' + (requiresCompanion ? ' disabled-look' : '')}
                  title={
                    requiresCompanion
                      ? 'Send is unavailable in local-only mode — click for setup steps'
                      : 'Compose a packet from this thread and dispatch to another AI'
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    if (requiresCompanion) {
                      explainNeedsCompanion('Send');
                      return;
                    }
                    setComposeThreadId(thread.bac_id);
                  }}
                >
                  Send
                </button>
                <button
                  type="button"
                  className={'btn-link' + (requiresCompanion ? ' disabled-look' : '')}
                  title={
                    requiresCompanion
                      ? 'Review is unavailable in local-only mode — click for setup steps'
                      : 'Review captured turns of this thread'
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    if (requiresCompanion) {
                      explainNeedsCompanion('Review');
                      return;
                    }
                    setReviewThreadId(thread.bac_id);
                  }}
                >
                  Review
                </button>
              </>
            );
          })()}
          <button
            type="button"
            className="btn-link"
            title="Move this thread into another workstream"
            onClick={(e) => {
              e.stopPropagation();
              setMoveThreadId(thread.bac_id);
            }}
          >
            Move
          </button>
          {thread.trackingMode === 'stopped' ? (
            <button
              type="button"
              className="btn-link"
              title="Resume tracking this thread"
              onClick={(e) => {
                e.stopPropagation();
                updateTracking(thread.bac_id, thread.provider === 'unknown' ? 'manual' : 'auto');
              }}
            >
              Resume
            </button>
          ) : (
            <button
              type="button"
              className="btn-link"
              title="Stop tracking — keep the thread but don't capture new turns"
              onClick={(e) => {
                e.stopPropagation();
                updateTracking(thread.bac_id, 'stopped');
              }}
            >
              Stop
            </button>
          )}
          <button
            type="button"
            className="btn-link archive"
            title="Archive — hide from default views; restorable from Settings"
            onClick={(e) => {
              e.stopPropagation();
              updateTracking(thread.bac_id, 'archived');
            }}
          >
            Archive
          </button>
          {queuedCount > 0 ? (
            <button
              type="button"
              className={'thread-autosend' + (thread.autoSendEnabled ? ' on' : '')}
              aria-pressed={thread.autoSendEnabled === true}
              title={
                thread.autoSendEnabled
                  ? 'Auto-send on — queued items ship into this chat one at a time, waiting for each reply.'
                  : 'Auto-send off — turn on to drain queued follow-ups into this chat (per-provider opt-in lives in Settings).'
              }
              onClick={(e) => {
                e.stopPropagation();
                void runAction(() =>
                  sendRequest({
                    type: messageTypes.setThreadAutoSend,
                    threadId: thread.bac_id,
                    enabled: !thread.autoSendEnabled,
                  }),
                );
              }}
            >
              <span className="thread-autosend-dot" aria-hidden />
              <span className="thread-autosend-label">auto-send</span>
              <span className="thread-autosend-state">{thread.autoSendEnabled ? 'on' : 'off'}</span>
            </button>
          ) : null}
        </div>
        {queueComposeFor === thread.bac_id ? (
          <form
            className="thread-queue-compose"
            onSubmit={(e) => {
              e.preventDefault();
              submitQueueFollowUp(thread.bac_id);
            }}
          >
            <input
              type="text"
              autoFocus
              className="mono"
              placeholder="Ask next… (fires after this thread replies)"
              value={queueDraft}
              onChange={(e) => {
                setQueueDraft(e.target.value);
              }}
            />
            <button
              type="submit"
              className="btn-link"
              disabled={busy || queueDraft.trim().length === 0}
            >
              Add
            </button>
            <button
              type="button"
              className="btn-link"
              onClick={() => {
                setQueueComposeFor(null);
                setQueueDraft('');
              }}
            >
              Cancel
            </button>
          </form>
        ) : null}
        {queueExpanded ? (
          <ul className="thread-queue-list" aria-label="Queued follow-ups">
            {pendingQueueItems.map((item) => (
              <li key={item.bac_id} className="thread-queue-item">
                <span className="thread-queue-text">{item.text}</span>
                <span className="thread-queue-actions">
                  <button
                    type="button"
                    className="btn-link"
                    title="Copy this question to the clipboard"
                    onClick={(e) => {
                      e.stopPropagation();
                      copyQueueItemText(item.bac_id, item.text);
                    }}
                  >
                    {queueCopiedId === item.bac_id ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    type="button"
                    className="btn-link"
                    title="Dismiss this queued follow-up"
                    onClick={(e) => {
                      e.stopPropagation();
                      dismissQueueItem(item.bac_id);
                    }}
                  >
                    Dismiss
                  </button>
                </span>
                {item.lastError !== undefined ? (
                  <span className="thread-queue-error" role="status">
                    auto-send paused — {item.lastError}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="thread-history">
          {historyOpen ? (
            <>
              {threadNotes.length === 0 ? (
                <span className="thread-history-empty">
                  no notes yet — capture context as the thread evolves
                </span>
              ) : (
                threadNotes.map((note) => (
                  <div key={note.bac_id} className="thread-history-item">
                    <span className="glyph" aria-hidden>
                      ▍
                    </span>
                    <div className="body">{note.text}</div>
                    <span className="meta">{formatRelative(note.createdAt)}</span>
                    <div className="actions">
                      <button
                        type="button"
                        className="btn-link"
                        title="Edit this note"
                        onClick={(e) => {
                          e.stopPropagation();
                          beginEditNote(note.bac_id, note.text);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn-link"
                        title="Delete this note"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteNote(note.bac_id);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))
              )}
              {historyComposeOpen ? (
                <form
                  className="thread-history-compose"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitThreadNote(thread.bac_id);
                  }}
                >
                  <textarea
                    autoFocus
                    rows={2}
                    placeholder="Note for this thread…"
                    value={threadNoteDraft}
                    onChange={(e) => {
                      setThreadNoteDraft(e.target.value);
                    }}
                  />
                  <div className="thread-history-compose-actions">
                    <button
                      type="submit"
                      className="btn-link"
                      disabled={busy || threadNoteDraft.trim().length === 0}
                    >
                      Save note
                    </button>
                    <button
                      type="button"
                      className="btn-link"
                      onClick={(e) => {
                        e.stopPropagation();
                        setThreadNoteFor(null);
                        setThreadNoteDraft('');
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  className="thread-history-add"
                  title="Attach a note to this thread"
                  onClick={(e) => {
                    e.stopPropagation();
                    setThreadNoteFor(thread.bac_id);
                    setThreadNoteDraft('');
                  }}
                >
                  + note
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              className="thread-history-add"
              title={
                threadNotes.length > 0
                  ? `Show ${String(threadNotes.length)} thread note${threadNotes.length === 1 ? '' : 's'}`
                  : 'Attach a note to this thread'
              }
              onClick={(e) => {
                e.stopPropagation();
                toggleThreadHistory(thread.bac_id);
                if (threadNotes.length === 0) {
                  setThreadNoteFor(thread.bac_id);
                  setThreadNoteDraft('');
                }
              }}
            >
              {threadNotes.length > 0
                ? `▾ history · ${String(threadNotes.length)} note${threadNotes.length === 1 ? '' : 's'}`
                : '+ note'}
            </button>
          )}
        </div>
      </div>
    );
  };

  const detachCodingSession = (codingSessionId: string) => {
    void runAction(() => sendRequest({ type: messageTypes.detachCodingSession, codingSessionId }));
  };

  // Inline coding-session row, rendered next to chat threads inside the
  // same workstream group.
  const renderCodingSessionRow = (session: CodingSession) => (
    <div key={session.bac_id} className="thread coding-session-row">
      <div className="row1">
        <span className="provider coding" aria-hidden>
          {'>_'}
        </span>
        <span className="name">{session.name}</span>
      </div>
      <div className="row2">
        <span className="dot green" />
        <span className="stamp mono">
          {session.tool} · {session.branch} · last seen {formatRelative(session.lastSeenAt)}
        </span>
      </div>
      <div className="thread-actions row2">
        {session.resumeCommand === undefined ? null : (
          <button
            type="button"
            className="btn-link"
            title="Copy resume command to clipboard"
            onClick={(e) => {
              e.stopPropagation();
              const cmd = session.resumeCommand ?? '';
              void navigator.clipboard.writeText(cmd).catch(() => {
                // Clipboard refused — best-effort.
              });
            }}
          >
            Copy resume
          </button>
        )}
        <button
          type="button"
          className="btn-link archive"
          title="Detach this coding session"
          onClick={(e) => {
            e.stopPropagation();
            detachCodingSession(session.bac_id);
          }}
        >
          Detach
        </button>
      </div>
    </div>
  );

  return (
    <main className="bac-app" aria-label="Sidetrack workboard">
      <div className="app-head">
        <div className="app-mark">
          <span className="glyph" aria-hidden />
          Sidetrack
        </div>
        <div className="view-tabs" role="tablist" aria-label="View">
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'workstream'}
            className={'view-tab' + (viewMode === 'workstream' ? ' on' : '')}
            onClick={() => {
              setViewMode('workstream');
            }}
          >
            Workstream
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'all'}
            className={'view-tab' + (viewMode === 'all' ? ' on' : '')}
            onClick={() => {
              setViewMode('all');
            }}
          >
            All threads
          </button>
        </div>
        <div className="app-actions">
          <button
            className="icon-btn"
            title={
              state.companionStatus === 'connected'
                ? 'Attach coding session'
                : 'Coding-session attach needs a companion — click to configure'
            }
            onClick={() => {
              // Don't gate the icon dead — when companion is missing,
              // route the user to the wizard so they can fix it.
              if (state.companionStatus !== 'connected') {
                setWizardOpen(true);
                return;
              }
              setCodingAttachOpen(true);
            }}
            type="button"
            aria-label="Attach coding session"
          >
            <svg viewBox="0 0 24 24">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <polyline points="6 10 9 13 6 16" />
              <line x1="13" y1="16" x2="18" y2="16" />
            </svg>
          </button>
          <button
            className="icon-btn"
            title="Settings"
            onClick={() => {
              setSettingsOpen(true);
            }}
            type="button"
            aria-label="Settings"
          >
            <svg viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
            </svg>
          </button>
        </div>
      </div>

      {viewMode === 'workstream' ? (
        <WorkstreamBar
          currentWsLabel={currentWsLabel}
          statusLabel={companionStatusLabel(state.companionStatus)}
          onOpenPicker={() => {
            setWsPickerOpen(true);
          }}
          onAddSubWorkstream={() => {
            setWsPickerOpen(true);
            setWsPickerCreateMode(true);
          }}
        />
      ) : (
        <div className="ws-bar all-bar">
          <span className="lbl">All threads</span>
          <span className="ws-status mono">{companionStatusLabel(state.companionStatus)}</span>
        </div>
      )}

      {wsPickerOpen ? (
        <WorkstreamPicker
          workstreams={state.workstreams}
          threads={threads}
          currentWsId={currentWsId}
          createMode={wsPickerCreateMode}
          onClose={() => {
            setWsPickerOpen(false);
            setWsPickerCreateMode(false);
          }}
          onSelect={(id) => {
            setCurrentWs(id);
            setWsPickerOpen(false);
            setWsPickerCreateMode(false);
          }}
          onCreate={(title, parentId) => {
            void runAction(async () => {
              return await sendRequest({
                type: messageTypes.createWorkstream,
                workstream: {
                  title,
                  ...(parentId === null ? {} : { parentId }),
                  privacy: 'private',
                },
              });
            }).then(() => {
              setWsPickerCreateMode(false);
            });
          }}
          /* When opening from "+", default new workstream parent = current */
          parentForNew={currentWsId}
        />
      ) : null}

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

      {viewMode === 'workstream' ? (
        <>
          <div className="sec-head">
            <span>Open threads</span>
            <span className="count mono">
              {String(activeCount)} active
              {staleCount > 0 ? ' · ' + String(staleCount) + ' stale' : ''}
            </span>
          </div>
          <div className="thread-list">
            {currentWsThreads.length === 0 && currentWsCodingSessions.length === 0 ? (
              <div className="thread-empty subtle">
                <p>No threads here yet.</p>
                <button
                  type="button"
                  className="btn-link"
                  disabled={busy}
                  onClick={() => {
                    void runAction(() => sendRequest({ type: messageTypes.captureCurrentTab }));
                  }}
                >
                  Track current tab →
                </button>
              </div>
            ) : null}
            {currentWsCodingSessions.map(renderCodingSessionRow)}
            {currentWsThreads.map(renderThreadRow)}
          </div>
        </>
      ) : (
        <>
          <div className="sec-head">
            <span>Open threads</span>
            <span className="count mono">
              {String(allOpenThreads.length)} active across {String(openGroups.length)} workstream
              {openGroups.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="all-groups">
            {openGroups.map(([wsId, list]) => {
              const ws = wsId === null ? null : state.workstreams.find((w) => w.bac_id === wsId);
              const groupLabel = ws === null ? 'not set · Inbox' : (ws?.title ?? 'unknown');
              const groupSessions = codingSessionsByWs.get(wsId) ?? [];
              const totalRows = list.length + groupSessions.length;
              return (
                <div className="ws-group" key={wsId ?? '__inbox'}>
                  <button
                    type="button"
                    className="ws-group-head"
                    onClick={() => {
                      setCurrentWs(wsId);
                      setViewMode('workstream');
                    }}
                  >
                    <span className="ws-group-label">{groupLabel}</span>
                    <span className="ws-group-count mono">
                      {String(totalRows)} item{totalRows === 1 ? '' : 's'} →
                    </span>
                  </button>
                  {totalRows > 0 ? (
                    <div className="thread-list">
                      {groupSessions.map(renderCodingSessionRow)}
                      {list.map(renderThreadRow)}
                    </div>
                  ) : (
                    <div className="thread-empty subtle group-empty">
                      <p>No open items in this workstream.</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {allClosedThreads.length > 0 ? (
            <>
              <div className="sec-head">
                <span>Closed · stale</span>
                <span className="count mono">
                  {String(allClosedThreads.length)} · ordered by last seen
                </span>
              </div>
              <div className="thread-list">{allClosedThreads.map(renderThreadRow)}</div>
            </>
          ) : null}
        </>
      )}

      <div className="sec-head">
        <span>Captures</span>
        <span className="sec-head-actions">
          <span className="count mono">{String(scopedNotes.length)}</span>
          <button
            type="button"
            className="btn-link sec-head-btn"
            title={
              currentWsId === null ? 'Add a note in the Inbox' : `Add a note in ${currentWsLabel}`
            }
            onClick={() => {
              setNoteEditId(null);
              setNoteDraft('');
              setNoteComposeOpen(true);
            }}
          >
            + note
          </button>
        </span>
      </div>
      {noteComposeOpen ? (
        <form
          className="note-compose"
          onSubmit={(e) => {
            e.preventDefault();
            submitNote();
          }}
        >
          <textarea
            autoFocus
            rows={3}
            placeholder={
              currentWsId === null ? 'Note (lands in the Inbox)…' : `Note for ${currentWsLabel}…`
            }
            value={noteDraft}
            onChange={(e) => {
              setNoteDraft(e.target.value);
            }}
          />
          <div className="note-compose-actions">
            <button
              type="submit"
              className="btn-link"
              disabled={busy || noteDraft.trim().length === 0}
            >
              {noteEditId === null ? 'Save note' : 'Update note'}
            </button>
            <button
              type="button"
              className="btn-link"
              onClick={() => {
                setNoteComposeOpen(false);
                setNoteDraft('');
                setNoteEditId(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      <div className="capture-list">
        {scopedNotes.length === 0 ? (
          <div className="capture-empty subtle">
            <p>
              Notes you save here are scoped to the current workstream. Inbound replies surface as the{' '}
              <strong>Unread reply</strong> badge on the thread row above. Obsidian / external imports
              come later.
            </p>
          </div>
        ) : null}
        {scopedNotes.slice(0, 12).map((note) => (
          <div className="capture capture-note" key={note.bac_id}>
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="8" y1="13" x2="16" y2="13" />
              <line x1="8" y1="17" x2="13" y2="17" />
            </svg>
            <div className="capture-body">
              <div className="text">{note.text}</div>
              <div className="meta mono">
                note · {formatRelative(note.createdAt)}
                {note.kind !== 'manual' ? ` · ${note.kind}` : ''}
              </div>
              <div className="capture-actions">
                <button
                  type="button"
                  className="btn-link"
                  title="Edit this note"
                  onClick={() => {
                    beginEditNote(note.bac_id, note.text);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn-link archive"
                  title="Delete this note"
                  onClick={() => {
                    deleteNote(note.bac_id);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

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
          {...(settings !== null
            ? { defaultKind: dispatchKindToUiPacketKind(settings.defaultPacketKind) }
            : {})}
          scope={{
            label: composeThread.title,
            meta: `${providerLabel(composeThread.provider)} · ${formatRelative(composeThread.lastSeenAt)}`,
            sourceThreadId: composeThread.bac_id,
            threadUrl: composeThread.threadUrl,
            providerLabel: providerLabel(composeThread.provider),
            availableTurns: (composeTurnsByUrl.get(composeThread.threadUrl) ?? []).map((t) => ({
              role: t.role,
              text: t.text,
              capturedAt: t.capturedAt,
            })),
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
            // Lock the wizard open during first-launch (no Skip / Done
            // pressed yet) so users can't accidentally ESC out of setup.
            if (!inFirstLaunchMode) {
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
          companionAvailable={state.companionStatus === 'connected'}
          onCancel={() => {
            setCodingAttachOpen(false);
          }}
          onCreateToken={async (request) => {
            const response = await sendRequestRaw({
              type: messageTypes.createCodingAttachToken,
              request,
            });
            if (response.attachToken === undefined) {
              throw new Error('Companion did not return an attach token.');
            }
            setState(response.state);
            return response.attachToken;
          }}
          onPoll={async () => {
            // The background pulls fresh sessions from the companion in
            // every getWorkboardState response, so polling that is enough.
            // The token itself isn't needed here; tokens are single-use, so
            // any new attached session is the one we just asked for.
            const next = await sendRequest({ type: messageTypes.getWorkboardState });
            setState(next);
            return next.codingSessions.filter((session) => session.status === 'attached');
          }}
          onAttached={() => {
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
          localPreferences={{
            autoTrack: state.settings.autoTrack,
            vaultPath: state.vaultPath ?? '',
          }}
          companionConfigured={bridgeKey.length > 0}
          onSaveLocalPreferences={(next) => {
            void runAction(() =>
              sendRequest({ type: messageTypes.saveLocalPreferences, preferences: next }),
            );
          }}
          archivedThreads={state.threads
            .filter((t) => t.trackingMode === 'archived' && t.status !== 'removed')
            .slice()
            .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
            .map((t) => ({
              bac_id: t.bac_id,
              title: t.title,
              workstreamPath: workstreamPath(t.primaryWorkstreamId, state.workstreams),
              archivedAt: formatRelative(t.lastSeenAt),
              providerLabel: providerLabel(t.provider),
            }))}
          onRestoreThread={(threadId) => {
            const target = state.threads.find((t) => t.bac_id === threadId);
            const knownProvider = target !== undefined && target.provider !== 'unknown';
            const restoredMode: TrackedThread['trackingMode'] =
              state.settings.autoTrack && knownProvider ? 'auto' : 'manual';
            updateTracking(threadId, restoredMode);
          }}
          onDeleteThread={(threadId) => {
            updateTracking(threadId, 'removed');
          }}
          onConnectCompanion={() => {
            // Switch from local-only → companion-backed by re-opening
            // the wizard. Closing Settings first so the wizard isn't
            // stacked behind it.
            setSettingsOpen(false);
            setWizardOpen(true);
          }}
        />
      ) : null}
    </main>
  );
};

export default App;

// =====================================================
// Spec-aligned UI subcomponents (PR 2 / design rewrite)
// =====================================================

interface WorkstreamBarProps {
  readonly currentWsLabel: string;
  readonly statusLabel: string;
  readonly onOpenPicker: () => void;
  readonly onAddSubWorkstream: () => void;
}

function WorkstreamBar({
  currentWsLabel,
  statusLabel,
  onOpenPicker,
  onAddSubWorkstream,
}: WorkstreamBarProps) {
  return (
    <div className="ws-bar">
      <span className="lbl">Workstream</span>
      <button type="button" className="ws-name" onClick={onOpenPicker} aria-haspopup="menu">
        {currentWsLabel}
      </button>
      <button
        type="button"
        className="icon-btn ws-add"
        title="Add sub-workstream"
        aria-label="Add sub-workstream"
        onClick={onAddSubWorkstream}
      >
        <svg viewBox="0 0 24 24">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      <span className="ws-status mono">{statusLabel}</span>
      <span className="swap-arrow" aria-hidden>
        ↓
      </span>
    </div>
  );
}

interface WorkstreamPickerProps {
  readonly workstreams: readonly WorkstreamNode[];
  readonly threads: readonly TrackedThread[];
  readonly currentWsId: string | null;
  readonly createMode: boolean;
  readonly parentForNew: string | null;
  readonly onClose: () => void;
  readonly onSelect: (id: string | null) => void;
  readonly onCreate: (title: string, parentId: string | null) => void;
}

function WorkstreamPicker({
  workstreams,
  threads,
  currentWsId,
  createMode,
  parentForNew,
  onClose,
  onSelect,
  onCreate,
}: WorkstreamPickerProps) {
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(createMode);
  const [draftTitle, setDraftTitle] = useState('');

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) {
      return workstreams;
    }
    return workstreams.filter((w) => w.title.toLowerCase().includes(q));
  }, [query, workstreams]);

  const threadCountFor = (wsId: string): number =>
    threads.filter((t) => t.primaryWorkstreamId === wsId).length;
  const inboxCount = threads.filter((t) => t.primaryWorkstreamId === undefined).length;

  return (
    <div className="ws-picker-backdrop" onClick={onClose} role="presentation">
      <div
        className="ws-picker"
        onClick={(e) => {
          e.stopPropagation();
        }}
        role="menu"
      >
        <input
          type="search"
          className="ws-picker-search mono"
          placeholder="Search workstreams…"
          value={query}
          autoFocus
          onChange={(e) => {
            setQuery(e.target.value);
          }}
        />
        <div className="ws-picker-list">
          <button
            type="button"
            className={'ws-picker-row' + (currentWsId === null ? ' on' : '')}
            onClick={() => {
              onSelect(null);
            }}
          >
            <span className="ws-picker-name">
              not set <em className="subtle">· captures land here</em>
            </span>
            <span className="mono subtle">{inboxCount}</span>
          </button>
          {matches.map((w) => (
            <button
              type="button"
              key={w.bac_id}
              className={'ws-picker-row' + (currentWsId === w.bac_id ? ' on' : '')}
              onClick={() => {
                onSelect(w.bac_id);
              }}
            >
              <span className="ws-picker-name">
                {w.title}
                {w.parentId !== undefined ? <em className="subtle"> · sub</em> : null}
              </span>
              <span className="mono subtle">{threadCountFor(w.bac_id)}</span>
            </button>
          ))}
        </div>
        {creating ? (
          <form
            className="ws-picker-create"
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = draftTitle.trim();
              if (trimmed.length === 0) {
                return;
              }
              onCreate(trimmed, parentForNew);
              setDraftTitle('');
              setCreating(false);
            }}
          >
            <input
              type="text"
              className="ws-picker-create-input"
              placeholder={
                parentForNew === null ? 'New workstream name…' : 'New sub-workstream under current…'
              }
              value={draftTitle}
              autoFocus
              onChange={(e) => {
                setDraftTitle(e.target.value);
              }}
            />
            <button type="submit" className="btn btn-primary">
              Create
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setCreating(false);
                setDraftTitle('');
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="ws-picker-create-trigger"
            onClick={() => {
              setCreating(true);
            }}
          >
            + New workstream{parentForNew !== null ? ' under current' : ''}
          </button>
        )}
      </div>
    </div>
  );
}
